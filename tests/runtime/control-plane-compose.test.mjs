import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
  const value = parse(text, { merge: true });
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

function volumeAt(service, target) {
  const mount = (service.volumes ?? []).find((candidate) => typeof candidate !== "string" && candidate.target === target);
  assert(mount, `missing structured mount at ${target}`);
  return mount;
}

function secretTargets(service) {
  return (service.secrets ?? []).map((mount) => {
    const target = typeof mount === "string" ? mount : mount.target;
    return target.startsWith("/") ? target : `/run/secrets/${target}`;
  });
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
  for (const service of Object.values(config.services)) {
    assert.notEqual(service.privileged, true);
    assert.equal(service.pid, undefined);
    assert.equal(service.ipc, undefined);
    assert.equal(service.cgroup, undefined);
  }
  assert(JSON.stringify(config.services.supervisor).includes("docker.sock"));
  assert.equal(config.services.supervisor.privileged, false);
  assert.equal(config.services.supervisor.network_mode, "none");
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
  assert.deepEqual(api.secrets, [{
    source: "bootstrap-key",
    target: "bootstrap_key",
    uid: "${CORE_AGENT_RUNTIME_UID:-12000}",
    gid: "${CORE_AGENT_RUNTIME_GID:-12000}",
    mode: 0o600,
  }]);
  assert.deepEqual(volumeTargets(worker).sort(), [
    "/app/infra/runtime/providers.json",
    "/run/core-agent/ingress",
    "/run/core-agent/supervisor",
  ]);
  assert.deepEqual(secretTargets(worker), []);
  assert.deepEqual(volumeTargets(supervisor).sort(), [
    "/run/core-agent/secrets/ingress",
    "/run/core-agent/secrets/provider",
    "/run/core-agent/supervisor",
    "/var/lib/core-agent/supervisor",
    "/var/run/docker.sock",
  ]);
  assert.deepEqual(secretTargets(supervisor), []);
  assert.equal(volumeAt(api, "/app/infra/runtime/providers.json").read_only, true);
  assert.equal(volumeAt(worker, "/app/infra/runtime/providers.json").read_only, true);
  assert.equal(volumeAt(worker, "/run/core-agent/ingress").read_only, true);
  assert.equal(volumeAt(worker, "/run/core-agent/supervisor").read_only, true);
  assert.equal(
    volumeAt(worker, "/run/core-agent/supervisor").source,
    "${CORE_AGENT_SUPERVISOR_SOCKET_ROOT:?set CORE_AGENT_SUPERVISOR_SOCKET_ROOT}",
  );
  assert.equal(volumeAt(supervisor, "/run/core-agent/secrets/provider").read_only, true);
  assert.equal(volumeAt(supervisor, "/run/core-agent/secrets/ingress").read_only, true);
  assert.equal(volumeAt(supervisor, "/run/core-agent/supervisor").read_only, undefined);
  assert.equal(
    volumeAt(supervisor, "/run/core-agent/supervisor").source,
    "${CORE_AGENT_SUPERVISOR_SOCKET_ROOT:?set CORE_AGENT_SUPERVISOR_SOCKET_ROOT}",
  );
  assert.equal(volumeAt(supervisor, "/var/lib/core-agent/supervisor").read_only, undefined);
  assert.equal(
    volumeAt(supervisor, "/var/lib/core-agent/supervisor").source,
    "${CORE_AGENT_SUPERVISOR_STATE_ROOT:?set CORE_AGENT_SUPERVISOR_STATE_ROOT}",
  );
  assert.equal(volumeAt(supervisor, "/var/run/docker.sock").read_only, undefined);

  assert(!volumeTargets(api).some((target) => /secrets\/provider|ingress|docker|supervisor/u.test(target)));
  assert(!volumeTargets(worker).some((target) => /secrets\/provider|docker/u.test(target)));
  assert(![...volumeTargets(supervisor), ...secretTargets(supervisor)].some((target) => /bootstrap/u.test(target)));
  assert.deepEqual(Object.keys(config.volumes), ["postgres-data"]);
  assert.deepEqual(Object.keys(config.secrets), ["bootstrap-key"]);
  assert.deepEqual(config.secrets["bootstrap-key"], {
    file: "${CORE_AGENT_BOOTSTRAP_KEY_FILE:?set CORE_AGENT_BOOTSTRAP_KEY_FILE}",
  });
});

