import assert from "node:assert/strict";
import test from "node:test";

import { canonicalPayloadHash, DomainError } from "@core-agent/runtime-core";
import type { FastifyInstance } from "fastify";

import { buildIdentityGatewayApp, type IdentityGatewayOperations } from "../src/app.js";
import { IdentityGatewayFailure } from "../src/errors.js";

const host = "identity.example.test";
const origin = "https://app.example.test";
const sessionSecret = "s".repeat(43);
const csrfSecret = "c".repeat(43);

interface RecordedCall {
  readonly name: string;
  readonly input: unknown;
}

function defaultCommandResult(input: Record<string, unknown>): Record<string, unknown> {
  switch (input.kind) {
    case "catalog_capability_review":
      return {
        schema_version: 1,
        capability_version_id: "capability_version_01",
        capability_id: "capability_01",
        version: "1.0.0",
        status: "reviewed",
        resource_version: 2,
      };
    case "entitlement_grant":
      return {
        schema_version: 1,
        entitlement_id: "entitlement_company",
        tenant_id: "tenant_company",
        pack_product_id: "pack_company",
        status: "active",
        reason_code: "platform_manual",
        resource_version: 1,
        valid_from: "2026-08-24T00:00:00.000Z",
        seat_quantity: 2,
      };
    case "entitlement_seat_assign":
      return {
        schema_version: 1,
        assignment_id: "assignment_consultant",
        entitlement_id: "entitlement_company",
        profile_id: "profile_consultant",
        status: "preparing",
        reason_code: "manual_assignment",
        resource_version: 1,
        used_seats: 1,
        total_seats: 2,
        available_seats: 1,
      };
    default:
      return { schema_version: 1 };
  }
}

function headers(mutating = false): Record<string, string> {
  return {
    host,
    origin,
    ...(mutating ? { "content-type": "application/json", "x-core-agent-csrf": csrfSecret } : {}),
    cookie: `core_agent_session=${sessionSecret}; core_agent_csrf=${csrfSecret}`,
  };
}

async function buildApp(calls: RecordedCall[], execute?: (input: Record<string, unknown>) => unknown): Promise<FastifyInstance> {
  const operations = {
    async consumeRateLimit(input: unknown) { calls.push({ name: "consumeRateLimit", input }); return null; },
    async authenticateSession(input: unknown) {
      calls.push({ name: "authenticateSession", input });
      return {
        actorId: "actor_admin", authSubjectId: "auth_admin",
        session: { session_id: "session_admin", client_kind: "web", session_resource_version: 4 },
      };
    },
    async executeAuthorityCommand(input: unknown) {
      calls.push({ name: "executeAuthorityCommand", input });
      return execute?.(input as Record<string, unknown>) ?? defaultCommandResult(input as Record<string, unknown>);
    },
    async executeProtectedAuthorityCommand(input: unknown) {
      calls.push({ name: "executeProtectedAuthorityCommand", input });
      return execute?.(input as Record<string, unknown>) ?? defaultCommandResult(input as Record<string, unknown>);
    },
  } as unknown as IdentityGatewayOperations;
  return buildIdentityGatewayApp({
    config: {
      publicOrigins: new Set([origin]), cookieHost: host,
      publicBaseUrl: `https://${host}`, providerUrl: "https://provider.example.test",
      appleWebRedirectUris: new Set([`${origin}/auth/apple/callback`]),
      appleNativeRedirectUris: new Set(["coreagent://auth/apple/callback"]),
      passwordResetRedirectUri: `${origin}/auth/password/reset/callback`, publicAuthEnabled: true,
    },
    provider: {} as never,
    operations,
    flowCookieKey: Buffer.alloc(32, 0x51),
  });
}

