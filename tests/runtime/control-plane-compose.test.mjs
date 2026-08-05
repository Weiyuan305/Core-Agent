import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { parse } from "yaml";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pathFromRoot = (...parts) => join(repositoryRoot, ...parts);

async function source(path) {
  return readFile(pathFromRoot(path), "utf8").catch(() => "");
}

async function yaml(path) {
  const text = await source(path);
  assert.notEqual(text, "", `${path} must exist`);
  const value = parse(text);
  assert(value !== null && typeof value === "object" && !Array.isArray(value));
  return value;
}

function environmentMap(service) {
  if (service.environment === undefined) return {};
  assert(!Array.isArray(service.environment), "environment must use an auditable mapping");
  return service.environment;
}

function volumeTargets(service) {
  return (service.volumes ?? []).map((mount) => {
    if (typeof mount === "string") return mount.split(":")[1];
    return mount.target;
  });
}

function secretTargets(service) {
  return (service.secrets ?? []).map((mount) => typeof mount === "string" ? mount : mount.target);
}

function networkNames(service) {
  if (Array.isArray(service.networks)) return [...service.networks].sort();
  return Object.keys(service.networks ?? {}).sort();
}

function parseDockerfile(text) {
  const instructions = [];
  let logical = "";
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    logical += (logical === "" ? "" : " ") + line.replace(/\\$/u, "").trim();
    if (line.endsWith("\\")) continue;
    const match = logical.match(/^([A-Z]+)\s+(.+)$/iu);
    assert(match, `invalid Dockerfile instruction: ${logical}`);
    instructions.push({ name: match[1].toUpperCase(), value: match[2] });
    logical = "";
  }
  assert.equal(logical, "");
  return instructions;
}

test("only API publishes a loopback port and only Supervisor mounts Docker", async () => {
  const config = await yaml("infra/runtime/compose.dev.yaml");
  assert.deepEqual(Object.keys(config.services).sort(), [
    "api", "migrate", "postgres", "supervisor", "worker",
  ]);
  assert.deepEqual(config.services.api.ports, ["127.0.0.1:8787:8787"]);
  for (const name of ["postgres", "migrate", "worker", "supervisor"]) {
    assert.equal(config.services[name].ports, undefined);
  }
  for (const name of ["postgres", "migrate", "api", "worker"]) {
    assert(!JSON.stringify(config.services[name]).includes("docker.sock"));
  }
  assert(JSON.stringify(config.services.supervisor).includes("docker.sock"));
  assert.equal(config.services.supervisor.privileged, false);
  assert.equal(config.services.supervisor.network_mode, "none");
  assert.equal(config.services.supervisor.pid, undefined);
  assert.equal(config.services.supervisor.ipc, undefined);
  assert.equal(config.services.supervisor.cgroup, undefined);
});

test("service mounts and networks preserve each process boundary", async () => {
  const config = await yaml("infra/runtime/compose.dev.yaml");
  const { api, migrate, postgres, supervisor, worker } = config.services;

  assert.deepEqual(networkNames(postgres), ["core-agent-control"]);
  assert.deepEqual(networkNames(migrate), ["core-agent-control"]);
  assert.deepEqual(networkNames(api), ["core-agent-control"]);
  assert.deepEqual(networkNames(worker), ["core-agent-backplane", "core-agent-control"]);
  assert.deepEqual(networkNames(supervisor), []);
  assert.deepEqual(config.networks["core-agent-control"], { driver: "bridge", internal: true });
  assert.deepEqual(config.networks["core-agent-backplane"], {
    external: true,
    name: "core-agent-backplane",
  });

  assert.deepEqual(volumeTargets(api), ["/app/infra/runtime/providers.json"]);
  assert.deepEqual(secretTargets(api), ["/run/secrets/bootstrap_key"]);
  assert.deepEqual(volumeTargets(worker).sort(), [
    "/app/infra/runtime/providers.json",
    "/run/core-agent/ingress",
    "/run/core-agent/supervisor",
  ]);
  assert.deepEqual(secretTargets(worker), []);
  assert.deepEqual(volumeTargets(supervisor).sort(), [
    "/run/core-agent/ingress",
    "/run/core-agent/provider",
    "/run/core-agent/supervisor",
    "/var/lib/core-agent/supervisor",
    "/var/run/docker.sock",
  ]);
  assert.deepEqual(secretTargets(supervisor), []);

  assert(!volumeTargets(api).some((target) => /provider|ingress|docker|supervisor/u.test(target)));
  assert(!volumeTargets(worker).some((target) => /provider|docker/u.test(target)));
  assert(![...volumeTargets(supervisor), ...secretTargets(supervisor)].some((target) => /bootstrap/u.test(target)));
  assert.deepEqual(Object.keys(config.volumes).sort(), [
    "postgres-data", "supervisor-socket", "supervisor-state",
  ]);
  assert.deepEqual(Object.keys(config.secrets), ["bootstrap-key"]);
});

