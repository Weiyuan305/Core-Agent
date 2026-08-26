#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import {
  createManagedRuntimeDependencies,
  runManagedRuntimeSession,
} from "./lib/managed-runtime-session.mjs";

const execFileAsync = promisify(execFile);

function emit(status, reason, extra = {}) {
  const report = Object.freeze({ status, reason, ...extra });
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return report;
}

async function dockerReady() {
  try {
    await execFileAsync("docker", ["info", "--format", "{{.ServerVersion}}"], {
      timeout: 5_000, maxBuffer: 4_096,
    });
    return true;
  } catch { return false; }
}

function resourceDigest(...parts) {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part).update("\0");
  return hash.digest("hex");
}

function createIdentifiers() {
  const suffix = randomBytes(8).toString("hex");
  return Object.freeze({
    tenantId: `synthetic-runtime-v1-${suffix}`,
    tenantDisplayName: `synthetic-runtime-v1-${suffix}`,
    actorId: `synthetic-runtime-v1-actor-${suffix}`,
    actorDisplayName: "synthetic-runtime-v1-consultant",
    membershipId: `synthetic-runtime-v1-member-${suffix}`,
    profileId: `synthetic-runtime-v1-profile-${suffix}`,
    profileDescription: "synthetic-runtime-v1-consultant",
    hermesProfileRef: `synthetic-runtime-v1-profile-${suffix}`,
    promptIdentifier: "synthetic-runtime-v1-smoke",
  });
}

async function protectedFile(path, value) {
  await writeFile(path, value, { flag: "wx", mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

async function preparePolicyFixture(baseEnvironment, identifiers) {
  const root = await mkdtemp(join(tmpdir(), "core-agent-policy-managed-"));
  await chmod(root, 0o700);
  const secretRoot = join(root, "runtime-secrets");
  await mkdir(secretRoot, { mode: 0o700 });
  await chmod(secretRoot, 0o700);
  const runtimeId = `runtime_${createHash("sha256").update(identifiers.tenantId, "utf8").digest("hex").slice(0, 32)}`;
  const workerToken = randomBytes(32).toString("base64url");
  const proofKey = randomBytes(32);
  const keyPair = generateKeyPairSync("ed25519");
  const signingKey = String(keyPair.privateKey.export({ format: "pem", type: "pkcs8" }));
  const publicKey = String(keyPair.publicKey.export({ format: "pem", type: "spki" }));
  const pluginTokens = [randomBytes(32).toString("base64url"), randomBytes(32).toString("base64url")];
  const runtimeTokens = [randomBytes(32).toString("base64url"), randomBytes(32).toString("base64url")];
  const pluginReference = `policy_plugin_${resourceDigest(identifiers.tenantId, runtimeId).slice(0, 32)}`;
  const runtimeReference = `policy_runtime_${resourceDigest(identifiers.tenantId, runtimeId, identifiers.profileId).slice(0, 32)}`;
  for (const generation of [1, 2]) {
    await protectedFile(join(secretRoot, `${pluginReference}.v${generation}`), pluginTokens[generation - 1]);
    await protectedFile(join(secretRoot, `${runtimeReference}.v${generation}`), runtimeTokens[generation - 1]);
  }
  const paths = {
    gatewayWorker: await protectedFile(join(root, "gateway-worker-token"), workerToken),
    worker: await protectedFile(join(root, "worker-token"), workerToken),
    plugins: await protectedFile(join(root, "plugin-identities.json"), JSON.stringify(pluginTokens.map((token, index) => ({
      token, tenant_id: identifiers.tenantId, runtime_container_id: runtimeId, runtime_generation: index + 1,
    })))),
    runtimes: await protectedFile(join(root, "runtime-identities.json"), JSON.stringify(runtimeTokens.map((token, index) => ({
      token, tenant_id: identifiers.tenantId, profile_id: identifiers.profileId,
      runtime_container_id: runtimeId, runtime_generation: index + 1,
    })))),
    proof: await protectedFile(join(root, "proof-key"), proofKey),
    publicKeys: await protectedFile(join(root, "trusted-context-public-keys.json"), JSON.stringify([{
      key_id: "worker-signing-v1", public_key_pem: publicKey, status: "active",
      activated_at: "2020-01-01T00:00:00.000Z",
    }])),
    signingKey: await protectedFile(join(root, "trusted-context-signing-key.pem"), signingKey),
  };
  const environment = {
    ...baseEnvironment,
    CORE_AGENT_POLICY_RUNTIME_SECRET_ROOT: secretRoot,
    CORE_AGENT_POLICY_GATEWAY_WORKER_TOKEN_FILE: paths.gatewayWorker,
    CORE_AGENT_POLICY_WORKER_TOKEN_FILE: paths.worker,
    CORE_AGENT_POLICY_PLUGIN_IDENTITIES_FILE: paths.plugins,
    CORE_AGENT_POLICY_RUNTIME_IDENTITIES_FILE: paths.runtimes,
    CORE_AGENT_POLICY_PROOF_KEY_FILE: paths.proof,
    CORE_AGENT_POLICY_TRUSTED_CONTEXT_PUBLIC_KEYS_FILE: paths.publicKeys,
    CORE_AGENT_POLICY_TRUSTED_CONTEXT_SIGNING_KEY_FILE: paths.signingKey,
  };
  const secretValues = [workerToken, ...pluginTokens, ...runtimeTokens, signingKey]
    .map((value) => Buffer.from(value, "utf8"));
  secretValues.push(Buffer.from(proofKey));
  return Object.freeze({
    environment, runtimeId, secretValues,
    async cleanup() {
      for (const value of secretValues) value.fill(0);
      proofKey.fill(0);
      await rm(root, { recursive: true, force: true });
    },
  });
}

function smokeEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => (
    key !== "CORE_AGENT_POLICY_RUNTIME_ACCEPTANCE" && !key.startsWith("CORE_AGENT_ACCEPTANCE_")
  )));
}