test("entitlement and catalog routes expose closed public summaries", async () => {
  const calls: RecordedCall[] = [];
  const app = await buildApp(calls, (input) => {
    switch (input.kind) {
      case "platform_catalog_list": return {
        schema_version: 1,
        capabilities: [{ schema_version: 1, capability_id: "capability_read", display_name: "Knowledge read", kind: "mcp", status: "reviewed" }],
        packs: [{ schema_version: 1, pack_product_id: "pack_student", display_name: "Student Suite", tenant_modes: ["b2c"], status: "published" }],
      };
      case "platform_entitlement_list": return { schema_version: 1, entitlements: [] };
      case "company_service_list": return {
        schema_version: 1,
        services: [{ schema_version: 1, service_id: "entitlement_company", display_name: "Company Suite", valid_from: "2026-08-24T00:00:00.000Z", service_state: "available", used_seats: 1, total_seats: 3, available_seats: 2 }],
      };
      case "company_assignment_list": return { schema_version: 1, assignments: [] };
      case "student_service_list": return {
        schema_version: 1,
        services: [{ schema_version: 1, service_id: "entitlement_student", display_name: "Student Suite", valid_from: "2026-08-24T00:00:00.000Z", service_state: "preparing" }],
      };
      default: return { schema_version: 1 };
    }
  });

  for (const url of [
    "/app/v1/platform/catalog",
    "/app/v1/platform/entitlements",
    "/app/v1/company/services?tenant_id=tenant_company",
    "/app/v1/company/assignments?tenant_id=tenant_company",
    "/app/v1/student/services",
  ]) {
    const response = await app.inject({ method: "GET", url, headers: headers() });
    assert.equal(response.statusCode, 200, `${url}: ${response.body}`);
    assert.equal(response.headers["cache-control"], "no-store");
  }

  assert.deepEqual(calls.map(({ name }) => name), Array(5).fill(["consumeRateLimit", "authenticateSession", "executeAuthorityCommand"]).flat());
  assert.deepEqual(calls.filter(({ name }) => name === "executeAuthorityCommand").map(({ input }) => (input as { kind: string }).kind), [
    "platform_catalog_list", "platform_entitlement_list", "company_service_list", "company_assignment_list", "student_service_list",
  ]);
  await app.close();
});

test("catalog, entitlement, and seat mutations require protected authority", async () => {
  const calls: RecordedCall[] = [];
  const app = await buildApp(calls);
  const commands = [
    ["/app/v1/platform/catalog", "catalog_capability_review", {
      action: "capability_review",
      command: (() => { const facts = { schema_version: 1 as const, idempotency_key: "catalog_review", capability_version_id: "capability_version_01", expected_resource_version: 1 }; return { ...facts, payload_hash: canonicalPayloadHash(facts) }; })(),
    }],
    ["/app/v1/platform/entitlements", "entitlement_grant", {
      action: "grant",
      command: (() => { const facts = { schema_version: 1 as const, idempotency_key: "grant_01", tenant_id: "tenant_company", pack_product_id: "pack_company", source: "platform_manual" as const, external_order_ref: "order_internal", expected_resource_version: 1, tenant_mode: "b2b" as const, assignment_mode: "seat" as const, seat_quantity: 2 }; return { ...facts, payload_hash: canonicalPayloadHash(facts) }; })(),
    }],
    ["/app/v1/company/assignments", "entitlement_seat_assign", {
      action: "assign",
      tenant_id: "tenant_company",
      command: (() => { const facts = { schema_version: 1 as const, idempotency_key: "seat_01", entitlement_id: "entitlement_company", expected_resource_version: 1, profile_id: "profile_consultant" }; return { ...facts, payload_hash: canonicalPayloadHash(facts) }; })(),
    }],
  ] as const;

  for (const [url, kind, payload] of commands) {
    calls.length = 0;
    const response = await app.inject({ method: "POST", url, headers: headers(true), payload });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(calls.map(({ name }) => name), ["consumeRateLimit", "authenticateSession", "executeProtectedAuthorityCommand"]);
    assert.equal((calls[2]?.input as { kind?: unknown }).kind, kind);
    assert.equal((calls[2]?.input as { authority?: { actorId?: unknown } }).authority?.actorId, "actor_admin");
  }
  await app.close();
});

