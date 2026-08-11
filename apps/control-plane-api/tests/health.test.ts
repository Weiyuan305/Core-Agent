import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";

import { ErrorEnvelopeSchema } from "@core-agent/contracts";
import {
  createRedactor,
  DomainError,
  EXPECTED_SCHEMA_VERSION,
  loadProviderCatalog,
  type StableDomainErrorCode,
  type RuntimeDatabase,
  type RuntimeEnvironment,
} from "@core-agent/runtime-core";
import type { FastifyBaseLogger } from "fastify";
import { Kysely, PostgresDialect } from "kysely";
import Schema from "typebox/schema";

import { buildControlPlaneApp } from "../src/app.js";
import { mapApiError } from "../src/errors.js";

const require = createRequire(import.meta.url);
const createPinoLogger = require("pino") as (
  options: Readonly<Record<string, unknown>>,
  destination: { write(line: string): void },
) => FastifyBaseLogger;

const bootstrapKey = "synthetic-bootstrap-key-00000001";
const testRoot = join(dirname(new URL(import.meta.url).pathname), ".tmp");
const validImageLock = {
  schemaVersion: 1,
  repository: "managed/runtime",
  tag: "v1",
  platforms: {
    "linux/amd64": { reference: `managed/runtime:v1@sha256:${"a".repeat(64)}` },
    "linux/arm64": { reference: `managed/runtime:v1@sha256:${"b".repeat(64)}` },
  },
};
const providerCatalog = loadProviderCatalog([{
  provider_config_id: "provider_a",
  base_url: "https://provider.example/v1",
  model_ids: ["model_a"],
  credential_secret_ref: "provider_secret_a",
  timeout_ms: 10_000,
  max_safe_retries: 1,
}]);

interface FakeDatabase {
  readonly db: Kysely<RuntimeDatabase>;
  readonly statements: string[];
}

function fakeDatabase(schemaVersion = EXPECTED_SCHEMA_VERSION, failure?: Error): FakeDatabase {
  const statements: string[] = [];
  const client = {
    async query(sql: string) {
      statements.push(sql);
      if (failure !== undefined) throw failure;
      if (/select 1/i.test(sql)) return { rows: [{ ready: 1 }], command: "SELECT", rowCount: 1 };
      if (/max\("version"\)/i.test(sql)) return { rows: [{ version: schemaVersion }], command: "SELECT", rowCount: 1 };
      throw new Error("Unexpected synthetic query");
    },
    release() {},
  };
  const pool = {
    async connect() { return client; },
    async end() {},
    options: {},
  };
  return {
    db: new Kysely<RuntimeDatabase>({ dialect: new PostgresDialect({ pool: pool as never }) }),
    statements,
  };
}

async function createEnvironment(): Promise<{ directory: string; environment: RuntimeEnvironment }> {
  await mkdir(testRoot, { recursive: true, mode: 0o700 });
  await chmod(testRoot, 0o700);
  const directory = await mkdtemp(join(testRoot, "app-"));
  await chmod(directory, 0o700);
  const bootstrapKeyFile = join(directory, "bootstrap-key");
  await writeFile(bootstrapKeyFile, `${bootstrapKey}\n`, { mode: 0o600 });
  await chmod(bootstrapKeyFile, 0o600);
  return {
    directory,
    environment: {
      databaseUrl: "postgresql://synthetic.invalid/runtime",
      databasePasswordFile: join(directory, "database-password"),
      bootstrapKeyFile,
      apiHost: "127.0.0.1",
      apiPort: 8787,
      secretRoot: directory,
      supervisorSocket: join(directory, "supervisor.sock"),
      providerCatalogFile: join(directory, "providers.json"),
      workerId: "worker_a",
    },
  };
}