test("application services use least privilege and bounded resources", async () => {
  const config = await yaml("infra/runtime/compose.dev.yaml");
  for (const name of ["api", "worker", "supervisor"]) {
    const service = config.services[name];
    assert.match(String(service.user), /^\d+:\d+$/u);
    assert.equal(service.read_only, true);
    assert.deepEqual(service.cap_drop, ["ALL"]);
    assert.deepEqual(service.security_opt, ["no-new-privileges:true"]);
    assert(Number.isInteger(service.pids_limit) && service.pids_limit > 0 && service.pids_limit <= 256);
    assert.match(String(service.mem_limit), /^\d+(?:m|g)$/u);
    assert.equal(typeof service.cpus, "number");
    assert(service.cpus > 0 && service.cpus <= 2);
    assert.match(String(service.stop_grace_period), /^\d+s$/u);
    assert(service.tmpfs !== undefined);
  }
  assert.deepEqual(config.services.api.group_add, undefined);
  assert.deepEqual(config.services.worker.group_add, ["12002"]);
  assert.deepEqual(config.services.supervisor.group_add, ["${CORE_AGENT_DOCKER_GID:?set CORE_AGENT_DOCKER_GID}"]);
});

test("startup order gates applications on one successful migration", async () => {
  const config = await yaml("infra/runtime/compose.dev.yaml");
  assert.equal(config.services.migrate.restart, "no");
  assert.deepEqual(config.services.migrate.depends_on, {
    postgres: { condition: "service_healthy" },
  });
  for (const name of ["api", "worker"]) {
    assert.deepEqual(config.services[name].depends_on, {
      migrate: { condition: "service_completed_successfully" },
      postgres: { condition: "service_healthy" },
      supervisor: { condition: "service_started" },
    });
  }
  assert.equal(config.services.postgres.volumes[0].target, "/var/lib/postgresql/data");
  assert.equal(config.services.postgres.healthcheck.test[0], "CMD-SHELL");
});

test("compose environment carries paths and public configuration but no secret values", async () => {
  const config = await yaml("infra/runtime/compose.dev.yaml");
  const forbiddenName = /(PASSWORD|TOKEN|SECRET|API_KEY|BOOTSTRAP_KEY)$/u;
  const forbiddenLiteral = /(bearer\s+|sk-[A-Za-z0-9]|synthetic-leak-sentinel)/iu;
  for (const [name, service] of Object.entries(config.services)) {
    for (const [key, value] of Object.entries(environmentMap(service))) {
      assert(!forbiddenName.test(key), `${name} must not carry ${key} in Docker environment`);
      assert(!forbiddenLiteral.test(String(value)), `${name} embeds a credential-like value`);
    }
  }
  const apiEnvironment = environmentMap(config.services.api);
  assert.equal(apiEnvironment.CONTROL_PLANE_BOOTSTRAP_KEY_FILE, "/run/secrets/bootstrap_key");
  assert.equal(apiEnvironment.CONTROL_PLANE_PROVIDER_CATALOG_FILE, "/app/infra/runtime/providers.json");
  assert.equal(apiEnvironment.CONTROL_PLANE_IMAGE_LOCK_FILE, "/app/infra/hermes/base-images.lock.json");
  const workerEnvironment = environmentMap(config.services.worker);
  assert.equal(workerEnvironment.CONTROL_PLANE_PROVIDER_CATALOG_FILE, "/app/infra/runtime/providers.json");
  assert.equal(workerEnvironment.CONTROL_PLANE_SECRET_ROOT, "/run/core-agent/ingress");
  const supervisorEnvironment = environmentMap(config.services.supervisor);
  assert.equal(supervisorEnvironment.CORE_AGENT_PROVIDER_CATALOG_PATH, "/app/infra/runtime/providers.json");
  assert.equal(supervisorEnvironment.CORE_AGENT_IMAGE_LOCK_PATH, "/app/infra/hermes/base-images.lock.json");
  assert.equal(supervisorEnvironment.CORE_AGENT_SECRET_ROOT, "/run/core-agent/provider");
});