test("mutation responses expose only closed public result fields", async () => {
  const calls: RecordedCall[] = [];
  const app = await buildApp(calls, (input) => input.kind === "catalog_capability_review" ? {
    schema_version: 1,
    capability_version_id: "capability_version_01",
    capability_id: "capability_01",
    version: "1.0.0",
    status: "reviewed",
    resource_version: 2,
    compatibility_hash: `sha256:${"a".repeat(64)}`,
    artifact_ref: "oci:private.example/runtime@sha256:secret",
  } : { schema_version: 1 });
  const facts = {
    schema_version: 1 as const,
    idempotency_key: "catalog_review_closed",
    capability_version_id: "capability_version_01",
    expected_resource_version: 1,
  };
  const response = await app.inject({
    method: "POST", url: "/app/v1/platform/catalog", headers: headers(true),
    payload: { action: "capability_review", command: { ...facts, payload_hash: canonicalPayloadHash(facts) } },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), {
    schema_version: 1,
    capability_version_id: "capability_version_01",
    capability_id: "capability_01",
    version: "1.0.0",
    status: "reviewed",
    resource_version: 2,
  });
  assert.doesNotMatch(response.body, /compatibility_hash|artifact_ref|private/u);
  await app.close();
});

test("catalog mutation projection rejects accessor-backed operation results without invoking accessors", async () => {
  let getterCalls = 0;
  const calls: RecordedCall[] = [];
  const result = {
    schema_version: 1,
    get capability_version_id() { getterCalls += 1; return "capability_version_01"; },
    capability_id: "capability_01",
    version: "1.0.0",
    status: "reviewed",
    resource_version: 2,
  };
  const app = await buildApp(calls, () => result);
  const facts = {
    schema_version: 1 as const,
    idempotency_key: "catalog_review_accessor",
    capability_version_id: "capability_version_01",
    expected_resource_version: 1,
  };
  const response = await app.inject({
    method: "POST", url: "/app/v1/platform/catalog", headers: headers(true),
    payload: { action: "capability_review", command: { ...facts, payload_hash: canonicalPayloadHash(facts) } },
  });
  assert.equal(response.statusCode, 500, response.body);
  assert.equal(getterCalls, 0);
  await app.close();
});

test("entitlement routes fail closed before authority and return calm service errors", async () => {
  const calls: RecordedCall[] = [];
  const app = await buildApp(calls, (input) => {
    if (input.kind === "entitlement_seat_assign") throw new DomainError("SEAT_EXHAUSTED", "internal seat count 3/3");
    if (input.kind === "entitlement_select_release") throw new DomainError("CAPABILITY_CONFLICT", "capability_version_hidden");
    if (input.kind === "company_service_list") throw new DomainError("SERVICE_PREPARING", "runtime_hidden");
    if (input.kind === "company_assignment_list") throw new DomainError("ENTITLEMENT_DENIED", "inactive entitlement internals");
    return { schema_version: 1 };
  });

  const malformed = await app.inject({
    method: "POST", url: "/app/v1/company/assignments", headers: headers(true),
    payload: { action: "assign", tenant_id: "tenant_company", command: { schema_version: 1 } },
  });
  assert.equal(malformed.statusCode, 400, malformed.body);
  assert.equal(calls.length, 0, "malformed public commands must fail before rate and Session authority");

  const seatFacts = { schema_version: 1 as const, idempotency_key: "seat_full", entitlement_id: "entitlement_company", expected_resource_version: 1, profile_id: "profile_consultant" };
  const seat = await app.inject({
    method: "POST", url: "/app/v1/company/assignments", headers: headers(true),
    payload: { action: "assign", tenant_id: "tenant_company", command: { ...seatFacts, payload_hash: canonicalPayloadHash(seatFacts) } },
  });
  assert.equal(seat.statusCode, 409, seat.body);
  assert.equal(seat.json().message, "可分配名额已用完。");
  assert.doesNotMatch(seat.body, /3\/3|internal/u);

  calls.length = 0;
  const services = await app.inject({ method: "GET", url: "/app/v1/company/services?tenant_id=tenant_company", headers: headers() });
  assert.equal(services.statusCode, 503, services.body);
  assert.equal(services.json().message, "服务准备未完成，我们正在处理。");
  assert.doesNotMatch(services.body, /container|runtime_hidden/u);
  const denied = await app.inject({ method: "GET", url: "/app/v1/company/assignments?tenant_id=tenant_company", headers: headers() });
  assert.equal(denied.statusCode, 403, denied.body);
  assert.equal(denied.json().code, "ENTITLEMENT_DENIED");
  assert.doesNotMatch(denied.body, /inactive entitlement internals/u);
  await app.close();
});