test.after(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

async function buildTestApp(options: {
  schemaVersion?: number;
  databaseFailure?: Error;
  imageLock?: unknown;
  dependencyDetails?: {
    supervisor: { status: "available" | "unavailable" | "unknown"; summary?: string };
    hermes: { status: "available" | "unavailable" | "unknown"; summary?: string };
  };
  logLines?: string[];
} = {}) {
  const { environment } = await createEnvironment();
  const database = fakeDatabase(options.schemaVersion, options.databaseFailure);
  const logLines = options.logLines ?? [];
  const logger = createPinoLogger({ level: "info" }, { write: (line) => logLines.push(line) });
  const app = await buildControlPlaneApp({
    environment,
    db: database.db,
    providerCatalog,
    imageLock: options.imageLock ?? validImageLock,
    logger,
    redactor: createRedactor([bootstrapKey, "sentinel-internal-secret"]),
    ...(options.dependencyDetails === undefined ? {} : { dependencyDetails: options.dependencyDetails }),
  });
  app.post("/internal/v1/test-auth", {
    config: { tenantScoped: true },
    schema: {
      body: {
        type: "object",
        properties: { ping: { type: "string", maxLength: 16 } },
        required: ["ping"],
        additionalProperties: false,
      },
    },
  }, async (request) => request.apiContext);
  app.post("/internal/v1/test-unscoped", {
    config: { tenantScoped: false },
  }, async (request) => request.apiContext);
  app.get("/internal/v1/test-internal-error", async () => {
    throw new Error("Bearer sentinel-internal-secret dependency body");
  });
  return { app, database, logLines };
}

test("live is dependency-free while ready checks select one and exact schema", async () => {
  const healthy = await buildTestApp();
  const live = await healthy.app.inject({ method: "GET", url: "/health/live" });
  assert.equal(live.statusCode, 200);
  assert.equal(healthy.database.statements.length, 0);
  const ready = await healthy.app.inject({ method: "GET", url: "/health/ready" });
  assert.equal(ready.statusCode, 200);
  assert.equal(healthy.database.statements.some((statement) => /select 1/i.test(statement)), true);
  assert.equal(healthy.database.statements.some((statement) => /schema_migrations/i.test(statement)), true);
  await healthy.app.close();
  await healthy.database.db.destroy();

  const drifted = await buildTestApp({ schemaVersion: 2 });
  const unavailable = await drifted.app.inject({ method: "GET", url: "/health/ready" });
  assert.equal(unavailable.statusCode, 503);
  assert.equal(Schema.Compile(ErrorEnvelopeSchema).Check(unavailable.json()), true);
  assert.equal(unavailable.body.includes("behind"), false);
  await drifted.app.close();
  await drifted.database.db.destroy();
});

test("ready validates managed configuration without blocking on Supervisor or Hermes", async () => {
  const observed = await buildTestApp({
    dependencyDetails: {
      supervisor: { status: "unavailable", summary: "Bearer sentinel-internal-secret" },
      hermes: { status: "unavailable", summary: "api_key=sentinel-internal-secret" },
    },
  });
  const response = await observed.app.inject({ method: "GET", url: "/health/ready" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.includes("sentinel-internal-secret"), false);
  assert.deepEqual(response.json().dependencies.supervisor.status, "unavailable");
  await observed.app.close();
  await observed.database.db.destroy();

  const invalid = await buildTestApp({ imageLock: { ...validImageLock, extra: true } });
  const unavailable = await invalid.app.inject({ method: "GET", url: "/health/ready" });
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.body.includes("extra"), false);
  await invalid.app.close();
  await invalid.database.db.destroy();

  for (const imageLock of [
    { ...validImageLock, repository: "" },
    { ...validImageLock, tag: "" },
    {
      ...validImageLock,
      platforms: {
        ...validImageLock.platforms,
        "linux/amd64": { reference: `other/runtime:v1@sha256:${"a".repeat(64)}` },
      },
    },
  ]) {
    const mismatched = await buildTestApp({ imageLock });
    const mismatchedResponse = await mismatched.app.inject({ method: "GET", url: "/health/ready" });
    assert.equal(mismatchedResponse.statusCode, 503);
    await mismatched.app.close();
    await mismatched.database.db.destroy();
  }
});

test("bootstrap authentication derives server authority and enforces tenant scope", async () => {
  const { app, database } = await buildTestApp();
  const missing = await app.inject({ method: "POST", url: "/internal/v1/test-auth", payload: { ping: "ok" } });
  assert.equal(missing.statusCode, 401);

  const invalid = await app.inject({
    method: "POST",
    url: "/internal/v1/test-auth",
    headers: { authorization: "Bearer wrong-key-of-equal-safe-length", "x-core-agent-tenant-id": "tenant_a" },
    payload: { ping: "ok" },
  });
  assert.equal(invalid.statusCode, 401);
  assert.equal(invalid.body.includes(bootstrapKey), false);

  const duplicateAuthorization = await app.inject({
    method: "POST",
    url: "/internal/v1/test-auth",
    headers: {
      authorization: [`Bearer ${bootstrapKey}`, `Bearer ${bootstrapKey}`] as unknown as string,
      "x-core-agent-tenant-id": "tenant_a",
    },
    payload: { ping: "ok" },
  });
  assert.equal(duplicateAuthorization.statusCode, 401);

  const authorized = await app.inject({
    method: "POST",
    url: "/internal/v1/test-auth",
    headers: {
      authorization: `Bearer ${bootstrapKey}`,
      "x-core-agent-tenant-id": "tenant_a",
      "x-request-id": "request_forged",
      "x-trace-id": "trace_forged",
      "x-core-agent-actor-id": "actor_forged",
      "x-core-agent-membership-id": "membership_forged",
      "x-core-agent-role": "student",
    },
    payload: { ping: "ok" },
  });
  assert.equal(authorized.statusCode, 200);
  assert.deepEqual(authorized.json(), {
    requestId: authorized.json().requestId,
    traceId: authorized.json().traceId,
    tenantId: "tenant_a",
    actorId: "core_agent_provisioner",
    membershipId: "core_agent_provisioner_admin",
    effectiveRole: "admin",
  });
  assert.notEqual(authorized.json().requestId, "request_forged");
  assert.notEqual(authorized.json().traceId, "trace_forged");

  const unscoped = await app.inject({
    method: "POST",
    url: "/internal/v1/test-unscoped",
    headers: { authorization: `Bearer ${bootstrapKey}`, "x-core-agent-tenant-id": "tenant_a" },
  });
  assert.equal(unscoped.statusCode, 400);
  await app.close();
  await database.db.destroy();
});

test("Fastify validation, parser, and body limits map to exact INVALID_REQUEST envelopes", async () => {
  const { app, database } = await buildTestApp();
  const headers = { authorization: `Bearer ${bootstrapKey}`, "x-core-agent-tenant-id": "tenant_a" };
  for (const response of [
    await app.inject({ method: "POST", url: "/internal/v1/test-auth", headers, payload: { ping: "ok", actor_id: "forged" } }),
    await app.inject({ method: "POST", url: "/internal/v1/test-auth", headers: { ...headers, "x-core-agent-tenant-id": "../tenant" }, payload: { ping: "ok" } }),
    await app.inject({ method: "POST", url: "/internal/v1/test-auth", headers, payload: { ping: "x".repeat(70_000) } }),
    await app.inject({
      method: "POST",
      url: "/internal/v1/test-auth",
      headers: { ...headers, "content-type": "application/json" },
      payload: '{"__proto__":{"polluted":true}}',
    }),
  ]) {
    assert.equal(response.statusCode, 400);
    const body = response.json();
    assert.equal(Schema.Compile(ErrorEnvelopeSchema).Check(body), true);
    assert.equal(body.code, "INVALID_REQUEST");
  }
  await app.close();
  await database.db.destroy();
});

test("unknown accessor errors are not invoked and internal logs are redacted", async () => {
  let getterReads = 0;
  const unknown = {};
  Object.defineProperty(unknown, "message", {
    get: () => {
      getterReads += 1;
      return "sentinel-internal-secret";
    },
    enumerable: true,
  });
  const mapped = mapApiError(unknown, {
    requestId: "request_a",
    traceId: "trace_a",
    redactor: createRedactor(["sentinel-internal-secret"]),
  });
  assert.equal(mapped.envelope.code, "INTERNAL_ERROR");
  assert.equal(getterReads, 0);

  const logLines: string[] = [];
  const { app, database } = await buildTestApp({ logLines });
  const response = await app.inject({
    method: "GET",
    url: "/internal/v1/test-internal-error",
    headers: { authorization: `Bearer ${bootstrapKey}` },
  });
  assert.equal(response.statusCode, 500);
  assert.equal(Schema.Compile(ErrorEnvelopeSchema).Check(response.json()), true);
  assert.equal(response.body.includes("sentinel-internal-secret"), false);
  assert.equal(logLines.join("").includes("sentinel-internal-secret"), false);
  assert.equal(logLines.join("").includes("[REDACTED]"), true);
  await app.close();
  await database.db.destroy();
});

test("every DomainError maps to its exact non-leaking ErrorEnvelope status", () => {
  const expected: Readonly<Record<StableDomainErrorCode, readonly [number, string]>> = {
    INVALID_REQUEST: [400, "validation"],
    UNAUTHENTICATED: [401, "authentication"],
    RESOURCE_NOT_FOUND: [404, "authorization"],
    IDEMPOTENCY_CONFLICT: [409, "conflict"],
    RESOURCE_VERSION_CONFLICT: [409, "conflict"],
    INVALID_STATE_TRANSITION: [409, "conflict"],
    RUNTIME_NOT_READY: [409, "conflict"],
    SUPERVISOR_REJECTED: [409, "conflict"],
    DEPENDENCY_UNAVAILABLE: [503, "dependency"],
    DEPENDENCY_TIMEOUT: [504, "timeout"],
    INTERNAL_ERROR: [500, "internal"],
  };
  for (const [code, [statusCode, category]] of Object.entries(expected) as Array<[
    StableDomainErrorCode,
    readonly [number, string],
  ]>) {
    const mapped = mapApiError(new DomainError(code, "Bearer sentinel-internal-secret", true), {
      requestId: "request_a",
      traceId: "trace_a",
      redactor: createRedactor(["sentinel-internal-secret"]),
    });
    assert.equal(mapped.statusCode, statusCode);
    assert.equal(mapped.envelope.category, category);
    assert.equal(mapped.envelope.code, code);
    assert.equal(mapped.envelope.message.includes("sentinel"), false);
    assert.equal(
      mapped.envelope.retryable,
      code === "DEPENDENCY_UNAVAILABLE" || code === "DEPENDENCY_TIMEOUT",
    );
    assert.equal(Schema.Compile(ErrorEnvelopeSchema).Check(mapped.envelope), true);
    assert.equal(mapped.internalError === undefined, code !== "INTERNAL_ERROR");
  }
});
