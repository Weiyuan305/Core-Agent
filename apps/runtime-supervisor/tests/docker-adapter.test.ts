import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, rmdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  REMOVED_RUNTIME_IMAGE_REF,
  RuntimeSupervisorClient,
  SUPERVISOR_DEADLINE_BUDGET,
  canonicalSupervisorRequestHash,
  loadProviderCatalog,
  validateSupervisorResponse,
  type ProvisionRuntimeCommandDataV1,
  type SecretMaterial,
  type SecretReference,
  type SecretStore,
  type SupervisorRequestV1,
  type SupervisorResponseV1,
} from "@core-agent/runtime-core";
import type Dockerode from "dockerode";

import { DockerRuntimeAdapter } from "../src/docker-adapter.js";
import {
  OperationJournal,
  type OperationJournalContext,
  type OperationJournalStage,
} from "../src/operation-journal.js";
import { deriveRuntimeNames, validateSupervisorPolicy } from "../src/policy.js";
import { RuntimeSupervisorServer } from "../src/server.js";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const socketTestTempRoot = process.platform === "darwin" ? "/private/tmp" : tmpdir();
const imageLock = JSON.parse(await readFile(join(repositoryRoot, "infra", "hermes", "base-images.lock.json"), "utf8")) as unknown;
const providerCatalog = loadProviderCatalog(JSON.parse(await readFile(join(repositoryRoot, "infra", "runtime", "providers.dev.json"), "utf8")));
const imageRef = `nousresearch/hermes-agent:v2026.7.30@sha256:${"5316c2c2534c49f5e1b1691e1a2115f1230d900033c3b35d1c8fc2e47352b26d"}`;
const providerSecret = "synthetic-supervisor-provider-secret-0001";
const ingressSecret = "synthetic-supervisor-ingress-secret-0002";
const imageEnvironment = [
  "/opt/hermes/.venv/bin:/usr/local/bin:/usr/bin".replace(/^/u, "PATH="),
  "HOME=/home/hermes",
  "API_SERVER_ENABLED=true",
  "API_SERVER_HOST=0.0.0.0",
  "API_SERVER_PORT=8642",
  "GATEWAY_MULTIPLEX_PROFILES=true",
];
const imageLabels = {
  "org.opencontainers.image.title": "Core-Agent Hermes Runtime",
  "org.opencontainers.image.description": "Pinned Hermes runtime distribution for Core-Agent",
  "org.opencontainers.image.vendor": "Core-Agent",
  "org.opencontainers.image.base.name": "nousresearch/hermes-agent:v2026.7.30",
};

function mergeEnvironment(image: readonly string[], overrides: readonly string[]): string[] {
  const result = [...image];
  for (const override of overrides) {
    const separator = override.indexOf("=");
    const name = separator < 0 ? override : override.slice(0, separator);
    const existing = result.findIndex((value) => value === name || value.startsWith(`${name}=`));
    if (existing < 0) result.push(override);
    else result[existing] = override;
  }
  return result;
}

function provisionData(): ProvisionRuntimeCommandDataV1 {
  const identity = { tenant_id: "tenant_a", runtime_id: "runtime_a", generation: 7 };
  return {
    protocol_version: 1,
    operation_id: "operation_provision_a",
    kind: "provision",
    runtime: {
      ...identity,
      image_ref: imageRef,
      platform: "linux/amd64",
      volume_ref: deriveRuntimeNames(identity).volume,
      ingress_secret_ref: { reference_id: "ingress_a", version: 1, purpose: "hermes_ingress" },
      profiles: [{
        profile_id: "profile_a",
        hermes_profile_ref: "profile_a",
        description: "Synthetic consultant",
        provider_config_id: "tokenhub-main",
        provider_base_url: "https://tokenhub.infplacex.com/v1/chat/completions",
        model_id: "cywx/gpt-5.6-sol",
        provider_secret_ref: { reference_id: "provider_tokenhub_main", version: 1, purpose: "model_provider" },
      }],
    },
  };
}