test("runtime image lock contains exact registry-derived platform references", async () => {
  const lock = JSON.parse(await source("infra/runtime/base-images.lock.json"));
  assert.equal(lock.schemaVersion, 1);
  assert.deepEqual(Object.keys(lock.images).sort(), ["node", "postgres"]);
  const expectedSources = { node: "node:22-bookworm-slim", postgres: "postgres:17-bookworm" };
  for (const [name, sourceTag] of Object.entries(expectedSources)) {
    assert.equal(lock.images[name].source, sourceTag);
    assert.deepEqual(Object.keys(lock.images[name].platforms).sort(), ["linux/amd64", "linux/arm64"]);
    for (const reference of Object.values(lock.images[name].platforms)) {
      assert.equal(reference.startsWith(`${sourceTag}@`), true);
      assert.match(reference.slice(sourceTag.length + 1), /^sha256:[a-f0-9]{64}$/u);
    }
  }
});

test("runtime image resolver validates registry output and writes atomically", async () => {
  const moduleUrl = pathToFileURL(pathFromRoot("scripts/resolve-runtime-images.mjs")).href;
  const resolver = await import(`${moduleUrl}?red=${Date.now()}`);
  assert.deepEqual(resolver.APPROVED_IMAGES, {
    node: "node:22-bookworm-slim",
    postgres: "postgres:17-bookworm",
  });
  const amd64 = "a".repeat(64);
  const arm64 = "b".repeat(64);
  const manifest = JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [
      { digest: `sha256:${arm64}`, platform: { os: "linux", architecture: "arm64" } },
      { digest: `sha256:${amd64}`, platform: { os: "linux", architecture: "amd64" } },
    ],
  });
  const calls = [];
  const writes = [];
  const renames = [];
  const lock = await resolver.resolveRuntimeImages({
    inspectRaw: async (image) => { calls.push(image); return manifest; },
    writeFile: async (path, bytes, options) => writes.push({ path: String(path), bytes, options }),
    rename: async (from, to) => renames.push([String(from), String(to)]),
    randomSuffix: () => "static-test",
  });
  assert.deepEqual(calls, ["node:22-bookworm-slim", "postgres:17-bookworm"]);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].options.mode, 0o644);
  assert.match(writes[0].path, /base-images\.lock\.json\.tmp-static-test$/u);
  assert.deepEqual(renames, [[writes[0].path, pathFromRoot("infra/runtime/base-images.lock.json")]]);
  assert.equal(lock.images.node.platforms["linux/amd64"], `node:22-bookworm-slim@sha256:${amd64}`);
  assert.equal(lock.images.node.platforms["linux/arm64"], `node:22-bookworm-slim@sha256:${arm64}`);
  await assert.rejects(
    resolver.resolveRuntimeImages({ inspectRaw: async () => "{}", writeFile: async () => assert.fail("must not write"), rename: async () => assert.fail("must not rename") }),
    /registry manifest is invalid/u,
  );
});

test("runtime Dockerfile has locked bases and exact non-root service targets", async () => {
  const text = await source("infra/runtime/Dockerfile");
  assert.notEqual(text, "", "infra/runtime/Dockerfile must exist");
  const instructions = parseDockerfile(text);
  const froms = instructions.filter(({ name }) => name === "FROM").map(({ value }) => value);
  assert.deepEqual(froms, [
    "${NODE_IMAGE} AS dependencies",
    "dependencies AS build",
    "${NODE_IMAGE} AS runtime",
    "runtime AS api",
    "runtime AS worker",
    "runtime AS supervisor",
  ]);
  assert(instructions.some(({ name, value }) => name === "ARG" && value === "NODE_IMAGE"));
  assert(!/\b(node|npm|postgres):[^\s@]+\s+AS\s+/iu.test(text));
  assert.match(text, /RUN npm ci --ignore-scripts/u);
  assert.match(text, /npm run contracts:build/u);
  assert.match(text, /npm run build -w @core-agent\/runtime-core/u);
  assert.match(text, /npm run build -w @core-agent\/control-plane-api/u);
  assert.match(text, /npm run build -w @core-agent\/control-plane-worker/u);
  assert.match(text, /npm run build -w @core-agent\/runtime-supervisor/u);
  assert.match(text, /USER 12000:12000[\s\S]*ENTRYPOINT \["node", "apps\/control-plane-api\/dist\/src\/server\.js"\]/u);
  assert.match(text, /USER 12001:12002[\s\S]*ENTRYPOINT \["node", "apps\/control-plane-worker\/dist\/src\/server\.js"\]/u);
  assert.match(text, /USER 12002:12002[\s\S]*ENTRYPOINT \["node", "apps\/runtime-supervisor\/dist\/src\/main\.js"\]/u);
});