export async function runPolicyMcpRuntimeAcceptance(environment = process.env) {
  if (environment.CORE_AGENT_POLICY_RUNTIME_ACCEPTANCE !== "1") {
    return emit("NOT_RUN", "OPT_IN_REQUIRED");
  }
  if (!await dockerReady()) return emit("NOT_RUN", "DOCKER_DAEMON_UNAVAILABLE");
  const identifiers = createIdentifiers();
  let fixture;
  try {
    fixture = await preparePolicyFixture(smokeEnvironment(environment), identifiers);
    const dependencies = createManagedRuntimeDependencies(fixture.environment, undefined, {
      identifiers, additionalSecretValues: fixture.secretValues,
    });
    const output = await runManagedRuntimeSession({
      environment: fixture.environment, keepRuntime: false, dependencies,
      use: async ({ context, operations }) => {
        operations.stage?.("policy-bootstrap");
        const policy = await operations.bootstrapPolicyAcceptance(context);
        const runtime = await operations.pollPolicyRuntime(context, policy.expected_generation);
        operations.stage?.("policy-run");
        const conversationId = await operations.createConversation(context);
        const runId = await operations.createRun(context, conversationId,
          "Use core_agent.synthetic_profile exactly once with profile_id set to fixture. After it succeeds, reply with a short confirmation.");
        const events = await operations.readEvents(context, conversationId, runId);
        const run = await operations.queryRun(context, runId);
        if (events.eventTypes.at(-1) !== "run.completed" || events.terminal.status !== "succeeded"
          || run.status !== "succeeded") throw new Error("POLICY_RUNTIME_RUN_FAILED");
        const assistantMessageCount = await operations.countAssistantMessages(context, runId);
        const evidence = await operations.inspectPolicyAcceptance(context, runId);
        await operations.inspectRuntime(context, runtime);
        await operations.scanDatabase(context);
        return Object.freeze({
          tenant_id: context.tenantId, profile_id: context.profileId, runtime_id: context.runtimeId,
          runtime_generation: runtime.generation, run_id: runId, assistant_message_count: assistantMessageCount,
          successful_calls: evidence.successful_calls,
        });
      },
    });
    return emit("PASS", "SYNTHETIC_MANAGED_RUNTIME_READ_SUCCEEDED", output);
  } catch {
    emit("FAIL", "MANAGED_RUNTIME_POLICY_ACCEPTANCE_FAILED");
    process.exitCode = 1;
    return undefined;
  } finally {
    await fixture?.cleanup();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runPolicyMcpRuntimeAcceptance();
}