function signed(data = provisionData()) {
  return { ...data, request_hash: canonicalSupervisorRequestHash(data) };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

async function assertCanonicalPendingJournal(
  journalRoot: string,
  request: SupervisorRequestV1,
  stage: OperationJournalStage,
  allowedOtherOperationIds: readonly string[] = [],
): Promise<void> {
  const digest = createHash("sha256").update(request.operation_id).digest("hex");
  const path = join(journalRoot, `${digest}.json`);
  const names = await readdir(journalRoot);
  const expectedJsonNames = [request.operation_id, ...allowedOtherOperationIds]
    .map((operationId) => `${createHash("sha256").update(operationId).digest("hex")}.json`)
    .sort();
  assert.deepEqual(names.filter((name) => name.endsWith(".json")).sort(), expectedJsonNames);
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  const payload = await readFile(path, "utf8");
  const record = JSON.parse(payload) as Record<string, unknown>;
  assert.deepEqual(record, {
    operation_id: request.operation_id,
    protocol_version: 1,
    request_hash: request.request_hash,
    stage,
    state: "pending",
  });
  assert.equal(payload, `${canonicalJson(record)}\n`);
  assert.equal("completed_at" in record, false);
  assert.equal("response" in record, false);
}

async function waitForPendingStage(path: string, expected: OperationJournalStage): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    try {
      const record = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      if (record.state === "pending" && record.stage === expected) return;
    } catch {
      // The journal write can still be in flight.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for pending journal stage ${expected}`);
}

function manifestFor(request = signed()): unknown {
  const profiles = [...request.runtime.profiles]
    .sort((left, right) => left.profile_id.localeCompare(right.profile_id))
    .map((profile) => ({
      profile_id: profile.profile_id,
      hermes_profile_ref: profile.hermes_profile_ref,
      description: profile.description,
      provider_base_url: profile.provider_base_url,
      model_id: profile.model_id,
      provider_secret_file: `/run/core-agent/secrets/provider-${createHash("sha256").update(profile.profile_id).update("\0").digest("hex").slice(0, 32)}`,
    }));
  const fields = {
    bundle_version: 1,
    tenant_id: request.runtime.tenant_id,
    runtime_id: request.runtime.runtime_id,
    generation: request.runtime.generation,
    image_ref: request.runtime.image_ref,
    profiles,
  };
  return {
    bundle_version: 1,
    tenant_id: request.runtime.tenant_id,
    runtime_id: request.runtime.runtime_id,
    generation: request.runtime.generation,
    image_ref: request.runtime.image_ref,
    profiles: profiles.map(({ profile_id, hermes_profile_ref }) => ({ profile_id, hermes_profile_ref })),
    bundle_hash: `sha256:${createHash("sha256").update(canonicalJson(fields)).digest("hex")}`,
  };
}

function lifecycle(kind: "inspect" | "start" | "stop" | "restart" | "delete", operationId: string) {
  const data = {
    protocol_version: 1 as const,
    operation_id: operationId,
    kind,
    tenant_id: "tenant_a",
    runtime_id: "runtime_a",
    generation: 7,
  };
  return { ...data, request_hash: canonicalSupervisorRequestHash(data) };
}

class FakeMaterial implements SecretMaterial {
  public released = false;
  readonly #value: string;

  public constructor(
    public readonly reference: SecretReference,
    value: string,
  ) {
    this.#value = value;
  }

  public text(): string {
    if (this.released) throw new Error("released");
    return this.#value;
  }

  public withBytes<T>(consumer: (bytes: Uint8Array) => T): T {
    if (this.released) throw new Error("released");
    return consumer(Buffer.from(this.#value, "utf8"));
  }

  public release(): void {
    this.released = true;
  }
}

class FakeSecretStore implements SecretStore {
  public readonly materials: FakeMaterial[] = [];

  public async get(reference: SecretReference): Promise<SecretMaterial> {
    const material = new FakeMaterial(
      reference,
      reference.purpose === "hermes_ingress" ? ingressSecret : providerSecret,
    );
    this.materials.push(material);
    return material;
  }
}

function missing(): Error & { code: number } {
  return Object.assign(new Error("not found"), { code: 404 });
}

class FakeContainer {
  public running = false;
  public removed = false;
  public readonly actions: string[] = [];
  public mountsOverride: readonly unknown[] | undefined;

  public constructor(
    readonly docker: FakeDocker,
    public readonly name: string,
    public options?: Dockerode.ContainerCreateOptions,
  ) {}

  public async inspect(options?: { readonly abortSignal?: AbortSignal }): Promise<unknown> {
    this.docker.cancellationSignals.push({ operation: `inspect:${this.name}`, signal: options?.abortSignal });
    if (this.docker.failedInspectionNames.has(this.name)) throw new Error("synthetic uncertain container inspection");
    if (this.options === undefined && this.name.startsWith("core-agent-runtime-")) {
      this.docker.gatewayInspections += 1;
      this.docker.markGatewayInspection?.();
      if (this.docker.gatewayInspectionBarrier !== undefined) await this.docker.gatewayInspectionBarrier;
    }
    if (this.options === undefined || this.removed) throw missing();
    const network = this.options.HostConfig?.NetworkMode;
    const configuredNetworks = Object.keys(this.options.NetworkingConfig?.EndpointsConfig ?? {});
    const networkNames = configuredNetworks.length === 0 && network !== "none" ? [String(network)] : configuredNetworks;
    return {
      Id: `id-${this.name}`,
      Name: `/${this.name}`,
      Config: {
        Image: this.options.Image,
        User: this.options.User,
        Labels: {
          ...(this.docker.mergeImageConfiguration ? imageLabels : {}),
          ...this.options.Labels,
        },
        Env: this.docker.mergeImageConfiguration
          ? mergeEnvironment(imageEnvironment, this.options.Env ?? [])
          : this.options.Env ?? [],
        Entrypoint: this.options.Entrypoint ?? [],
        Cmd: this.options.Cmd ?? [],
        ExposedPorts: this.options.ExposedPorts ?? {},
        Healthcheck: this.options.Healthcheck,
      },
      HostConfig: this.options.HostConfig,
      Mounts: this.mountsOverride ?? (this.options.HostConfig?.Binds ?? []).map((bind) => {
        const [source, destination] = bind.split(":");
        return {
          Type: source?.startsWith("core-agent-") ? "volume" : "bind",
          Name: source?.startsWith("core-agent-") ? source : undefined,
          Source: source,
          Destination: destination,
          RW: !bind.endsWith(":ro"),
        };
      }),
      NetworkSettings: {
        Networks: network === "none" ? {} : {
          ...Object.fromEntries(networkNames.map((name) => [
            name,
            { IPAddress: name === "core-agent-backplane" ? "172.30.0.7" : "172.31.0.7" },
          ])),
          ...(this.docker.attachExternalNetwork && this.options.Labels?.["core-agent.resource"] === "runtime"
            ? { external: { IPAddress: "192.0.2.7" } }
            : {}),
        },
      },
      State: {
        Status: this.running ? "running" : "exited",
        Running: this.running,
        ExitCode: 0,
        Health: this.running ? { Status: "healthy" } : undefined,
      },
    };
  }

  public async start(options?: { readonly abortSignal?: AbortSignal }): Promise<void> {
    this.docker.cancellationSignals.push({ operation: `start:${this.name}`, signal: options?.abortSignal });
    this.actions.push("start");
    this.docker.mutations.push(`start:${this.name}`);
    if (this.options?.Labels?.["core-agent.resource"] === "runtime" && this.docker.abortRejectingGatewayStart !== undefined) {
      const uncertain = this.docker.abortRejectingGatewayStart;
      uncertain.markEntered();
      await new Promise<void>((_resolve, reject) => {
        const onAbort = (): void => {
          void uncertain.releaseLateMutation.then(() => {
            this.running = true;
            this.docker.mutations.push(`late-start:${this.name}`);
            uncertain.markLateMutation();
          });
          reject(new Error("synthetic local Docker request abort"));
        };
        if (options?.abortSignal?.aborted === true) onAbort();
        else options?.abortSignal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    if (this.options?.Labels?.["core-agent.resource"] === "runtime" && this.docker.failGatewayStart) {
      throw new Error("gateway start failed with untrusted details");
    }
    if (this.options?.Labels?.["core-agent.resource"] === "runtime" && this.docker.gatewayStartError !== undefined) {
      if (this.docker.applyGatewayStartBeforeError) {
        this.running = true;
        this.docker.markGatewayStartApplied?.();
      }
      throw this.docker.gatewayStartError;
    }
    this.running = true;
    const failure = this.docker.responseLessMutationErrors.get("start");
    if (failure !== undefined) throw failure;
  }

  public async stop(options?: { readonly abortSignal?: AbortSignal }): Promise<void> {
    this.docker.cancellationSignals.push({ operation: `stop:${this.name}`, signal: options?.abortSignal });
    this.actions.push("stop");
    this.docker.mutations.push(`stop:${this.name}`);
    this.running = false;
    const failure = this.docker.responseLessMutationErrors.get("stop");
    if (failure !== undefined) throw failure;
  }

  public async restart(options?: { readonly abortSignal?: AbortSignal }): Promise<void> {
    this.docker.cancellationSignals.push({ operation: `restart:${this.name}`, signal: options?.abortSignal });
    this.actions.push("restart");
    this.docker.mutations.push(`restart:${this.name}`);
    this.running = true;
    const failure = this.docker.responseLessMutationErrors.get("restart");
    if (failure !== undefined) throw failure;
  }

  public async wait(options?: { readonly abortSignal?: AbortSignal }): Promise<{ StatusCode: number }> {
    this.docker.cancellationSignals.push({ operation: `wait:${this.name}`, signal: options?.abortSignal });
    this.actions.push("wait");
    const resource = this.options?.Labels?.["core-agent.resource"];
    if (resource === this.docker.blockedHelperResource && this.docker.helperWaitBarrier !== undefined) {
      this.docker.markHelperWaitEntered?.();
      await this.docker.helperWaitBarrier;
      if (!this.removed) this.docker.helperLateMutations += 1;
    }
    if (this.options?.Labels?.["core-agent.resource"] === "runtime-manifest-verifier") {
      const outputBind = this.options.HostConfig?.Binds?.find((bind) => bind.endsWith(":/run/core-agent/output"));
      if (outputBind === undefined) throw new Error("missing verifier output bind");
      const outputDirectory = this.docker.localPath(outputBind.slice(0, -":/run/core-agent/output".length));
      await writeFile(
        join(outputDirectory, "manifest.json"),
        this.docker.manifestRawOverride
          ?? `${canonicalJson(this.docker.manifestOverride ?? manifestFor())}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
    }
    return { StatusCode: this.docker.initializerExitCode };
  }

  public async logs(options?: { readonly abortSignal?: AbortSignal }): Promise<Buffer> {
    this.docker.cancellationSignals.push({ operation: `logs:${this.name}`, signal: options?.abortSignal });
    return Buffer.from(this.docker.initializerLogs);
  }

  public async remove(options?: Dockerode.ContainerRemoveOptions & { readonly abortSignal?: AbortSignal }): Promise<void> {
    this.docker.cancellationSignals.push({ operation: `remove:${this.name}`, signal: options?.abortSignal });
    this.actions.push(`remove:${JSON.stringify(options ?? {})}`);
    this.docker.mutations.push(`remove:${this.name}`);
    const resource = this.options?.Labels?.["core-agent.resource"];
    if (
      this.docker.rejectAbortedHelperRemove
      && (resource === "runtime-initializer" || resource === "runtime-manifest-verifier")
      && options?.abortSignal?.aborted === true
    ) {
      throw new Error("synthetic aborted helper removal");
    }
    if (resource !== undefined && this.docker.failedRemovals.has(resource)) {
      throw new Error("synthetic uncertain container removal");
    }
    this.removed = true;
    this.docker.containers.delete(this.name);
    const responseLessFailure = this.docker.responseLessMutationErrors.get("remove");
    if (responseLessFailure !== undefined) throw responseLessFailure;
    if (resource !== undefined && this.docker.failAbsenceInspectionAfterRemoval.has(resource)) {
      this.docker.failedInspectionNames.add(this.name);
    }
  }
}

class FakeVolume {
  public constructor(readonly docker: FakeDocker, readonly name: string) {}

  public async inspect(options?: { readonly abortSignal?: AbortSignal }): Promise<unknown> {
    this.docker.cancellationSignals.push({ operation: `inspect-volume:${this.name}`, signal: options?.abortSignal });
    const value = this.docker.volumes.get(this.name);
    if (value === undefined) throw missing();
    return value;
  }
}

class FakeNetwork {
  public constructor(readonly docker: FakeDocker, readonly name: string) {}

  public async inspect(options?: { readonly abortSignal?: AbortSignal }): Promise<unknown> {
    this.docker.cancellationSignals.push({ operation: `inspect-network:${this.name}`, signal: options?.abortSignal });
    const value = this.docker.networks.get(this.name);
    if (value === undefined) throw missing();
    return value;
  }
}

class FakeImage {
  public constructor(readonly docker: FakeDocker, readonly name: string) {}

  public async inspect(options?: { readonly abortSignal?: AbortSignal }): Promise<unknown> {
    this.docker.cancellationSignals.push({ operation: `inspect-image:${this.name}`, signal: options?.abortSignal });
    if (this.name !== imageRef) throw missing();
    return {
      Config: {
        Env: [...imageEnvironment],
        Labels: { ...imageLabels },
      },
    };
  }
}

class FakeDocker {
  public readonly containers = new Map<string, FakeContainer>();
  public readonly volumes = new Map<string, unknown>();
  public readonly networks = new Map<string, unknown>();
  public readonly created: Dockerode.ContainerCreateOptions[] = [];
  public readonly mutations: string[] = [];
  public readonly stagedModes: number[] = [];
  public readonly stagedSecretNames: string[] = [];
  public initializerExitCode = 0;
  public initializerLogs = "";
  public manifestOverride: unknown;
  public manifestRawOverride: string | Uint8Array | undefined;
  public attachExternalNetwork = false;
  public failGatewayStart = false;
  public gatewayStartError: unknown;
  public applyGatewayStartBeforeError = false;
  public markGatewayStartApplied: (() => void) | undefined;
  public readonly responseLessMutationErrors = new Map<"start" | "stop" | "restart" | "remove", unknown>();
  public mergeImageConfiguration = true;
  public gatewayInspections = 0;
  public gatewayInspectionBarrier: Promise<void> | undefined;
  public markGatewayInspection: (() => void) | undefined;
  public readonly hostMappings: Array<{ readonly host: string; readonly local: string }> = [];
  public readonly cancellationSignals: Array<{ readonly operation: string; readonly signal: AbortSignal | undefined }> = [];
  public abortRejectingGatewayStart: {
    readonly markEntered: () => void;
    readonly releaseLateMutation: Promise<void>;
    readonly markLateMutation: () => void;
  } | undefined;
  public blockedHelperResource: "runtime-initializer" | "runtime-manifest-verifier" | undefined;
  public helperWaitBarrier: Promise<void> | undefined;
  public markHelperWaitEntered: (() => void) | undefined;
  public helperLateMutations = 0;
  public rejectAbortedHelperRemove = false;
  public readonly failedRemovals = new Set<string>();
  public readonly failAbsenceInspectionAfterRemoval = new Set<string>();
  public readonly failedInspectionNames = new Set<string>();

  public localPath(path: string): string {
    const mapping = this.hostMappings.find(({ host }) => path === host || path.startsWith(`${host}/`));
    return mapping === undefined ? path : join(mapping.local, path.slice(mapping.host.length));
  }

  public getContainer(name: string): FakeContainer {
    return this.containers.get(name) ?? new FakeContainer(this, name);
  }

  public getImage(name: string): FakeImage {
    return new FakeImage(this, name);
  }

  public async createContainer(options: Dockerode.ContainerCreateOptions): Promise<FakeContainer> {
    this.cancellationSignals.push({ operation: `create-container:${options.name ?? "missing"}`, signal: options.abortSignal });
    const name = options.name;
    if (typeof name !== "string") throw new Error("missing container name");
    if (this.containers.has(name)) throw new Error("already exists");
    const container = new FakeContainer(this, name, structuredClone(options));
    if (options.Labels?.["core-agent.resource"] === "runtime-initializer") {
      const binds = options.HostConfig?.Binds ?? [];
      const bundlePath = this.localPath(binds[1]?.split(":")[0] ?? "");
      const secretDirectory = this.localPath(binds[2]?.split(":")[0] ?? "");
      if (bundlePath === undefined || secretDirectory === undefined) throw new Error("missing staged binds");
      this.stagedModes.push((await lstat(bundlePath)).mode & 0o777);
      this.stagedModes.push((await lstat(secretDirectory)).mode & 0o777);
      for (const filename of await readdir(secretDirectory)) {
        this.stagedSecretNames.push(filename);
        this.stagedModes.push((await lstat(join(secretDirectory, filename))).mode & 0o777);
      }
    }
    this.containers.set(name, container);
    this.created.push(container.options!);
    this.mutations.push(`create:${options.name}`);
    return container;
  }

  public getVolume(name: string): FakeVolume {
    return new FakeVolume(this, name);
  }

  public async createVolume(options: { Name?: string; Labels?: Record<string, string>; abortSignal?: AbortSignal }): Promise<unknown> {
    this.cancellationSignals.push({ operation: `create-volume:${options.Name ?? "missing"}`, signal: options.abortSignal });
    const name = options.Name;
    if (typeof name !== "string") throw new Error("missing volume name");
    this.volumes.set(name, { Name: name, Labels: structuredClone(options.Labels ?? {}) });
    this.mutations.push(`volume:${name}`);
    return this.volumes.get(name);
  }

  public getNetwork(name: string): FakeNetwork {
    return new FakeNetwork(this, name);
  }

  public async createNetwork(options: Dockerode.NetworkCreateOptions): Promise<unknown> {
    this.cancellationSignals.push({ operation: `create-network:${options.Name}`, signal: options.abortSignal });
    const ipam = structuredClone(options.IPAM ?? {
      Driver: "default",
      Config: [],
    }) as { Driver?: string; Options?: Record<string, string> | null; Config?: unknown[] };
    this.networks.set(options.Name, {
      Name: options.Name,
      Driver: options.Driver,
      Internal: options.Internal,
      Attachable: options.Attachable,
      Labels: structuredClone(options.Labels ?? {}),
      Scope: "local",
      Ingress: false,
      EnableIPv6: false,
      Options: structuredClone((options as { Options?: Record<string, string> }).Options ?? {}),
      IPAM: { ...ipam, Options: ipam.Options ?? null },
    });
    this.mutations.push(`network:${options.Name}`);
    return this.networks.get(options.Name);
  }
}

let temporaryRoot: string;
let socketRoot: string;

test.beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(repositoryRoot, ".supervisor-adapter-test-"));
  socketRoot = await mkdtemp(join(socketTestTempRoot, "core-supervisor-sockets-"));
});

test.afterEach(async () => {
  await rm(socketRoot, { recursive: true, force: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await rm(temporaryRoot, { recursive: true, force: true });
      return;
    } catch (error) {
      if (
        attempt === 2
        || typeof error !== "object" || error === null
        || Object.getOwnPropertyDescriptor(error, "code")?.value !== "ENOTEMPTY"
      ) throw error;
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
});

function buildAdapter(
  docker = new FakeDocker(),
  secretStore = new FakeSecretStore(),
  timeouts: {
    readonly initializerTimeoutMs?: number;
    readonly verifierTimeoutMs?: number;
    readonly reconciliationTimeoutMs?: number;
  } = {},
) {
  const stagingRoot = join(temporaryRoot, "supervisor", "staging");
  const ingressRoot = join(temporaryRoot, "supervisor", "ingress");
  const dockerHostStagingRoot = "/srv/core-agent/runtime/staging";
  const dockerHostIngressRoot = "/srv/core-agent/runtime/ingress";
  docker.hostMappings.push(
    { host: dockerHostStagingRoot, local: stagingRoot },
    { host: dockerHostIngressRoot, local: ingressRoot },
  );
  const managedRuntimeUid = process.getuid?.() ?? 12002;
  const managedRuntimeGid = process.getgid?.() ?? 12002;
  return {
    docker,
    secretStore,
    roots: { stagingRoot, ingressRoot, dockerHostStagingRoot, dockerHostIngressRoot },
    managedUser: `${managedRuntimeUid}:${managedRuntimeGid}`,
    adapter: new DockerRuntimeAdapter({
      docker: docker as never,
      secretStore,
      imageLock,
      providerCatalog,
      stagingRoot,
      ingressRoot,
      dockerHostStagingRoot,
      dockerHostIngressRoot,
      managedRuntimeUid,
      managedRuntimeGid,
      initializerTimeoutMs: timeouts.initializerTimeoutMs ?? 1_000,
      verifierTimeoutMs: timeouts.verifierTimeoutMs ?? 1_000,
      reconciliationTimeoutMs: timeouts.reconciliationTimeoutMs ?? 25,
    } as never),
  };
}

function buildRecoveryServer(
  socketPath: string,
  journal: OperationJournal,
  adapter: DockerRuntimeAdapter,
  onExecute: () => void = () => undefined,
  onSettled: (value: unknown) => void = () => undefined,
  options: {
    readonly maximumConcurrent?: number;
    readonly execute?: (
      request: SupervisorRequestV1,
      signal: AbortSignal,
      context: OperationJournalContext,
    ) => Promise<SupervisorResponseV1>;
  } = {},
): RuntimeSupervisorServer {
  return new RuntimeSupervisorServer({
    socketPath,
    journal,
    validateRequest: (value) => validateSupervisorPolicy(value, { imageLock, providerCatalog }),
    execute: async (...args: unknown[]) => {
      onExecute();
      const [request, signal, context] = args as [SupervisorRequestV1, AbortSignal, OperationJournalContext];
      try {
        const value = await (options.execute ?? ((value, operationSignal, reservationContext) => (
          adapter.execute(value, operationSignal, reservationContext)
        )))(request, signal, context);
        onSettled(value);
        return value;
      } catch (error) {
        onSettled(error);
        throw error;
      }
    },
    admissionTimeoutMs: 100,
    effectTimeoutMs: 200,
    operationTimeoutMs: 400,
    cancellationSettlementTimeoutMs: 100,
    shutdownTimeoutMs: 10,
    ...(options.maximumConcurrent === undefined ? {} : { maximumConcurrent: options.maximumConcurrent }),
  });
}

function recoveryInspect(request: ReturnType<typeof recoveryProvision>, operationId: string) {
  const data = {
    protocol_version: 1 as const,
    operation_id: operationId,
    kind: "inspect" as const,
    tenant_id: request.runtime.tenant_id,
    runtime_id: request.runtime.runtime_id,
    generation: request.runtime.generation,
  };
  return { ...data, request_hash: canonicalSupervisorRequestHash(data) };
}

function pendingPath(journalRoot: string, request: SupervisorRequestV1): string {
  const digest = createHash("sha256").update(request.operation_id).digest("hex");
  return join(journalRoot, `${digest}.json`);
}

async function writePendingJournal(
  journalRoot: string,
  request: SupervisorRequestV1,
  stage: OperationJournalStage,
): Promise<string> {
  await mkdir(journalRoot, { recursive: true, mode: 0o700 });
  const path = pendingPath(journalRoot, request);
  await writeFile(path, `${canonicalJson({
    operation_id: request.operation_id,
    protocol_version: 1,
    request_hash: request.request_hash,
    stage,
    state: "pending",
  })}\n`, { mode: 0o600 });
  return path;
}

function pendingContext(
  journalRoot: string,
  request: SupervisorRequestV1,
): { readonly context: OperationJournalContext; readonly stage: () => OperationJournalStage } {
  let stage: OperationJournalStage = "reserved";
  return {
    context: Object.freeze({
      get stage() { return stage; },
      recovered: false,
      async advance(next: OperationJournalStage): Promise<void> {
        await writePendingJournal(journalRoot, request, next);
        stage = next;
      },
    }),
    stage: () => stage,
  };
}

function recoveryProvision(index: number) {
  const identity = {
    tenant_id: `tenant_recovery_${index}`,
    runtime_id: `runtime_recovery_${index}`,
    generation: 7,
  };
  const base = provisionData();
  return signed({
    ...base,
    operation_id: `operation_recovery_provision_${index}`,
    runtime: {
      ...base.runtime,
      ...identity,
      volume_ref: deriveRuntimeNames(identity).volume,
    },
  });
}

function recoveryLifecycle(
  request: ReturnType<typeof recoveryProvision>,
  kind: "start" | "stop" | "restart" | "delete",
) {
  const data = {
    protocol_version: 1 as const,
    operation_id: `operation_recovery_${kind}`,
    kind,
    tenant_id: request.runtime.tenant_id,
    runtime_id: request.runtime.runtime_id,
    generation: request.runtime.generation,
  };
  return { ...data, request_hash: canonicalSupervisorRequestHash(data) };
}

test("adapter rejects helper deadlines outside the aggregate production budget", () => {
  assert.doesNotThrow(() => buildAdapter(new FakeDocker(), new FakeSecretStore(), {
    initializerTimeoutMs: SUPERVISOR_DEADLINE_BUDGET.initializerTimeoutMs,
    verifierTimeoutMs: SUPERVISOR_DEADLINE_BUDGET.verifierTimeoutMs,
    reconciliationTimeoutMs: SUPERVISOR_DEADLINE_BUDGET.reconciliationTimeoutMs,
  }));
  assert.throws(
    () => buildAdapter(new FakeDocker(), new FakeSecretStore(), {
      initializerTimeoutMs: SUPERVISOR_DEADLINE_BUDGET.effectTimeoutMs + 1,
    }),
    /DEPENDENCY_TIMEOUT/,
  );
  assert.throws(
    () => buildAdapter(new FakeDocker(), new FakeSecretStore(), {
      verifierTimeoutMs: SUPERVISOR_DEADLINE_BUDGET.effectTimeoutMs + 1,
    }),
    /DEPENDENCY_TIMEOUT/,
  );
  assert.throws(
    () => buildAdapter(new FakeDocker(), new FakeSecretStore(), {
      reconciliationTimeoutMs: SUPERVISOR_DEADLINE_BUDGET.effectTimeoutMs + 1,
    }),
    /DEPENDENCY_TIMEOUT/,
  );
  assert.throws(
    () => buildAdapter(new FakeDocker(), new FakeSecretStore(), { verifierTimeoutMs: 0 }),
    /DEPENDENCY_TIMEOUT/,
  );
  assert.doesNotThrow(() => buildAdapter(new FakeDocker(), new FakeSecretStore(), {
    initializerTimeoutMs: 29_000,
    verifierTimeoutMs: 30_000,
    reconciliationTimeoutMs: 10_000,
  }));
  assert.throws(
    () => buildAdapter(new FakeDocker(), new FakeSecretStore(), {
      initializerTimeoutMs: 30_000,
      verifierTimeoutMs: 30_000,
      reconciliationTimeoutMs: 10_000,
    }),
    /DEPENDENCY_TIMEOUT/,
  );
});

test("initializer and gateway use daemon-visible binds, one numeric identity, and exact split networks", async () => {
  const { adapter, docker, secretStore, roots, managedUser } = buildAdapter();
  const request = signed();
  const observation = await adapter.provision(request);

  assert.equal(observation.lifecycle, "running");
  assert.equal(docker.created.length, 3);
  const initializer = docker.created[0]!;
  const verifier = docker.created[1]!;
  const gateway = docker.created[2]!;
  assert.equal(initializer.User, managedUser);
  assert.deepEqual(initializer.Env, ["HOME=/opt/data"]);
  assert.equal(initializer.HostConfig?.NetworkMode, "none");
  assert.deepEqual(initializer.HostConfig?.CapDrop, ["ALL"]);
  assert.equal(initializer.HostConfig?.ReadonlyRootfs, true);
  assert.equal(initializer.HostConfig?.Binds?.some((bind) => bind.includes("docker.sock")), false);
  assert.equal(initializer.HostConfig?.AutoRemove, false);
  assert.equal(initializer.Entrypoint?.[0], "/opt/hermes/.venv/bin/python");
  assert.equal(verifier.HostConfig?.NetworkMode, "none");
  assert.equal(verifier.User, managedUser);
  assert.deepEqual(verifier.Env, ["HOME=/opt/data"]);
  assert.deepEqual(verifier.HostConfig?.CapDrop, ["ALL"]);
  assert.equal(verifier.HostConfig?.ReadonlyRootfs, true);
  assert.equal(verifier.HostConfig?.Binds?.[0]?.endsWith(":/opt/data:ro"), true);
  assert.equal(verifier.HostConfig?.Binds?.[1]?.endsWith(":/run/core-agent/output"), true);
  assert.deepEqual(gateway.Env, [
    "HOME=/opt/data",
    "API_SERVER_ENABLED=true",
    "API_SERVER_HOST=0.0.0.0",
    "API_SERVER_PORT=8642",
    "GATEWAY_MULTIPLEX_PROFILES=true",
  ]);
  assert.equal(gateway.HostConfig?.NetworkMode, "core-agent-backplane");
  assert.equal(gateway.User, managedUser);
  assert.deepEqual(Object.keys(gateway.NetworkingConfig?.EndpointsConfig ?? {}).sort(), [
    "core-agent-backplane", "core-agent-egress",
  ]);
  assert.equal(gateway.HostConfig?.Privileged, false);
  assert.deepEqual(gateway.HostConfig?.CapAdd, []);
  assert.deepEqual(gateway.HostConfig?.Devices, []);
  assert.deepEqual(gateway.HostConfig?.PortBindings, {});
  assert.equal(gateway.HostConfig?.ReadonlyRootfs, true);
  assert.deepEqual(gateway.HostConfig?.RestartPolicy, { Name: "unless-stopped" });
  assert.equal(JSON.stringify(docker.created).includes(providerSecret), false);
  assert.equal(JSON.stringify(docker.created).includes(ingressSecret), false);
  assert.equal(JSON.stringify(initializer.HostConfig?.Binds).includes("tenant_a"), false);
  assert.equal(JSON.stringify(initializer.HostConfig?.Binds).includes("runtime_a"), false);
  assert.equal(JSON.stringify(initializer.HostConfig?.Binds).includes("profile_a"), false);
  assert.deepEqual(docker.stagedModes, [0o600, 0o700, 0o600, 0o600]);
  assert.equal(docker.stagedSecretNames.length, 2);
  assert(docker.stagedSecretNames.includes("hermes_ingress"));
  assert.equal(secretStore.materials.length, 3);
  assert.equal(secretStore.materials.every((material) => material.released), true);

  assert.deepEqual(await readdir(roots.stagingRoot), []);
  const initializerBinds = initializer.HostConfig?.Binds ?? [];
  assert(initializerBinds.some((bind) => bind.startsWith(`${roots.dockerHostStagingRoot}/`)));
  assert.equal(initializerBinds.some((bind) => bind.startsWith(`${roots.stagingRoot}/`)), false);
  const ingressBind = gateway.HostConfig?.Binds?.find((bind) => bind.endsWith(":/run/secrets/hermes_ingress:ro"));
  assert(ingressBind !== undefined);
  const ingressPath = ingressBind.slice(0, -":/run/secrets/hermes_ingress:ro".length);
  assert.match(ingressPath, /^\/srv\/core-agent\/runtime\/ingress\//u);
  assert.equal(ingressPath.startsWith(roots.ingressRoot), false);
  assert.equal(await readFile(docker.localPath(ingressPath), "utf8"), ingressSecret);
  assert.equal((await stat(docker.localPath(ingressPath))).mode & 0o777, 0o600);
  assert.equal(observation.private_origin, "http://172.30.0.7:8642");
  assert.deepEqual([...docker.networks.keys()].sort(), ["core-agent-backplane", "core-agent-egress"]);
  assert.equal((docker.networks.get("core-agent-backplane") as { Internal: boolean }).Internal, true);
  assert.equal((docker.networks.get("core-agent-egress") as { Internal: boolean }).Internal, false);
  assert.deepEqual(docker.networks.get("core-agent-egress"), {
    Name: "core-agent-egress",
    Driver: "bridge",
    Internal: false,
    Attachable: false,
    Labels: {
      "core-agent.managed": "runtime-v1",
      "core-agent.resource": "egress",
      "core-agent.network": "core-agent-egress",
    },
    Scope: "local",
    Ingress: false,
    EnableIPv6: false,
    Options: { "com.docker.network.bridge.enable_ip_masquerade": "true" },
    IPAM: {
      Driver: "default",
      Options: null,
      Config: [{ Subnet: "172.31.240.0/24", Gateway: "172.31.240.1" }],
    },
  });
});

test("adapter propagates one operation AbortSignal through Docker inspection and mutation calls", async () => {
  const { adapter, docker } = buildAdapter();
  const controller = new AbortController();
  const provisioned = await adapter.execute(signed(), controller.signal);
  assert.equal(provisioned.outcome, "accepted");
  const stopped = await adapter.execute(lifecycle("stop", "operation_signal_stop"), controller.signal);
  assert.equal(stopped.outcome, "accepted");
  const restarted = await adapter.execute(lifecycle("restart", "operation_signal_restart"), controller.signal);
  assert.equal(restarted.outcome, "accepted");
  const deleted = await adapter.execute(lifecycle("delete", "operation_signal_delete"), controller.signal);
  assert.equal(deleted.outcome, "accepted");

  assert(docker.cancellationSignals.length > 20);
  const helperCleanup = docker.cancellationSignals.filter(({ signal }) => signal !== controller.signal);
  assert(helperCleanup.length >= 4);
  assert.equal(helperCleanup.every(({ operation, signal }) => (
    signal !== undefined
    && (operation.startsWith("remove:core-agent-runtime-") || operation.startsWith("inspect:core-agent-runtime-"))
    && (operation.includes("-initializer-") || operation.endsWith("-manifest"))
  )), true);
  assert.equal(
    docker.cancellationSignals
      .filter((entry) => !helperCleanup.includes(entry))
      .every(({ signal }) => signal === controller.signal),
    true,
  );
});

test("an aborted helper is independently removed and proven absent before a terminal response", async () => {
  for (const resource of ["runtime-initializer", "runtime-manifest-verifier"] as const) {
    const docker = new FakeDocker();
    docker.blockedHelperResource = resource;
    docker.rejectAbortedHelperRemove = true;
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    docker.markHelperWaitEntered = markEntered;
    let releaseWait!: () => void;
    docker.helperWaitBarrier = new Promise<void>((resolve) => { releaseWait = resolve; });
    const { adapter } = buildAdapter(docker, new FakeSecretStore(), { initializerTimeoutMs: 1_000 });
    const controller = new AbortController();
    const response = adapter.execute(signed(), controller.signal);
    await entered;
    controller.abort();
    const terminal = await Promise.race([
      response,
      new Promise<"still-pending">((resolve) => setTimeout(() => resolve("still-pending"), 100)),
    ]);
    assert.notEqual(terminal, "still-pending");
    assert.equal(typeof terminal === "object" && terminal.outcome, "failed");
    const helper = [...docker.containers.values()].find((container) => container.options?.Labels?.["core-agent.resource"] === resource);
    assert.equal(helper, undefined);
    releaseWait();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(docker.helperLateMutations, 0);
    const cleanupSignals = docker.cancellationSignals.filter(({ operation }) => operation.startsWith("remove:")).map(({ signal }) => signal);
    assert(cleanupSignals.some((signal) => signal !== undefined && signal !== controller.signal));
  }
});

test("an uncertain timed-out helper cleanup never becomes a durable terminal journal response", async () => {
  for (const resource of ["runtime-initializer", "runtime-manifest-verifier"] as const) {
    const docker = new FakeDocker();
    docker.blockedHelperResource = resource;
    docker.failedRemovals.add(resource);
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    docker.markHelperWaitEntered = markEntered;
    let releaseWait!: () => void;
    docker.helperWaitBarrier = new Promise<void>((resolve) => { releaseWait = resolve; });
    const { adapter } = buildAdapter(docker, new FakeSecretStore(), {
      initializerTimeoutMs: 5,
      reconciliationTimeoutMs: 10,
    });
    const journalDirectory = join(temporaryRoot, `journal-${resource}`);
    const journal = new OperationJournal({ directory: journalDirectory });
    const request = signed({ ...provisionData(), operation_id: `operation_${resource}_uncertain` });
    let settled = false;
    const pending = journal.run(request, (reserved) => adapter.execute(reserved)).finally(() => { settled = true; });
    await entered;
    const boundary = await Promise.race([
      pending,
      new Promise<"still-pending">((resolve) => setTimeout(() => resolve("still-pending"), 50)),
    ]);
    assert.equal(boundary, "still-pending");
    assert.equal(settled, false);
    await assertCanonicalPendingJournal(journalDirectory, request, "reserved");
    releaseWait();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(docker.helperLateMutations, 1);
    assert.equal(settled, false);
  }
});

test("an uncertain helper absence inspection cannot produce a durable terminal response", async () => {
  for (const resource of ["runtime-initializer", "runtime-manifest-verifier"] as const) {
    const docker = new FakeDocker();
    docker.blockedHelperResource = resource;
    docker.failAbsenceInspectionAfterRemoval.add(resource);
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    docker.markHelperWaitEntered = markEntered;
    let releaseWait!: () => void;
    docker.helperWaitBarrier = new Promise<void>((resolve) => { releaseWait = resolve; });
    const { adapter } = buildAdapter(docker, new FakeSecretStore(), {
      initializerTimeoutMs: 5,
      verifierTimeoutMs: 5,
      reconciliationTimeoutMs: 10,
    });
    const journalDirectory = join(temporaryRoot, `journal-${resource}-inspect`);
    const journal = new OperationJournal({ directory: journalDirectory });
    const request = signed({ ...provisionData(), operation_id: `operation_${resource}_inspect_uncertain` });
    let settled = false;
    const pending = journal.run(request, (reserved) => adapter.execute(reserved)).finally(() => { settled = true; });
    await entered;
    const boundary = await Promise.race([
      pending,
      new Promise<"still-pending">((resolve) => setTimeout(() => resolve("still-pending"), 50)),
    ]);
    assert.equal(boundary, "still-pending");
    assert.equal(settled, false);
    await assertCanonicalPendingJournal(journalDirectory, request, "reserved");
    releaseWait();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(docker.helperLateMutations, 0);
    assert.equal(settled, false);
  }
});

test("uncertain gateway cleanup remains non-terminal until restart reconciliation", async () => {
  const docker = new FakeDocker();
  docker.failGatewayStart = true;
  docker.failedRemovals.add("runtime");
  const { adapter } = buildAdapter(docker, new FakeSecretStore(), { reconciliationTimeoutMs: 10 });
  const journalDirectory = join(temporaryRoot, "journal-gateway-cleanup");
  const journal = new OperationJournal({ directory: journalDirectory });
  const request = signed();
  let settled = false;
  const pending = journal.run(request, (reserved) => adapter.execute(reserved)).finally(() => { settled = true; });
  await waitForPendingStage(pendingPath(journalDirectory, request), "reserved");
  const boundary = await Promise.race([
    pending,
    new Promise<"still-pending">((resolve) => setTimeout(() => resolve("still-pending"), 50)),
  ]);
  assert.equal(boundary, "still-pending");
  assert.equal(settled, false);
  await assertCanonicalPendingJournal(journalDirectory, request, "reserved");
});

test("restart reconciles exact helper residues and rejects drift before removal", async () => {
  const first = buildAdapter();
  const request = signed();
  await first.adapter.provision(request);
  const helperOptions = first.docker.created.filter(({ Labels }) => (
    Labels?.["core-agent.resource"] === "runtime-initializer"
    || Labels?.["core-agent.resource"] === "runtime-manifest-verifier"
  ));
  const initializerBinds = helperOptions[0]!.HostConfig!.Binds!;
  const bundleHostPath = initializerBinds[1]!.slice(0, -":/run/core-agent/bootstrap/bundle.json:ro".length);
  const operationStage = dirname(first.docker.localPath(bundleHostPath));
  const siblingStage = join(dirname(operationStage), "operation-sibling-preserve");
  await mkdir(join(operationStage, "secrets"), { recursive: true, mode: 0o700 });
  await mkdir(join(operationStage, "output"), { mode: 0o700 });
  await writeFile(join(operationStage, "bundle.json"), "staged-bundle", { mode: 0o600 });
  await writeFile(join(operationStage, "secrets", "provider-crash"), providerSecret, { mode: 0o600 });
  await writeFile(join(operationStage, "output", "manifest.json"), "staged-output", { mode: 0o600 });
  await mkdir(siblingStage, { mode: 0o700 });
  await writeFile(join(siblingStage, "sentinel"), "preserve-sibling", { mode: 0o600 });
  for (const options of helperOptions) {
    const name = options.name!;
    first.docker.containers.set(name, new FakeContainer(first.docker, name, structuredClone(options)));
  }
  const second = buildAdapter(first.docker, new FakeSecretStore());
  const adopted = await second.adapter.provision(request);
  assert.equal(adopted.lifecycle, "running");
  assert.equal(helperOptions.every(({ name }) => !first.docker.containers.has(name!)), true);
  await assert.rejects(lstat(operationStage), { code: "ENOENT" });
  assert.equal(await readFile(join(siblingStage, "sentinel"), "utf8"), "preserve-sibling");

  const drifted = structuredClone(helperOptions[0]!);
  drifted.HostConfig!.NetworkMode = "bridge";
  first.docker.containers.set(drifted.name!, new FakeContainer(first.docker, drifted.name!, drifted));
  const mutationsBefore = [...first.docker.mutations];
  const rejectedResponse = await second.adapter.execute(request);
  assert.equal(rejectedResponse.outcome, "rejected");
  assert.deepEqual(first.docker.mutations, mutationsBefore);
});

const helperSecurityDrifts: ReadonlyArray<{
  readonly name: string;
  readonly mutate: (options: Dockerode.ContainerCreateOptions, container: FakeContainer) => void;
}> = [
  { name: "PortBindings", mutate: (options) => { options.HostConfig!.PortBindings = { "8642/tcp": [{ HostPort: "8642" }] }; } },
  { name: "PublishAllPorts", mutate: (options) => { options.HostConfig!.PublishAllPorts = true; } },
  { name: "RestartPolicy", mutate: (options) => { options.HostConfig!.RestartPolicy = { Name: "always" }; } },
  { name: "IpcMode", mutate: (options) => { options.HostConfig!.IpcMode = "host"; } },
  { name: "PidMode", mutate: (options) => { options.HostConfig!.PidMode = "host"; } },
  { name: "UTSMode", mutate: (options) => { options.HostConfig!.UTSMode = "host"; } },
  { name: "UsernsMode", mutate: (options) => { options.HostConfig!.UsernsMode = "host"; } },
  { name: "CgroupnsMode", mutate: (options) => {
    (options.HostConfig as Dockerode.HostConfig & { CgroupnsMode: string }).CgroupnsMode = "host";
  } },
  { name: "Mounts", mutate: (_options, container) => { container.mountsOverride = []; } },
];

for (const drift of helperSecurityDrifts) {
  test(`helper residue rejects ${drift.name} drift before removal`, async () => {
    const first = buildAdapter();
    const request = signed();
    await first.adapter.provision(request);
    const options = structuredClone(first.docker.created.find(({ Labels }) => (
      Labels?.["core-agent.resource"] === "runtime-initializer"
    ))!);
    const container = new FakeContainer(first.docker, options.name!, options);
    drift.mutate(options, container);
    first.docker.containers.set(options.name!, container);
    const before = [...first.docker.mutations];
    const response = await buildAdapter(first.docker, new FakeSecretStore()).adapter.execute(request);
    assert.equal(response.outcome, "rejected");
    assert.deepEqual(first.docker.mutations, before);
  });
}

test("an aborted mutating Docker request remains unsettled when the daemon can still mutate later", async () => {
  const docker = new FakeDocker();
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  let releaseLateMutation!: () => void;
  const lateMutationReleased = new Promise<void>((resolve) => { releaseLateMutation = resolve; });
  let markLateMutation!: () => void;
  const lateMutationObserved = new Promise<void>((resolve) => { markLateMutation = resolve; });
  docker.abortRejectingGatewayStart = {
    markEntered,
    releaseLateMutation: lateMutationReleased,
    markLateMutation,
  };
  const { adapter } = buildAdapter(docker);
  const controller = new AbortController();
  let settled = false;
  const pending = adapter.execute(signed(), controller.signal);
  void pending.then(
    () => { settled = true; },
    () => { settled = true; },
  );

  await entered;
  controller.abort();
  const stillPending = Symbol("still pending");
  const beforeLateMutation = await Promise.race([
    pending,
    new Promise<typeof stillPending>((resolve) => setTimeout(() => resolve(stillPending), 50)),
  ]);
  assert.equal(beforeLateMutation, stillPending);
  assert.equal(settled, false);

  releaseLateMutation();
  await lateMutationObserved;
  const afterLateMutation = await Promise.race([
    pending,
    new Promise<typeof stillPending>((resolve) => setTimeout(() => resolve(stillPending), 20)),
  ]);
  assert.equal(docker.mutations.some((mutation) => mutation.startsWith("late-start:")), true);
  assert.equal(afterLateMutation, stillPending);
  assert.equal(settled, false);
});

test("an applied gateway start followed by a response-less reset stays non-terminal and restart adopts it", async () => {
  const docker = new FakeDocker();
  let markGatewayStartApplied!: () => void;
  const gatewayStartApplied = new Promise<void>((resolve) => { markGatewayStartApplied = resolve; });
  docker.markGatewayStartApplied = markGatewayStartApplied;
  docker.gatewayStartError = Object.assign(new Error("synthetic response-less transport reset"), {
    code: "ECONNRESET",
  });
  docker.applyGatewayStartBeforeError = true;
  const request = signed();
  const { adapter } = buildAdapter(docker);
  const journalDirectory = join(temporaryRoot, "journal-transport-reset");
  const journal = new OperationJournal({ directory: journalDirectory });
  let firstSettled = false;
  const first = journal.run(request, (reserved) => adapter.execute(reserved)).finally(() => {
    firstSettled = true;
  });
  const stillPending = Symbol("still pending");

  await gatewayStartApplied;
  assert.equal(await Promise.race([
    first,
    new Promise<typeof stillPending>((resolve) => setTimeout(() => resolve(stillPending), 20)),
  ]), stillPending);
  assert.equal(firstSettled, false);
  await assertCanonicalPendingJournal(journalDirectory, request, "reserved");
  const gatewayName = deriveRuntimeNames(request.runtime).container;
  assert.equal(docker.containers.get(gatewayName)?.running, true);
  assert.equal(docker.mutations.filter((mutation) => mutation === `start:${gatewayName}`).length, 1);

  let retrySettled = false;
  const retry = journal.run(request, (reserved) => adapter.execute(reserved)).finally(() => {
    retrySettled = true;
  });
  assert.equal(await Promise.race([
    retry,
    new Promise<typeof stillPending>((resolve) => setTimeout(() => resolve(stillPending), 20)),
  ]), stillPending);
  assert.equal(retrySettled, false);
  assert.equal(docker.mutations.filter((mutation) => mutation === `start:${gatewayName}`).length, 1);

  docker.gatewayStartError = undefined;
  const restarted = buildAdapter(docker, new FakeSecretStore());
  const adopted = await restarted.adapter.provision(request);
  assert.equal(adopted.lifecycle, "running");
  assert.equal(docker.mutations.filter((mutation) => mutation === `start:${gatewayName}`).length, 1);
});

test("pending lifecycle stages recover applied response-less mutations without replay", async () => {
  const cases = ["start", "stop", "restart", "delete"] as const;
  for (const [index, kind] of cases.entries()) {
    const caseRoot = join(temporaryRoot, `lifecycle-recovery-${kind}`);
    await mkdir(caseRoot, { mode: 0o700 });
    const journalRoot = join(caseRoot, "journal");
    const socketPath = join(socketRoot, `s${index}.sock`);
    const docker = new FakeDocker();
    const first = buildAdapter(docker);
    const provisionRequest = recoveryProvision(index);
    docker.manifestOverride = manifestFor(provisionRequest);
    await first.adapter.provision(provisionRequest);
    const lifecycleRequest = recoveryLifecycle(provisionRequest, kind);
    const gatewayName = deriveRuntimeNames(provisionRequest.runtime).container;
    const gateway = docker.containers.get(gatewayName)!;
    if (kind === "start") gateway.running = false;
    const baseline = docker.mutations.length;
    const reset = Object.assign(new Error("synthetic applied response-less lifecycle reset"), {
      code: "ECONNRESET",
    });
    if (kind === "restart") {
      docker.responseLessMutationErrors.set("restart", reset);
      docker.responseLessMutationErrors.set("start", reset);
    } else {
      docker.responseLessMutationErrors.set(kind === "delete" ? "remove" : kind, reset);
    }

    const initial = pendingContext(journalRoot, lifecycleRequest);
    let initialSettled = false;
    void first.adapter.execute(lifecycleRequest, undefined, initial.context).then(
      () => { initialSettled = true; },
      () => { initialSettled = true; },
    );
    const expectedStage: OperationJournalStage = kind === "restart" ? "start_pending" : `${kind}_pending`;
    await waitForPendingStage(pendingPath(journalRoot, lifecycleRequest), expectedStage);
    assert.equal(initialSettled, false);

    await assertCanonicalPendingJournal(
      journalRoot,
      lifecycleRequest,
      expectedStage,
    );
    assert.equal(initial.stage(), expectedStage);
    const initialMutations = docker.mutations.slice(baseline);
    if (kind === "restart") {
      assert.equal(initialMutations.filter((item) => item === `stop:${gatewayName}`).length, 1);
      assert.equal(initialMutations.filter((item) => item === `start:${gatewayName}`).length, 1);
    } else {
      const mutation = kind === "delete" ? `remove:${gatewayName}` : `${kind}:${gatewayName}`;
      assert.equal(initialMutations.filter((item) => item === mutation).length, 1);
    }
    docker.responseLessMutationErrors.clear();

    const recoveredAdapter = buildAdapter(docker, new FakeSecretStore()).adapter;
    let recoveredExecutions = 0;
    let adapterSettlement: unknown;
    const recoveredServer = buildRecoveryServer(
      socketPath,
      new OperationJournal({ directory: journalRoot }),
      recoveredAdapter,
      () => { recoveredExecutions += 1; },
      (value) => { adapterSettlement = value; },
    );
    await recoveredServer.start();
    try {
      const recovered = await new RuntimeSupervisorClient({ socketPath, timeoutMs: 1_000 })
        .execute(lifecycleRequest);
      assert.equal(
        recovered.outcome,
        "accepted",
        `${kind}: executions=${recoveredExecutions} adapter=${JSON.stringify(adapterSettlement)} ${JSON.stringify(recovered)}`,
      );
    } finally {
      await recoveredServer.close();
    }

    const lifecycleMutations = docker.mutations.slice(baseline);
    if (kind === "restart") {
      assert.equal(lifecycleMutations.filter((item) => item === `restart:${gatewayName}`).length, 0);
      assert.equal(lifecycleMutations.filter((item) => item === `stop:${gatewayName}`).length, 1);
      assert.equal(lifecycleMutations.filter((item) => item === `start:${gatewayName}`).length, 1);
    } else {
      const mutation = kind === "delete" ? `remove:${gatewayName}` : `${kind}:${gatewayName}`;
      assert.equal(lifecycleMutations.filter((item) => item === mutation).length, 1);
    }
    const journalNames = await readdir(journalRoot);
    assert.equal(journalNames.filter((name) => name.endsWith(".json")).length, 1);
    assert.equal(journalNames.some((name) => name.endsWith(".guard.sqlite")), true);
  }
});

test("an admission transient retains a pending non-reserved stage for recovery", async () => {
  const caseRoot = join(temporaryRoot, "staged-admission-recovery");
  const journalRoot = join(caseRoot, "journal");
  const firstSocket = join(socketRoot, "sa1.sock");
  const recoveredSocket = join(socketRoot, "sa2.sock");
  await mkdir(caseRoot, { mode: 0o700 });
  const docker = new FakeDocker();
  const first = buildAdapter(docker);
  const provisionRequest = recoveryProvision(10);
  docker.manifestOverride = manifestFor(provisionRequest);
  await first.adapter.provision(provisionRequest);
  const target = recoveryLifecycle(provisionRequest, "start");
  const owner = recoveryInspect(provisionRequest, "operation_recovery_admission_owner");
  await writePendingJournal(journalRoot, target, "start_pending");
  const gatewayName = deriveRuntimeNames(provisionRequest.runtime).container;
  const mutationBaseline = docker.mutations.length;
  let markOwnerEntered!: () => void;
  const ownerEntered = new Promise<void>((resolve) => { markOwnerEntered = resolve; });
  let releaseOwner!: () => void;
  const ownerReleased = new Promise<void>((resolve) => { releaseOwner = resolve; });
  const firstServer = buildRecoveryServer(
    firstSocket,
    new OperationJournal({ directory: journalRoot }),
    first.adapter,
    () => undefined,
    () => undefined,
    {
      maximumConcurrent: 1,
      execute: async (request, signal, context) => {
        if (request.operation_id === owner.operation_id) {
          markOwnerEntered();
          await ownerReleased;
        }
        return first.adapter.execute(request, signal, context);
      },
    },
  );
  await firstServer.start();
  const firstClient = new RuntimeSupervisorClient({ socketPath: firstSocket, timeoutMs: 1_000 });
  const ownerResponse = firstClient.execute(owner);
  try {
    await ownerEntered;
    const transient = await firstClient.execute(target);
    assert.equal(transient.outcome, "failed");
    if (transient.outcome === "failed") assert.equal(transient.code, "DEPENDENCY_UNAVAILABLE");
    await assertCanonicalPendingJournal(journalRoot, target, "start_pending", [owner.operation_id]);
  } finally {
    releaseOwner();
    await ownerResponse.catch(() => undefined);
    await firstServer.close();
  }

  const recoveredAdapter = buildAdapter(docker, new FakeSecretStore()).adapter;
  const recoveredServer = buildRecoveryServer(
    recoveredSocket,
    new OperationJournal({ directory: journalRoot }),
    recoveredAdapter,
  );
  await recoveredServer.start();
  try {
    const recovered = await new RuntimeSupervisorClient({ socketPath: recoveredSocket, timeoutMs: 1_000 })
      .execute(target);
    assert.equal(recovered.outcome, "accepted");
  } finally {
    await recoveredServer.close();
  }
  assert.equal(
    docker.mutations.slice(mutationBaseline).filter((item) => item === `start:${gatewayName}`).length,
    0,
  );
});

test("abort while a lifecycle stage advance is blocked prevents mutation and leaves the stage recoverable", async () => {
  const docker = new FakeDocker();
  const built = buildAdapter(docker);
  const provisionRequest = signed();
  await built.adapter.provision(provisionRequest);
  const gatewayName = deriveRuntimeNames(provisionRequest.runtime).container;
  docker.containers.get(gatewayName)!.running = false;
  const startRequest = lifecycle("start", "operation_blocked_stage_advance");
  let stage: OperationJournalStage = "reserved";
  let markAdvanceEntered!: () => void;
  const advanceEntered = new Promise<void>((resolve) => { markAdvanceEntered = resolve; });
  let releaseAdvance!: () => void;
  const advanceReleased = new Promise<void>((resolve) => { releaseAdvance = resolve; });
  const context: OperationJournalContext = Object.freeze({
    get stage() { return stage; },
    recovered: false,
    async advance(next: OperationJournalStage): Promise<void> {
      markAdvanceEntered();
      await advanceReleased;
      stage = next;
    },
  });
  const controller = new AbortController();
  const baseline = docker.mutations.length;
  const pending = built.adapter.execute(startRequest, controller.signal, context);
  await advanceEntered;
  controller.abort();
  releaseAdvance();
  const aborted = await pending;
  assert.equal(aborted.outcome, "failed");
  assert.equal(stage, "start_pending");
  assert.equal(docker.mutations.slice(baseline).some((item) => item === `start:${gatewayName}`), false);

  const recoveredContext: OperationJournalContext = Object.freeze({
    stage: "start_pending",
    recovered: true,
    async advance(): Promise<void> { throw new Error("recovered start must not advance again"); },
  });
  const recovered = await built.adapter.execute(startRequest, undefined, recoveredContext);
  assert.equal(recovered.outcome, "accepted");
  assert.equal(
    docker.mutations.slice(baseline).filter((item) => item === `start:${gatewayName}`).length,
    1,
  );
});

test("restart recovers response-less stop from stop_pending without a duplicate stop", async () => {
  const caseRoot = join(temporaryRoot, "restart-stop-pending");
  const journalRoot = join(caseRoot, "journal");
  const socketPath = join(socketRoot, "rs.sock");
  await mkdir(caseRoot, { mode: 0o700 });
  const docker = new FakeDocker();
  const first = buildAdapter(docker);
  const provisionRequest = recoveryProvision(20);
  docker.manifestOverride = manifestFor(provisionRequest);
  await first.adapter.provision(provisionRequest);
  const request = recoveryLifecycle(provisionRequest, "restart");
  const gatewayName = deriveRuntimeNames(provisionRequest.runtime).container;
  const baseline = docker.mutations.length;
  docker.responseLessMutationErrors.set("stop", Object.assign(new Error("synthetic stop reset"), { code: "ECONNRESET" }));
  const initial = pendingContext(journalRoot, request);
  let initialSettled = false;
  void first.adapter.execute(request, undefined, initial.context).then(
    () => { initialSettled = true; },
    () => { initialSettled = true; },
  );
  await waitForPendingStage(pendingPath(journalRoot, request), "stop_pending");
  assert.equal(initialSettled, false);
  assert.equal(initial.stage(), "stop_pending");
  await assertCanonicalPendingJournal(journalRoot, request, "stop_pending");
  assert.equal(docker.mutations.slice(baseline).filter((item) => item === `stop:${gatewayName}`).length, 1);
  docker.responseLessMutationErrors.clear();

  const recovered = buildAdapter(docker, new FakeSecretStore()).adapter;
  const recoveredServer = buildRecoveryServer(socketPath, new OperationJournal({ directory: journalRoot }), recovered);
  await recoveredServer.start();
  try {
    assert.equal(
      (await new RuntimeSupervisorClient({ socketPath, timeoutMs: 1_000 }).execute(request)).outcome,
      "accepted",
    );
  } finally {
    await recoveredServer.close();
  }
  const mutations = docker.mutations.slice(baseline);
  assert.equal(mutations.filter((item) => item === `stop:${gatewayName}`).length, 1);
  assert.equal(mutations.filter((item) => item === `start:${gatewayName}`).length, 1);
});

test("restart recovers start_pending after a durable transition and crash before start dispatch", async () => {
  const caseRoot = join(temporaryRoot, "restart-transition-crash");
  const journalRoot = join(caseRoot, "journal");
  const socketPath = join(socketRoot, "rt.sock");
  await mkdir(caseRoot, { mode: 0o700 });
  const docker = new FakeDocker();
  const first = buildAdapter(docker);
  const provisionRequest = recoveryProvision(21);
  docker.manifestOverride = manifestFor(provisionRequest);
  await first.adapter.provision(provisionRequest);
  const request = recoveryLifecycle(provisionRequest, "restart");
  const gatewayName = deriveRuntimeNames(provisionRequest.runtime).container;
  docker.containers.get(gatewayName)!.running = false;
  const baseline = docker.mutations.length;
  await writePendingJournal(journalRoot, request, "start_pending");
  await assertCanonicalPendingJournal(journalRoot, request, "start_pending");
  assert.equal(docker.mutations.slice(baseline).filter((item) => item === `start:${gatewayName}`).length, 0);

  const recovered = buildAdapter(docker, new FakeSecretStore()).adapter;
  const recoveredServer = buildRecoveryServer(socketPath, new OperationJournal({ directory: journalRoot }), recovered);
  await recoveredServer.start();
  try {
    assert.equal(
      (await new RuntimeSupervisorClient({ socketPath, timeoutMs: 1_000 }).execute(request)).outcome,
      "accepted",
    );
  } finally {
    await recoveredServer.close();
  }
  const mutations = docker.mutations.slice(baseline);
  assert.equal(mutations.filter((item) => item === `stop:${gatewayName}`).length, 0);
  assert.equal(mutations.filter((item) => item === `start:${gatewayName}`).length, 1);
});

test("restart recovers an applied response-less start from start_pending without replay", async () => {
  const caseRoot = join(temporaryRoot, "restart-start-pending");
  const journalRoot = join(caseRoot, "journal");
  const socketPath = join(socketRoot, "ra.sock");
  await mkdir(caseRoot, { mode: 0o700 });
  const docker = new FakeDocker();
  const first = buildAdapter(docker);
  const provisionRequest = recoveryProvision(22);
  docker.manifestOverride = manifestFor(provisionRequest);
  await first.adapter.provision(provisionRequest);
  const request = recoveryLifecycle(provisionRequest, "restart");
  const gatewayName = deriveRuntimeNames(provisionRequest.runtime).container;
  const baseline = docker.mutations.length;
  docker.responseLessMutationErrors.set("start", Object.assign(new Error("synthetic start reset"), { code: "ECONNRESET" }));
  const initial = pendingContext(journalRoot, request);
  let initialSettled = false;
  void first.adapter.execute(request, undefined, initial.context).then(
    () => { initialSettled = true; },
    () => { initialSettled = true; },
  );
  await waitForPendingStage(pendingPath(journalRoot, request), "start_pending");
  assert.equal(initialSettled, false);
  assert.equal(initial.stage(), "start_pending");
  await assertCanonicalPendingJournal(journalRoot, request, "start_pending");
  assert.equal(docker.mutations.slice(baseline).filter((item) => item === `start:${gatewayName}`).length, 1);
  docker.responseLessMutationErrors.clear();

  const recovered = buildAdapter(docker, new FakeSecretStore()).adapter;
  const recoveredServer = buildRecoveryServer(socketPath, new OperationJournal({ directory: journalRoot }), recovered);
  await recoveredServer.start();
  try {
    assert.equal(
      (await new RuntimeSupervisorClient({ socketPath, timeoutMs: 1_000 }).execute(request)).outcome,
      "accepted",
    );
  } finally {
    await recoveredServer.close();
  }
  const mutations = docker.mutations.slice(baseline);
  assert.equal(mutations.filter((item) => item === `stop:${gatewayName}`).length, 1);
  assert.equal(mutations.filter((item) => item === `start:${gatewayName}`).length, 1);
});

test("every allowlisted response-less transport code stays daemon-uncertain", async () => {
  const docker = new FakeDocker();
  const request = signed();
  const initial = buildAdapter(docker);
  await initial.adapter.provision(request);
  const gatewayName = deriveRuntimeNames(request.runtime).container;
  const gateway = docker.containers.get(gatewayName)!;
  docker.applyGatewayStartBeforeError = true;
  const stillPending = Symbol("still pending");

  for (const [index, code] of ["ECONNRESET", "EPIPE", "ECONNABORTED", "ERR_STREAM_PREMATURE_CLOSE"].entries()) {
    gateway.running = false;
    let markGatewayStartApplied!: () => void;
    const gatewayStartApplied = new Promise<void>((resolve) => { markGatewayStartApplied = resolve; });
    docker.markGatewayStartApplied = markGatewayStartApplied;
    docker.gatewayStartError = Object.assign(new Error("synthetic response-less transport failure"), { code });
    const restarted = buildAdapter(docker, new FakeSecretStore());
    const pending = restarted.adapter.execute(lifecycle("start", `operation_allowlisted_transport_${index}`));
    await gatewayStartApplied;
    assert.equal(await Promise.race([
      pending,
      new Promise<typeof stillPending>((resolve) => setTimeout(() => resolve(stillPending), 20)),
    ]), stillPending);
    assert.equal(gateway.running, true);
  }
});

test("only response-less data-property transport codes are daemon-uncertain", async () => {
  let accessorReads = 0;
  const accessorError = new Error("synthetic accessor error");
  Object.defineProperty(accessorError, "code", {
    enumerable: true,
    get() {
      accessorReads += 1;
      throw new Error("code accessor must not run");
    },
  });
  const inheritedStatusError = Object.assign(new Error("synthetic inherited HTTP status"), { code: "ECONNRESET" });
  Object.setPrototypeOf(inheritedStatusError, Object.create(Error.prototype, {
    statusCode: { value: 500, enumerable: true },
  }));
  const inheritedResponseError = Object.assign(new Error("synthetic inherited response accessor"), { code: "ECONNRESET" });
  Object.setPrototypeOf(inheritedResponseError, Object.create(Error.prototype, {
    response: {
      enumerable: true,
      get() {
        accessorReads += 1;
        throw new Error("response accessor must not run");
      },
    },
  }));
  const failures: readonly unknown[] = [
    new Error("ordinary Docker failure"),
    Object.assign(new Error("connection refused before daemon acceptance"), { code: "ECONNREFUSED" }),
    Object.assign(new Error("HTTP error with a transport-shaped code"), { code: "ECONNRESET", statusCode: 500 }),
    Object.assign(new Error("Docker not found response"), { code: 404 }),
    accessorError,
    { code: "ECONNRESET" },
    inheritedStatusError,
    inheritedResponseError,
  ];

  for (const [index, failure] of failures.entries()) {
    const docker = new FakeDocker();
    docker.gatewayStartError = failure;
    const timeout = Symbol("unexpected daemon-uncertain classification");
    const response = await Promise.race([buildAdapter(docker).adapter.execute(signed({
      ...provisionData(),
      operation_id: `operation_negative_transport_${index}`,
    })), new Promise<typeof timeout>((resolve) => setTimeout(() => resolve(timeout), 1_000))]);
    assert.notEqual(response, timeout, `failure index ${index} was incorrectly left daemon-uncertain`);
    if (response === timeout) continue;
    assert.equal(response.outcome, "failed");
    if (response.outcome === "failed") assert.equal(response.code, "DEPENDENCY_UNAVAILABLE");
  }
  assert.equal(accessorReads, 0);
});

test("gateway adoption accepts only the exact Docker merge of locked-image and runtime configuration", async () => {
  const docker = new FakeDocker();
  docker.mergeImageConfiguration = true;
  const { adapter } = buildAdapter(docker);
  const request = signed();
  const observation = await adapter.provision(request);
  assert.equal(observation.lifecycle, "running");
  const gateway = docker.containers.get(deriveRuntimeNames(request.runtime).container)!;
  const inspected = await gateway.inspect() as { Config: { Env: string[]; Labels: Record<string, string> } };
  assert.equal(inspected.Config.Env.includes("PATH=/opt/hermes/.venv/bin:/usr/local/bin:/usr/bin"), true);
  assert.equal(inspected.Config.Env.includes("HOME=/opt/data"), true);
  assert.equal(inspected.Config.Labels["org.opencontainers.image.vendor"], "Core-Agent");
  assert.equal(inspected.Config.Labels["core-agent.runtime-id"], "runtime_a");

  gateway.options!.Env!.push("UNTRUSTED_EXTRA=value");
  let response = await adapter.execute(lifecycle("inspect", "operation_merged_env_drift"));
  assert.equal(response.outcome, "rejected");
  gateway.options!.Env!.pop();
  gateway.options!.Labels!["untrusted.extra"] = "value";
  response = await adapter.execute(lifecycle("inspect", "operation_merged_label_drift"));
  assert.equal(response.outcome, "rejected");
});

test("accepted adapter observations contain only the exact Supervisor response shape", async () => {
  const { adapter } = buildAdapter();
  const provisioned = await adapter.execute(signed());
  assert.doesNotThrow(() => validateSupervisorResponse(provisioned));
  const stopped = await adapter.execute(lifecycle("stop", "operation_exact_observation_stop"));
  assert.doesNotThrow(() => validateSupervisorResponse(stopped));
});

test("provision validates the fixed non-secret manifest before starting the gateway", async () => {
  const docker = new FakeDocker();
  docker.manifestOverride = { ...(manifestFor() as Record<string, unknown>), generation: 8 };
  const { adapter, secretStore } = buildAdapter(docker);

  await assert.rejects(adapter.provision(signed()), /SUPERVISOR_REJECTED/);
  assert.equal(docker.created.length, 2);
  assert.equal(docker.created.some((created) => created.Labels?.["core-agent.resource"] === "runtime"), false);
  assert.equal(secretStore.materials.length, 2);
  assert.equal(secretStore.materials.every((material) => material.released), true);
});

test("manifest verification rejects noncanonical and malformed UTF-8 bytes", async () => {
  for (const raw of [
    `${JSON.stringify(manifestFor())}\n`,
    Buffer.from([0xff, 0x0a]),
  ]) {
    const docker = new FakeDocker();
    docker.manifestRawOverride = raw;
    const { adapter } = buildAdapter(docker);
    await assert.rejects(adapter.provision(signed()), /SUPERVISOR_REJECTED/);
    assert.equal(docker.created.some((created) => created.Labels?.["core-agent.resource"] === "runtime"), false);
  }
});

test("strict adoption rejects one mismatched managed label before secrets or mutations", async () => {
  const first = buildAdapter();
  const request = signed();
  await first.adapter.provision(request);
  const names = deriveRuntimeNames(request.runtime);
  const gateway = first.docker.containers.get(names.container)!;
  gateway.options!.Labels!["core-agent.request-hash"] = `sha256:${"f".repeat(64)}`;
  const before = [...first.docker.mutations];
  const secondSecrets = new FakeSecretStore();
  const second = buildAdapter(first.docker, secondSecrets);

  await assert.rejects(second.adapter.provision(request), /SUPERVISOR_REJECTED/);
  assert.deepEqual(first.docker.mutations, before);
  assert.equal(secondSecrets.materials.length, 0);
});

test("initializer failure is bounded, releases material, and cleans the exact staging directory", async () => {
  const docker = new FakeDocker();
  docker.initializerExitCode = 17;
  docker.initializerLogs = `untrusted ${providerSecret} tenant_a /private/host/path`;
  const secretStore = new FakeSecretStore();
  const { adapter } = buildAdapter(docker, secretStore);

  await assert.rejects(
    adapter.provision(signed()),
    (error: unknown) => {
      assert(error instanceof Error);
      assert.match(error.message, /DEPENDENCY_UNAVAILABLE/);
      assert.doesNotMatch(error.message, /synthetic-supervisor|tenant_a|private\/host/);
      return true;
    },
  );
  assert.equal(secretStore.materials.every((material) => material.released), true);
  assert.deepEqual(await readdir(join(temporaryRoot, "supervisor", "staging")), []);
});

test("lifecycle operations validate the exact managed container and preserve its volume", async () => {
  const { adapter, docker } = buildAdapter();
  const request = signed();
  await adapter.provision(request);
  const names = deriveRuntimeNames(request.runtime);
  const gateway = docker.containers.get(names.container)!;
  const ingressBind = gateway.options!.HostConfig!.Binds!.find((bind) => bind.endsWith(":/run/secrets/hermes_ingress:ro"))!;
  const ingressPath = docker.localPath(ingressBind.slice(0, -":/run/secrets/hermes_ingress:ro".length));

  const stopped = await adapter.execute(lifecycle("stop", "operation_stop_a"));
  assert.equal(stopped.outcome, "accepted");
  if (stopped.outcome === "accepted") assert.equal(stopped.observation.lifecycle, "stopped");
  const started = await adapter.execute(lifecycle("start", "operation_start_a"));
  assert.equal(started.outcome, "accepted");
  const restarted = await adapter.execute(lifecycle("restart", "operation_restart_a"));
  assert.equal(restarted.outcome, "accepted");
  const inspected = await adapter.execute(lifecycle("inspect", "operation_inspect_a"));
  assert.equal(inspected.outcome, "accepted");

  const deleted = await adapter.execute(lifecycle("delete", "operation_delete_a"));
  assert.equal(deleted.outcome, "accepted");
  if (deleted.outcome === "accepted") {
    assert.equal(deleted.observation.exists, false);
    assert.equal(deleted.observation.lifecycle, "removed");
    assert.equal(deleted.observation.image_ref, REMOVED_RUNTIME_IMAGE_REF);
  }
  assert.equal(docker.volumes.has(names.volume), true);
  assert.match(gateway.actions.at(-1) ?? "", /"v":false/);
  await assert.rejects(lstat(ingressPath), { code: "ENOENT" });
});

test("provision refuses a coexisting generation and resumes an exact stopped adoption", async () => {
  const { adapter, docker, secretStore } = buildAdapter();
  const request = signed();
  await adapter.provision(request);
  const names = deriveRuntimeNames(request.runtime);
  const gateway = docker.containers.get(names.container)!;
  gateway.running = false;

  const resumed = await adapter.provision(request);
  assert.equal(resumed.lifecycle, "running");
  assert.equal(gateway.actions.filter((action) => action === "start").length, 2);

  const baseNextData = provisionData();
  const nextData = {
    ...baseNextData,
    operation_id: "operation_generation_8",
    runtime: { ...baseNextData.runtime, generation: 8 },
  };
  const before = [...docker.mutations];
  const materialsBefore = secretStore.materials.length;
  const next = await adapter.execute(signed(nextData));
  assert.equal(next.outcome, "rejected");
  assert.deepEqual(docker.mutations, before);
  assert.equal(secretStore.materials.length, materialsBefore);
});

test("delete cleans only the derived ingress credential when the container is already absent", async () => {
  const { adapter, docker } = buildAdapter();
  const request = signed();
  await adapter.provision(request);
  const names = deriveRuntimeNames(request.runtime);
  const gateway = docker.containers.get(names.container)!;
  const ingressBind = gateway.options!.HostConfig!.Binds!.find((bind) => bind.endsWith(":/run/secrets/hermes_ingress:ro"))!;
  const ingressPath = docker.localPath(ingressBind.slice(0, -":/run/secrets/hermes_ingress:ro".length));
  docker.containers.delete(names.container);

  const result = await adapter.execute(lifecycle("delete", "operation_delete_partial"));
  assert.equal(result.outcome, "accepted");
  if (result.outcome === "accepted") assert.equal(result.observation.image_ref, REMOVED_RUNTIME_IMAGE_REF);
  await assert.rejects(lstat(ingressPath), { code: "ENOENT" });
  assert.equal(docker.volumes.has(names.volume), true);
});

test("delete refuses a symlinked generation directory without touching its outside sentinel", async () => {
  const { adapter, docker } = buildAdapter();
  const request = signed();
  await adapter.provision(request);
  const names = deriveRuntimeNames(request.runtime);
  const gateway = docker.containers.get(names.container)!;
  const ingressBind = gateway.options!.HostConfig!.Binds!.find((bind) => bind.endsWith(":/run/secrets/hermes_ingress:ro"))!;
  const ingressPath = docker.localPath(ingressBind.slice(0, -":/run/secrets/hermes_ingress:ro".length));
  const generationDirectory = dirname(ingressPath);
  await rm(ingressPath);
  await rmdir(generationDirectory);
  const outside = join(temporaryRoot, "outside-ingress");
  await mkdir(outside, { mode: 0o700 });
  const sentinel = join(outside, "hermes_ingress");
  await writeFile(sentinel, "outside-sentinel", { mode: 0o600 });
  await symlink(outside, generationDirectory, "dir");
  docker.containers.delete(names.container);

  const result = await adapter.execute(lifecycle("delete", "operation_delete_symlink"));
  assert.equal(result.outcome, "rejected");
  assert.equal(await readFile(sentinel, "utf8"), "outside-sentinel");
  assert.equal((await lstat(generationDirectory)).isSymbolicLink(), true);
});

test("lifecycle refuses a network or bind mismatch before a Docker mutation", async () => {
  const { adapter, docker } = buildAdapter();
  const request = signed();
  await adapter.provision(request);
  const names = deriveRuntimeNames(request.runtime);
  const gateway = docker.containers.get(names.container)!;
  gateway.options!.HostConfig!.NetworkMode = "untrusted-network";
  const before = [...docker.mutations];

  const response = await adapter.execute(lifecycle("start", "operation_start_rejected"));
  assert.equal(response.outcome, "rejected");
  assert.deepEqual(docker.mutations, before);
});

test("lifecycle rejects a Supervisor-local ingress bind and an unapproved third network", async () => {
  for (const mutate of [
    (gateway: FakeContainer, _roots: { ingressRoot: string }, docker: FakeDocker) => {
      const binds = gateway.options!.HostConfig!.Binds!;
      const source = binds[1]!.slice(0, -":/run/secrets/hermes_ingress:ro".length);
      binds[1] = `${docker.localPath(source)}:/run/secrets/hermes_ingress:ro`;
    },
    (gateway: FakeContainer) => {
      gateway.options!.NetworkingConfig ??= { EndpointsConfig: {
        "core-agent-backplane": {},
        "core-agent-egress": {},
      } };
      gateway.options!.NetworkingConfig.EndpointsConfig!["untrusted-third-network"] = {};
    },
  ]) {
    const built = buildAdapter();
    await built.adapter.provision(signed());
    const gateway = built.docker.containers.get(deriveRuntimeNames(signed().runtime).container)!;
    mutate(gateway, built.roots, built.docker);
    const before = [...built.docker.mutations];
    const response = await built.adapter.execute(lifecycle("start", `operation_root_network_drift_${before.length}`));
    assert.equal(response.outcome, "rejected");
    assert.deepEqual(built.docker.mutations, before);
  }
});

test("lifecycle inspects exact volume, network, and secure container config before action", async () => {
  const { adapter, docker } = buildAdapter();
  const request = signed();
  await adapter.provision(request);
  const names = deriveRuntimeNames(request.runtime);
  const gateway = docker.containers.get(names.container)!;
  const originalOptions = structuredClone(gateway.options!);
  const originalVolume = structuredClone(docker.volumes.get(names.volume)!);

  gateway.options!.HostConfig!.Memory = 123;
  let before = [...docker.mutations];
  let response = await adapter.execute(lifecycle("start", "operation_bad_memory"));
  assert.equal(response.outcome, "rejected");
  assert.deepEqual(docker.mutations, before);

  gateway.options = structuredClone(originalOptions);
  const volume = docker.volumes.get(names.volume) as { Labels: Record<string, string> };
  volume.Labels["core-agent.runtime-id"] = "other_runtime";
  before = [...docker.mutations];
  response = await adapter.execute(lifecycle("restart", "operation_bad_volume"));
  assert.equal(response.outcome, "rejected");
  assert.deepEqual(docker.mutations, before);

  docker.volumes.set(names.volume, originalVolume);
  const network = docker.networks.get(names.network) as { Internal: boolean };
  network.Internal = false;
  before = [...docker.mutations];
  response = await adapter.execute(lifecycle("stop", "operation_bad_network"));
  assert.equal(response.outcome, "rejected");
  assert.deepEqual(docker.mutations, before);
});

test("lifecycle rejects unsupported or provider-restrictive egress network configuration", async () => {
  const mutations = [
    (network: Record<string, unknown>) => { network.Options = { "com.docker.network.bridge.enable_ip_masquerade": "false" }; },
    (network: Record<string, unknown>) => { network.Options = { "com.docker.network.bridge.enable_ip_masquerade": "true", extra: "true" }; },
    (network: Record<string, unknown>) => { network.IPAM = { Driver: "custom", Options: null, Config: [{ Subnet: "172.31.240.0/24", Gateway: "172.31.240.1" }] }; },
    (network: Record<string, unknown>) => { network.IPAM = { Driver: "default", Options: null, Config: [{ Subnet: "172.31.241.0/24", Gateway: "172.31.241.1" }] }; },
    (network: Record<string, unknown>) => { network.Scope = "swarm"; },
    (network: Record<string, unknown>) => { network.Ingress = true; },
    (network: Record<string, unknown>) => { network.EnableIPv6 = true; },
    (network: Record<string, unknown>) => { network.Driver = "macvlan"; },
  ];
  for (const mutate of mutations) {
    const built = buildAdapter();
    await built.adapter.provision(signed());
    mutate(built.docker.networks.get("core-agent-egress") as Record<string, unknown>);
    const before = [...built.docker.mutations];
    const result = await built.adapter.execute(lifecycle("inspect", `operation_egress_drift_${before.length}`));
    assert.equal(result.outcome, "rejected");
    assert.deepEqual(built.docker.mutations, before);
  }
});

test("lifecycle accepts Docker 29 empty egress IPAM options encoding", async () => {
  const built = buildAdapter();
  await built.adapter.provision(signed());
  const egress = built.docker.networks.get("core-agent-egress") as Record<string, unknown>;
  egress.IPAM = {
    ...(egress.IPAM as Record<string, unknown>),
    Options: {},
  };

  const result = await built.adapter.execute(lifecycle("inspect", "operation_docker29_ipam_options"));
  assert.equal(result.outcome, "accepted");
});

test("lifecycle rejects user privilege capability device and extra-network drift before action", async () => {
  const mutations = [
    (gateway: FakeContainer) => { gateway.options!.User = "root"; },
    (gateway: FakeContainer) => { gateway.options!.HostConfig!.Privileged = true; },
    (gateway: FakeContainer) => { gateway.options!.HostConfig!.CapAdd = ["SYS_ADMIN"]; },
    (gateway: FakeContainer) => { gateway.options!.HostConfig!.Devices = [{ PathOnHost: "/dev/null" }]; },
  ];
  for (const mutate of mutations) {
    const { adapter, docker } = buildAdapter();
    const provision = signed();
    await adapter.provision(provision);
    mutate(docker.containers.get(deriveRuntimeNames(provision.runtime).container)!);
    const before = [...docker.mutations];
    const result = await adapter.execute(lifecycle("delete", `operation_secure_${before.length}`));
    assert.equal(result.outcome, "rejected");
    assert.deepEqual(docker.mutations, before);
  }

  const { adapter, docker } = buildAdapter();
  await adapter.provision(signed());
  docker.attachExternalNetwork = true;
  const before = [...docker.mutations];
  const result = await adapter.execute(lifecycle("restart", "operation_external_network"));
  assert.equal(result.outcome, "rejected");
  assert.deepEqual(docker.mutations, before);
});

test("adapter serializes different operation IDs for one stable runtime identity", async () => {
  const docker = new FakeDocker();
  let entered!: () => void;
  const firstInspection = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  docker.gatewayInspectionBarrier = new Promise<void>((resolve) => { release = resolve; });
  docker.markGatewayInspection = entered;
  const { adapter } = buildAdapter(docker);
  const firstRequest = signed();
  const secondData = { ...provisionData(), operation_id: "operation_provision_b" };
  const secondRequest = signed(secondData);

  const first = adapter.execute(firstRequest);
  await firstInspection;
  const second = adapter.execute(secondRequest);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(docker.gatewayInspections, 1);
  release();
  const outcomes = await Promise.all([first, second]);
  assert.equal(docker.mutations.filter((mutation) => mutation.startsWith("volume:")).length, 1);
  assert.equal(outcomes[0].outcome, "accepted");
  assert.equal(outcomes[1].outcome, "rejected");
});

test("failed gateway startup removes the new container and derived ingress credential", async () => {
  const docker = new FakeDocker();
  docker.failGatewayStart = true;
  const { adapter } = buildAdapter(docker);
  await assert.rejects(adapter.provision(signed()), /DEPENDENCY_UNAVAILABLE/);
  const names = deriveRuntimeNames(signed().runtime);
  assert.equal(docker.containers.has(names.container), false);
  const ingressFiles = await readdir(join(temporaryRoot, "supervisor", "ingress"), { recursive: true }).catch(() => []);
  assert.deepEqual(ingressFiles, []);
  assert.equal(docker.volumes.has(names.volume), true);
});