test("CI preserves contracts and separates deterministic runtime gates", async () => {
  const workflow = await yaml(".github/workflows/runtime-contract.yml");
  assert.deepEqual(Object.keys(workflow.jobs).sort(), ["compose", "contract", "integration", "postgres", "unit"]);
  const workflowSource = await source(".github/workflows/runtime-contract.yml");
  for (const uses of workflowSource.matchAll(/^\s*uses:\s*([^\s#]+).*$/gmu)) {
    assert.match(uses[1], /@[a-f0-9]{40}$/u);
  }
  assert.match(workflowSource, /actions\/checkout@[a-f0-9]{40}\s+# v4\.2\.2/u);
  assert.match(workflowSource, /actions\/setup-node@[a-f0-9]{40}\s+# v4\.4\.0/u);
  assert(!/secrets\./u.test(workflowSource));
  assert(!/hermes:build|REAL_HERMES|docker\.sock|docker compose up/u.test(workflowSource));
  const lock = JSON.parse(await source("infra/runtime/base-images.lock.json"));
  assert.equal(workflow.jobs.postgres.services.postgres.image, lock.images.postgres.platforms["linux/amd64"]);
  assert.equal(workflow.jobs.integration.services.postgres.image, lock.images.postgres.platforms["linux/amd64"]);
  assert.match(workflowSource, /npm run test:postgres/u);
  assert.match(workflowSource, /npm run test:integration/u);
  assert.match(workflowSource, /npm run test:runtime/u);
  assert.match(workflowSource, /docker compose -f infra\/runtime\/compose\.dev\.yaml config --quiet/u);
  assert.match(workflowSource, /verify-no-secret\.mjs/u);
  assert.match(workflowSource, /postgresql:\/\/core_agent_ci:core_agent_ci@127\.0\.0\.1:5432\/core_agent_control/u);
});

test("runtime example environment contains paths and generated references only", async () => {
  const text = await source(".env.runtime.example");
  assert.match(text, /CORE_AGENT_PLATFORM=linux\/\$\{ARCHITECTURE\}/u);
  assert.match(text, /CORE_AGENT_NODE_IMAGE=node:22-bookworm-slim@sha256:<resolve-with-npm-run-runtime-images>/u);
  assert.match(text, /CORE_AGENT_POSTGRES_IMAGE=postgres:17-bookworm@sha256:<resolve-with-npm-run-runtime-images>/u);
  assert.match(text, /CORE_AGENT_BOOTSTRAP_KEY_FILE=\/absolute\/path\/to\/bootstrap-key/u);
  assert.match(text, /CORE_AGENT_PROVIDER_SECRET_ROOT=\/absolute\/path\/to\/provider-secret-directory/u);
  assert.match(text, /CORE_AGENT_INGRESS_SECRET_ROOT=\/absolute\/path\/to\/ingress-secret-directory/u);
  assert(!/^.*(?:PASSWORD|TOKEN|SECRET|KEY)=(?!\/absolute\/path\/to\/|$).+$/gmu.test(text));
  assert(!/sk-[A-Za-z0-9]|bearer\s+/iu.test(text));
});

test("runtime PostgreSQL initialization creates only the disposable control database", async () => {
  const sql = await source("infra/runtime/postgres/init/00-create-test-database.sql");
  assert.match(sql, /^CREATE DATABASE core_agent_control;\n$/u);
  assert(!/DROP|ALTER|GRANT|PASSWORD/iu.test(sql));
});