test("application services use least privilege and bounded resources", async () => {
  const config = await yaml("infra/runtime/compose.dev.yaml");
  assert.equal(config.services.migrate.user, "${CORE_AGENT_RUNTIME_UID:-12000}:${CORE_AGENT_RUNTIME_GID:-12000}");
  assert.notEqual(config.services.migrate.user, "0:0");
  assert.equal(config.services.migrate.read_only, true);
  assert.deepEqual(config.services.migrate.cap_drop, ["ALL"]);
  assert.deepEqual(config.services.migrate.security_opt, ["no-new-privileges:true"]);
  for (const name of ["api", "worker", "supervisor"]) {
    const service = config.services[name];
    assert.notEqual(service.user, "0:0");
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
  assert.equal(config.services.api.user, "${CORE_AGENT_RUNTIME_UID:-12000}:${CORE_AGENT_RUNTIME_GID:-12000}");
  assert.equal(config.services.worker.user, "${CORE_AGENT_RUNTIME_UID:-12002}:${CORE_AGENT_SUPERVISOR_SOCKET_GID:-12002}");
  assert.equal(config.services.supervisor.user, "${CORE_AGENT_RUNTIME_UID:-12002}:${CORE_AGENT_SUPERVISOR_SOCKET_GID:-12002}");
  assert.deepEqual(config.services.api.group_add, undefined);
  assert.deepEqual(config.services.worker.group_add, ["${CORE_AGENT_SUPERVISOR_SOCKET_GID:-12002}"]);
  assert.deepEqual(config.services.supervisor.group_add, ["${CORE_AGENT_DOCKER_GID:?set CORE_AGENT_DOCKER_GID}"]);
  const staging = config.services.supervisor.tmpfs.find((entry) => entry.startsWith("/run/core-agent/staging:"));
  assert(staging);
  const stagingOptions = new Set(staging.slice(staging.indexOf(":") + 1).split(","));
  for (const option of [
    "rw", "noexec", "nosuid", "nodev", "size=128m", "mode=0700",
    "uid=${CORE_AGENT_RUNTIME_UID:-12002}",
    "gid=${CORE_AGENT_SUPERVISOR_SOCKET_GID:-12002}",
  ]) {
    assert(stagingOptions.has(option));
  }
});

test("startup order gates applications on one successful migration", async () => {
  const config = await yaml("infra/runtime/compose.dev.yaml");
  assert.equal(config.services.migrate.restart, "no");
  assert.deepEqual(config.services.migrate.depends_on, {
    postgres: { condition: "service_healthy" },
  });
  assert.deepEqual(config.services.api.depends_on, {
    migrate: { condition: "service_completed_successfully" },
    postgres: { condition: "service_healthy" },
  });
  assert.deepEqual(config.services.worker.depends_on, {
    migrate: { condition: "service_completed_successfully" },
    postgres: { condition: "service_healthy" },
    supervisor: { condition: "service_started" },
  });
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
      if (/(?:_FILE|_PATH|_ROOT|_SOCKET)$/u.test(key)) {
        assert(String(value).startsWith("/"), `${name} path configuration must be absolute`);
      }
    }
  }
  const apiEnvironment = environmentMap(config.services.api);
  assert.equal(apiEnvironment.CONTROL_PLANE_BOOTSTRAP_KEY_FILE, "/run/secrets/bootstrap_key");
  assert.equal(apiEnvironment.CONTROL_PLANE_PROVIDER_CATALOG_FILE, "/app/infra/runtime/providers.json");
  assert.equal(apiEnvironment.CONTROL_PLANE_IMAGE_LOCK_FILE, "/app/infra/hermes/base-images.lock.json");
  assert.equal(apiEnvironment.CONTROL_PLANE_DATABASE_URL, "postgresql://core_agent_app@postgres:5432/core_agent_runtime");
  assert.equal(environmentMap(config.services.migrate).CONTROL_PLANE_DATABASE_URL, "postgresql://core_agent_migrator@postgres:5432/core_agent_runtime");
  const workerEnvironment = environmentMap(config.services.worker);
  assert.equal(workerEnvironment.CONTROL_PLANE_PROVIDER_CATALOG_FILE, "/app/infra/runtime/providers.json");
  assert.equal(workerEnvironment.CONTROL_PLANE_SECRET_ROOT, "/run/core-agent/ingress");
  assert.equal(workerEnvironment.CONTROL_PLANE_DATABASE_URL, "postgresql://core_agent_app@postgres:5432/core_agent_runtime");
  assert.deepEqual(environmentMap(config.services.postgres), {
    POSTGRES_DB: "core_agent_runtime",
    POSTGRES_HOST_AUTH_METHOD: "trust",
    POSTGRES_USER: "core_agent_bootstrap",
  });
  const supervisorEnvironment = environmentMap(config.services.supervisor);
  assert.equal(supervisorEnvironment.CORE_AGENT_PROVIDER_CATALOG_PATH, "/app/infra/runtime/providers.json");
  assert.equal(supervisorEnvironment.CORE_AGENT_IMAGE_LOCK_PATH, "/app/infra/hermes/base-images.lock.json");
  assert.equal(supervisorEnvironment.CORE_AGENT_PROVIDER_SECRET_ROOT, "/run/core-agent/secrets/provider");
  assert.equal(supervisorEnvironment.CORE_AGENT_INGRESS_SECRET_ROOT, "/run/core-agent/secrets/ingress");
  assert.equal(supervisorEnvironment.CORE_AGENT_SUPERVISOR_INGRESS_ROOT, "/var/lib/core-agent/supervisor/ingress");
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
  const commandCalls = [];
  assert.equal(await resolver.inspectRegistryRaw("node:22-bookworm-slim", async (...args) => {
    commandCalls.push(args);
    return { stdout: "synthetic-index" };
  }), "synthetic-index");
  assert.deepEqual(commandCalls, [[
    "docker",
    ["buildx", "imagetools", "inspect", "--raw", "node:22-bookworm-slim"],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 30_000 },
  ]]);
  await assert.rejects(
    resolver.inspectRegistryRaw("node:latest", async () => assert.fail("must not inspect")),
    /not approved/u,
  );
  const amd64 = "a".repeat(64);
  const arm64 = "b".repeat(64);
  const manifest = JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [
      { digest: `sha256:${arm64}`, mediaType: "application/vnd.oci.image.manifest.v1+json", size: 1, platform: { os: "linux", architecture: "arm64" } },
      { digest: `sha256:${amd64}`, mediaType: "application/vnd.oci.image.manifest.v1+json", size: 1, platform: { os: "linux", architecture: "amd64" } },
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
  const missingMediaType = JSON.stringify({
    schemaVersion: 2,
    manifests: [
      { digest: `sha256:${amd64}`, mediaType: "application/vnd.oci.image.manifest.v1+json", size: 1, platform: { os: "linux", architecture: "amd64" } },
      { digest: `sha256:${arm64}`, mediaType: "application/vnd.oci.image.manifest.v1+json", size: 1, platform: { os: "linux", architecture: "arm64" } },
    ],
  });
  await assert.rejects(
    resolver.resolveRuntimeImages({ inspectRaw: async () => missingMediaType, writeFile: async () => assert.fail("must not write"), rename: async () => assert.fail("must not rename") }),
    /registry manifest is invalid/u,
  );
  const attestationManifest = JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [
      { digest: `sha256:${amd64}`, mediaType: "application/vnd.oci.image.manifest.v1+json", size: 1, platform: { os: "linux", architecture: "amd64" } },
      { digest: `sha256:${arm64}`, mediaType: "application/vnd.oci.image.manifest.v1+json", size: 1, platform: { os: "linux", architecture: "arm64", variant: "v8" } },
      { digest: `sha256:${"c".repeat(64)}`, mediaType: "application/vnd.oci.image.manifest.v1+json", size: 1, platform: { os: "unknown", architecture: "unknown" } },
    ],
  });
  assert.deepEqual(resolver.platformDigests(attestationManifest), {
    "linux/amd64": `sha256:${amd64}`,
    "linux/arm64": `sha256:${arm64}`,
  });
  const duplicateTarget = JSON.parse(attestationManifest);
  duplicateTarget.manifests.push({
    digest: `sha256:${"d".repeat(64)}`,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    size: 1,
    platform: { os: "linux", architecture: "arm64" },
  });
  assert.throws(() => resolver.platformDigests(JSON.stringify(duplicateTarget)), /registry manifest is invalid/u);
  const unsupportedVariant = JSON.parse(attestationManifest);
  unsupportedVariant.manifests[0].platform.variant = "v2";
  assert.throws(() => resolver.platformDigests(JSON.stringify(unsupportedVariant)), /registry manifest is invalid/u);
  const removed = [];
  await assert.rejects(
    resolver.resolveRuntimeImages({
      inspectRaw: async () => manifest,
      writeFile: async () => undefined,
      rename: async () => { throw new Error("synthetic rename rejection"); },
      unlink: async (path) => removed.push(String(path)),
      randomSuffix: () => "rename-failure",
    }),
    /synthetic rename rejection/u,
  );
  assert.deepEqual(removed, [pathFromRoot("infra/runtime/base-images.lock.json.tmp-rename-failure")]);
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
  assert(froms.every((value) => !/^(?:node|npm|postgres):/iu.test(value)));
  const copies = instructions.filter(({ name }) => name === "COPY").map(({ value }) => value);
  assert(copies.every((value) => !value.startsWith(". ")));
  assert(copies.every((value) => !/(?:^|\s)(?:\.git|\.env|docs|tests)(?:\/|\s|$)/u.test(value)));
  const stages = new Map();
  let stage;
  for (const instruction of instructions) {
    if (instruction.name === "FROM") {
      stage = instruction.value.match(/\s+AS\s+([^\s]+)$/iu)?.[1];
      assert(stage);
      stages.set(stage, []);
    } else if (stage !== undefined) {
      stages.get(stage).push(instruction);
    }
  }
  const values = (name, instruction) => stages.get(name).filter((item) => item.name === instruction).map((item) => item.value);
  assert(values("dependencies", "RUN").some((value) => value === "npm ci --ignore-scripts"));
  assert(values("dependencies", "COPY").every((value) => !/^\.\s/u.test(value)));
  const buildRun = values("build", "RUN").join(" ");
  const buildCommands = [
    "npm run contracts:build",
    "npm run build -w @core-agent/runtime-core",
    "npm run build -w @core-agent/control-plane-api",
    "npm run build -w @core-agent/control-plane-worker",
    "npm run build -w @core-agent/runtime-supervisor",
  ];
  assert(buildCommands.every((command) => buildRun.includes(command)));
  assert.deepEqual(buildCommands.map((command) => buildRun.indexOf(command)), [...buildCommands].map((command) => buildRun.indexOf(command)).sort((a, b) => a - b));
  const runtimeRun = values("runtime", "RUN").join(" ");
  assert.match(runtimeRun, /install -d -m 0700 -o 12002 -g 12002 \/run\/core-agent\/supervisor/u);
  assert.match(runtimeRun, /install -d -m 0700 -o 12002 -g 12002 \/var\/lib\/core-agent\/supervisor\/journal/u);
  const targets = {
    api: { user: "12000:12000", entrypoint: ["node", "apps/control-plane-api/dist/src/server.js"] },
    worker: { user: "12001:12002", entrypoint: ["node", "apps/control-plane-worker/dist/src/server.js"] },
    supervisor: { user: "12002:12002", entrypoint: ["node", "apps/runtime-supervisor/dist/src/main.js"] },
  };
  for (const [name, expected] of Object.entries(targets)) {
    assert.deepEqual(values(name, "USER"), [expected.user]);
    assert.deepEqual(values(name, "ENTRYPOINT").map(JSON.parse), [expected.entrypoint]);
  }
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
  for (const jobName of ["postgres", "integration"]) {
    const service = workflow.jobs[jobName].services.postgres;
    assert.equal(service.image, lock.images.postgres.platforms["linux/amd64"]);
    assert.deepEqual(service.env, {
      POSTGRES_DB: "postgres",
      POSTGRES_HOST_AUTH_METHOD: "trust",
      POSTGRES_USER: "postgres",
    });
    assert.deepEqual(service.ports, ["5432:5432"]);
    assert.match(service.options, /pg_isready -U postgres -d postgres/u);
    const setup = workflow.jobs[jobName].steps.find((step) => step.name === "Create least-privilege CI database role");
    assert(setup);
    assert.match(setup.run, /CREATE ROLE core_agent_ci LOGIN NOSUPERUSER CREATEDB NOCREATEROLE/u);
    assert.match(setup.run, /CREATE DATABASE core_agent_control OWNER core_agent_ci/u);
  }
  assert.match(workflowSource, /npm run test:postgres/u);
  assert.match(workflowSource, /npm run test:integration/u);
  assert.match(workflowSource, /npm run test:runtime/u);
  assert.match(workflowSource, /docker compose -f infra\/runtime\/compose\.dev\.yaml config --quiet/u);
  assert.match(workflowSource, /verify-no-secret\.mjs/u);
  assert.match(workflowSource, /scan-runtime-database\.mjs synthetic-ci-sentinel-runtime-v1/u);
  assert.match(workflowSource, /postgresql:\/\/core_agent_ci@127\.0\.0\.1:5432\/core_agent_control/u);
  assert.equal(workflow.jobs.compose.steps.find((step) => step.name === "Validate Compose configuration").env.CORE_AGENT_SUPERVISOR_SOCKET_ROOT, "/tmp/core-agent-runtime-socket-path-only");
  assert.equal(workflow.jobs.compose.steps.find((step) => step.name === "Validate Compose configuration").env.CORE_AGENT_SUPERVISOR_STATE_ROOT, "/tmp/core-agent-runtime-state-path-only");
});

test("runtime example environment contains paths and generated references only", async () => {
  const text = await source(".env.runtime.example");
  assert.match(text, /CORE_AGENT_PLATFORM=linux\/\$\{ARCHITECTURE\}/u);
  assert.match(text, /CORE_AGENT_NODE_IMAGE=node:22-bookworm-slim@sha256:<resolve-with-npm-run-runtime-images>/u);
  assert.match(text, /CORE_AGENT_POSTGRES_IMAGE=postgres:17-bookworm@sha256:<resolve-with-npm-run-runtime-images>/u);
  assert.match(text, /CORE_AGENT_BOOTSTRAP_KEY_FILE=\/absolute\/path\/to\/bootstrap-key/u);
  assert.match(text, /CORE_AGENT_PROVIDER_SECRET_ROOT=\/absolute\/path\/to\/provider-secret-directory/u);
  assert.match(text, /CORE_AGENT_INGRESS_SECRET_ROOT=\/absolute\/path\/to\/ingress-secret-directory/u);
  assert.match(text, /CORE_AGENT_SUPERVISOR_SOCKET_ROOT=\/absolute\/path\/to\/runtime-socket-directory/u);
  assert.match(text, /CORE_AGENT_SUPERVISOR_STATE_ROOT=\/absolute\/path\/to\/runtime-state-directory/u);
  assert.match(text, /CORE_AGENT_RUNTIME_UID=<numeric-output-of-id-u>/u);
  assert.match(text, /CORE_AGENT_RUNTIME_GID=<numeric-output-of-id-g>/u);
  assert.match(text, /CORE_AGENT_SUPERVISOR_SOCKET_GID=<numeric-output-of-id-g>/u);
  assert.match(text, /bootstrap source must be a regular file owned by the API runtime UID with mode 0600/iu);
  assert(!/^.*(?:PASSWORD|TOKEN|SECRET|KEY)=(?!\/absolute\/path\/to\/|$).+$/gmu.test(text));
  assert(!/sk-[A-Za-z0-9]|bearer\s+/iu.test(text));
});

test("runtime PostgreSQL initialization separates bootstrap migrator and application roles", async () => {
  const sql = await source("infra/runtime/postgres/init/00-create-test-database.sql");
  assert.match(sql, /CREATE ROLE core_agent_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE/u);
  assert.match(sql, /CREATE ROLE core_agent_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE/u);
  assert.match(sql, /ALTER DATABASE core_agent_runtime OWNER TO core_agent_migrator/u);
  assert.match(sql, /CREATE DATABASE core_agent_control OWNER core_agent_migrator/u);
  assert.match(sql, /ALTER DEFAULT PRIVILEGES FOR ROLE core_agent_migrator[\s\S]+GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO core_agent_app/u);
  assert.match(sql, /GRANT CONNECT ON DATABASE core_agent_runtime TO core_agent_app/u);
  assert.match(sql, /GRANT CONNECT ON DATABASE core_agent_control TO core_agent_app/u);
  assert(!/PASSWORD|SUPERUSER(?!\s+NOCREATEDB)/u.test(sql.replaceAll("NOSUPERUSER", "")));
});

test("runtime path preflight creates final-uid 0700 roots and validates bootstrap metadata without reading it", async (t) => {
  const moduleUrl = pathToFileURL(pathFromRoot("scripts/prepare-runtime-paths.mjs")).href;
  const preflight = await import(`${moduleUrl}?red=${Date.now()}`);
  const root = await realpath(await mkdtemp(join(tmpdir(), "core-agent-runtime-paths-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bootstrap = join(root, "bootstrap-key");
  const socketRoot = join(root, "socket");
  const stateRoot = join(root, "state");
  const providerRoot = join(root, "provider");
  const ingressRoot = join(root, "ingress");
  await mkdir(providerRoot, { mode: 0o700 });
  await mkdir(ingressRoot, { mode: 0o700 });
  assert.deepEqual(preflight.resolveRuntimePathPolicy({
    CORE_AGENT_BOOTSTRAP_KEY_FILE: bootstrap,
    CORE_AGENT_PROVIDER_SECRET_ROOT: providerRoot,
    CORE_AGENT_INGRESS_SECRET_ROOT: ingressRoot,
    CORE_AGENT_SUPERVISOR_SOCKET_ROOT: socketRoot,
    CORE_AGENT_SUPERVISOR_STATE_ROOT: stateRoot,
  }), {
    bootstrapPath: bootstrap,
    providerRoot,
    ingressRoot,
    socketRoot,
    stateRoot,
    bootstrapUid: 12000,
    bootstrapGid: 12000,
    supervisorUid: 12002,
    supervisorGid: 12002,
  });
  await writeFile(bootstrap, "not-read-by-preflight\n", { mode: 0o600 });
  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  const environment = {
    CORE_AGENT_BOOTSTRAP_KEY_FILE: bootstrap,
    CORE_AGENT_PROVIDER_SECRET_ROOT: providerRoot,
    CORE_AGENT_INGRESS_SECRET_ROOT: ingressRoot,
    CORE_AGENT_RUNTIME_UID: String(uid),
    CORE_AGENT_RUNTIME_GID: String(gid),
    CORE_AGENT_SUPERVISOR_SOCKET_GID: String(gid),
    CORE_AGENT_SUPERVISOR_SOCKET_ROOT: socketRoot,
    CORE_AGENT_SUPERVISOR_STATE_ROOT: stateRoot,
  };
  await preflight.prepareRuntimePaths({ environment });
  for (const path of [socketRoot, stateRoot]) {
    const metadata = await stat(path);
    assert.equal(metadata.mode & 0o777, 0o700);
    assert.equal(metadata.uid, uid);
    assert.equal(metadata.gid, gid);
  }
  assert(!/readFile|createReadStream/u.test(await source("scripts/prepare-runtime-paths.mjs")));

  await chmod(bootstrap, 0o644);
  await assert.rejects(preflight.prepareRuntimePaths({ environment }), (error) => error?.message === "runtime path preparation failed");
  await chmod(bootstrap, 0o600);
  const linkedBootstrap = join(root, "bootstrap-link");
  await symlink(bootstrap, linkedBootstrap);
  await assert.rejects(preflight.prepareRuntimePaths({ environment: { ...environment, CORE_AGENT_BOOTSTRAP_KEY_FILE: linkedBootstrap } }), /runtime path preparation failed/u);
  const directoryBootstrap = join(root, "bootstrap-directory");
  await mkdir(directoryBootstrap, { mode: 0o700 });
  await assert.rejects(preflight.prepareRuntimePaths({ environment: { ...environment, CORE_AGENT_BOOTSTRAP_KEY_FILE: directoryBootstrap } }), /runtime path preparation failed/u);
  await assert.rejects(preflight.prepareRuntimePaths({ environment: { ...environment, CORE_AGENT_RUNTIME_UID: String(uid + 1) } }), /runtime path preparation failed/u);
  await chmod(socketRoot, 0o755);
  await assert.rejects(preflight.prepareRuntimePaths({ environment }), /runtime path preparation failed/u);
});

test("runtime path preflight rejects symlink ancestors and every canonical cross-purpose overlap", async (t) => {
  const moduleUrl = pathToFileURL(pathFromRoot("scripts/prepare-runtime-paths.mjs")).href;
  const preflight = await import(`${moduleUrl}?separation=${Date.now()}`);
  const root = await realpath(await mkdtemp(join(tmpdir(), "core-agent-runtime-separation-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  const makeDirectory = async (name) => {
    const path = join(root, name);
    await mkdir(path, { mode: 0o700 });
    return path;
  };
  const makeBootstrap = async (path) => {
    await writeFile(path, "metadata-only\n", { mode: 0o600 });
    return path;
  };
  const base = {
    CORE_AGENT_RUNTIME_UID: String(uid),
    CORE_AGENT_RUNTIME_GID: String(gid),
    CORE_AGENT_SUPERVISOR_SOCKET_GID: String(gid),
    CORE_AGENT_BOOTSTRAP_KEY_FILE: await makeBootstrap(join(root, "bootstrap")),
    CORE_AGENT_PROVIDER_SECRET_ROOT: await makeDirectory("provider"),
    CORE_AGENT_INGRESS_SECRET_ROOT: await makeDirectory("ingress"),
    CORE_AGENT_SUPERVISOR_SOCKET_ROOT: join(root, "socket"),
    CORE_AGENT_SUPERVISOR_STATE_ROOT: join(root, "state"),
  };
  await preflight.prepareRuntimePaths({ environment: base });

  const actualParent = await makeDirectory("actual-parent");
  const linkedParent = join(root, "linked-parent");
  await symlink(actualParent, linkedParent);
  const linkedBootstrap = await makeBootstrap(join(actualParent, "bootstrap"));
  await assert.rejects(preflight.prepareRuntimePaths({ environment: {
    ...base,
    CORE_AGENT_BOOTSTRAP_KEY_FILE: join(linkedParent, "bootstrap"),
  } }), /runtime path preparation failed/u);
  assert.equal(await realpath(join(linkedParent, "bootstrap")), linkedBootstrap);

  const sharedSocket = await makeDirectory("shared-socket");
  const nestedBootstrap = await makeBootstrap(join(sharedSocket, "bootstrap"));
  await assert.rejects(preflight.prepareRuntimePaths({ environment: {
    ...base,
    CORE_AGENT_BOOTSTRAP_KEY_FILE: nestedBootstrap,
    CORE_AGENT_SUPERVISOR_SOCKET_ROOT: sharedSocket,
  } }), /runtime path preparation failed/u);

  const ingressWithProvider = await makeDirectory("ingress-with-provider");
  const nestedProvider = join(ingressWithProvider, "provider");
  await mkdir(nestedProvider, { mode: 0o700 });
  await assert.rejects(preflight.prepareRuntimePaths({ environment: {
    ...base,
    CORE_AGENT_INGRESS_SECRET_ROOT: ingressWithProvider,
    CORE_AGENT_PROVIDER_SECRET_ROOT: nestedProvider,
  } }), /runtime path preparation failed/u);

  const socketForAlias = await makeDirectory("socket-for-alias");
  const socketAlias = join(root, "socket-alias");
  await symlink(socketForAlias, socketAlias);
  await assert.rejects(preflight.prepareRuntimePaths({ environment: {
    ...base,
    CORE_AGENT_SUPERVISOR_SOCKET_ROOT: socketForAlias,
    CORE_AGENT_SUPERVISOR_STATE_ROOT: join(socketAlias, "state"),
  } }), /runtime path preparation failed/u);

  const unsafeParent = await makeDirectory("unsafe-parent");
  await chmod(unsafeParent, 0o770);
  const unsafeProvider = join(unsafeParent, "provider");
  await mkdir(unsafeProvider, { mode: 0o700 });
  await assert.rejects(preflight.prepareRuntimePaths({ environment: {
    ...base,
    CORE_AGENT_PROVIDER_SECRET_ROOT: unsafeProvider,
  } }), /runtime path preparation failed/u);
});

test("external backplane preparation is idempotent and validates the Supervisor network contract", async () => {
  const moduleUrl = pathToFileURL(pathFromRoot("scripts/prepare-runtime-network.mjs")).href;
  const network = await import(`${moduleUrl}?red=${Date.now()}`);
  const inspection = JSON.stringify({
    Name: "core-agent-backplane",
    Driver: "bridge",
    Internal: true,
    Attachable: false,
    Labels: {
      "core-agent.managed": "runtime-v1",
      "core-agent.resource": "backplane",
      "core-agent.network": "core-agent-backplane",
    },
  });
  const existingCalls = [];
  await network.prepareRuntimeNetwork({ runDocker: async (args) => {
    existingCalls.push(args);
    return args[1] === "ls" ? "core-agent-backplane\n" : `${inspection}\n`;
  } });
  assert.deepEqual(existingCalls, [
    ["network", "ls", "--filter", "name=^core-agent-backplane$", "--format", "{{.Name}}"],
    ["network", "inspect", "--format", "{{json .}}", "core-agent-backplane"],
  ]);
  const createCalls = [];
  await network.prepareRuntimeNetwork({ runDocker: async (args) => {
    createCalls.push(args);
    if (args[1] === "ls") return "";
    if (args[1] === "create") return "core-agent-backplane\n";
    return inspection;
  } });
  assert.deepEqual(createCalls[1], [
    "network", "create", "--driver", "bridge", "--internal",
    "--label", "core-agent.managed=runtime-v1",
    "--label", "core-agent.resource=backplane",
    "--label", "core-agent.network=core-agent-backplane",
    "core-agent-backplane",
  ]);
  const drifted = JSON.stringify({ ...JSON.parse(inspection), Internal: false });
  await assert.rejects(
    network.prepareRuntimeNetwork({ runDocker: async (args) => args[1] === "ls" ? "core-agent-backplane\n" : drifted }),
    /runtime backplane is invalid/u,
  );
});

test("database sentinel scanner inspects every public text surface without returning values", async () => {
  const moduleUrl = pathToFileURL(pathFromRoot("scripts/scan-runtime-database.mjs")).href;
  const scanner = await import(`${moduleUrl}?red=${Date.now()}`);
  const queries = [];
  let clientConfiguration;
  let ended = false;
  await scanner.scanRuntimeDatabase({
    databaseUrl: "postgresql://core_agent_ci@127.0.0.1:5432/core_agent_control",
    sentinel: "synthetic-ci-sentinel-runtime-v1",
    createClient: (configuration) => {
      clientConfiguration = configuration;
      return ({
      connect: async () => undefined,
      query: async (sql, parameters) => {
        queries.push({ sql, parameters });
        if (queries.length === 1) return { rows: [
          { table_name: "audit_events", column_name: "payload" },
          { table_name: "product_events", column_name: "event_type" },
        ] };
        return { rows: [{ present: false }] };
      },
      end: async () => { ended = true; },
      });
    },
  });
  assert.deepEqual(clientConfiguration, {
    host: "127.0.0.1",
    port: 5432,
    user: "core_agent_ci",
    database: "core_agent_control",
    connectionTimeoutMillis: 5_000,
    query_timeout: 5_000,
    statement_timeout: 5_000,
  });
  assert.equal("connectionString" in clientConfiguration, false);
  assert.equal(ended, true);
  assert.equal(queries.length, 3);
  assert.deepEqual(queries.slice(1).map((entry) => entry.parameters), [
    ["synthetic-ci-sentinel-runtime-v1"],
    ["synthetic-ci-sentinel-runtime-v1"],
  ]);
  assert(queries.slice(1).every((entry) => /select exists/u.test(entry.sql) && !/select \*/u.test(entry.sql)));
  await assert.rejects(scanner.scanRuntimeDatabase({
    databaseUrl: "postgresql://core_agent_ci@database.example/core_agent_control",
    sentinel: "synthetic-ci-sentinel-runtime-v1",
    createClient: () => assert.fail("must reject before connect"),
  }), /database sentinel scan failed/u);
  for (const databaseUrl of [
    "postgresql://core_agent_ci@127.0.0.1:5432/core_agent_control?host=remote.example",
    "postgresql://core_agent_ci:do-not-reflect@127.0.0.1:5432/core_agent_control",
    "postgresql://core_agent_ci@127.0.0.1:5432/core_agent_control#remote.example",
    "postgresql://core_agent_ci@127.0.0.1:5432/%63ore_agent_control",
    "postgresql://core_agent_ci:@127.0.0.1:5432/core_agent_control",
    "postgresql://core_agent_ci@127.0.0.1:5432/core_agent_control?",
    "postgresql://core_agent_ci@127.0.0.1:5432/core_agent_control#",
  ]) {
    await assert.rejects(scanner.scanRuntimeDatabase({
      databaseUrl,
      sentinel: "synthetic-ci-sentinel-runtime-v1",
      createClient: () => assert.fail("must reject before client construction"),
    }), (error) => error?.message === "database sentinel scan failed");
  }
});
