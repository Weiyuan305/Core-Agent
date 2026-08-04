import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, rmdir, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  canonicalSupervisorRequestHash,
  loadProviderCatalog,
  type ProvisionRuntimeCommandDataV1,
  type SecretMaterial,
  type SecretReference,
  type SecretStore,
} from "@core-agent/runtime-core";
import type Dockerode from "dockerode";

import { DockerRuntimeAdapter } from "../src/docker-adapter.js";
import { deriveRuntimeNames } from "../src/policy.js";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const imageLock = JSON.parse(await readFile(join(repositoryRoot, "infra", "hermes", "base-images.lock.json"), "utf8")) as unknown;
const providerCatalog = loadProviderCatalog(JSON.parse(await readFile(join(repositoryRoot, "infra", "runtime", "providers.dev.json"), "utf8")));
const imageRef = `nousresearch/hermes-agent:v2026.7.30@sha256:${"5316c2c2534c49f5e1b1691e1a2115f1230d900033c3b35d1c8fc2e47352b26d"}`;
const providerSecret = "synthetic-supervisor-provider-secret-0001";
const ingressSecret = "synthetic-supervisor-ingress-secret-0002";

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

  public constructor(
    readonly docker: FakeDocker,
    public readonly name: string,
    public options?: Dockerode.ContainerCreateOptions,
  ) {}

  public async inspect(): Promise<unknown> {
    if (this.options === undefined && this.name.startsWith("core-agent-runtime-")) {
      this.docker.gatewayInspections += 1;
      this.docker.markGatewayInspection?.();
      if (this.docker.gatewayInspectionBarrier !== undefined) await this.docker.gatewayInspectionBarrier;
    }
    if (this.options === undefined || this.removed) throw missing();
    const network = this.options.HostConfig?.NetworkMode;
    return {
      Id: `id-${this.name}`,
      Name: `/${this.name}`,
      Config: {
        Image: this.options.Image,
        User: this.options.User,
        Labels: this.options.Labels,
        Env: this.options.Env ?? [],
        Entrypoint: this.options.Entrypoint ?? [],
        Cmd: this.options.Cmd ?? [],
        ExposedPorts: this.options.ExposedPorts ?? {},
        Healthcheck: this.options.Healthcheck,
      },
      HostConfig: this.options.HostConfig,
      Mounts: (this.options.HostConfig?.Binds ?? []).map((bind) => {
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
          [String(network)]: { IPAddress: "172.30.0.7" },
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

  public async start(): Promise<void> {
    this.actions.push("start");
    this.docker.mutations.push(`start:${this.name}`);
    if (this.options?.Labels?.["core-agent.resource"] === "runtime" && this.docker.failGatewayStart) {
      throw new Error("gateway start failed with untrusted details");
    }
    this.running = true;
  }

  public async stop(): Promise<void> {
    this.actions.push("stop");
    this.docker.mutations.push(`stop:${this.name}`);
    this.running = false;
  }

  public async restart(): Promise<void> {
    this.actions.push("restart");
    this.docker.mutations.push(`restart:${this.name}`);
    this.running = true;
  }

  public async wait(): Promise<{ StatusCode: number }> {
    this.actions.push("wait");
    if (this.options?.Labels?.["core-agent.resource"] === "runtime-manifest-verifier") {
      const outputBind = this.options.HostConfig?.Binds?.find((bind) => bind.endsWith(":/run/core-agent/output"));
      if (outputBind === undefined) throw new Error("missing verifier output bind");
      const outputDirectory = outputBind.slice(0, -":/run/core-agent/output".length);
      await writeFile(
        join(outputDirectory, "manifest.json"),
        this.docker.manifestRawOverride
          ?? `${canonicalJson(this.docker.manifestOverride ?? manifestFor())}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
    }
    return { StatusCode: this.docker.initializerExitCode };
  }

  public async logs(): Promise<Buffer> {
    return Buffer.from(this.docker.initializerLogs);
  }

  public async remove(options?: Dockerode.ContainerRemoveOptions): Promise<void> {
    this.actions.push(`remove:${JSON.stringify(options ?? {})}`);
    this.docker.mutations.push(`remove:${this.name}`);
    this.removed = true;
    this.docker.containers.delete(this.name);
  }
}

class FakeVolume {
  public constructor(readonly docker: FakeDocker, readonly name: string) {}

  public async inspect(): Promise<unknown> {
    const value = this.docker.volumes.get(this.name);
    if (value === undefined) throw missing();
    return value;
  }
}

class FakeNetwork {
  public constructor(readonly docker: FakeDocker, readonly name: string) {}

  public async inspect(): Promise<unknown> {
    const value = this.docker.networks.get(this.name);
    if (value === undefined) throw missing();
    return value;
  }
}

class FakeDocker {
  public readonly containers = new Map<string, FakeContainer>();
  public readonly volumes = new Map<string, unknown>();
  public readonly networks = new Map<string, unknown>();
  public readonly created: Dockerode.ContainerCreateOptions[] = [];
  public readonly mutations: string[] = [];
  public readonly stagedModes: number[] = [];
  public initializerExitCode = 0;
  public initializerLogs = "";
  public manifestOverride: unknown;
  public manifestRawOverride: string | Uint8Array | undefined;
  public attachExternalNetwork = false;
  public failGatewayStart = false;
  public gatewayInspections = 0;
  public gatewayInspectionBarrier: Promise<void> | undefined;
  public markGatewayInspection: (() => void) | undefined;

  public getContainer(name: string): FakeContainer {
    return this.containers.get(name) ?? new FakeContainer(this, name);
  }

  public async createContainer(options: Dockerode.ContainerCreateOptions): Promise<FakeContainer> {
    const name = options.name;
    if (typeof name !== "string") throw new Error("missing container name");
    if (this.containers.has(name)) throw new Error("already exists");
    const container = new FakeContainer(this, name, structuredClone(options));
    if (options.Labels?.["core-agent.resource"] === "runtime-initializer") {
      const binds = options.HostConfig?.Binds ?? [];
      const bundlePath = binds[1]?.split(":")[0];
      const secretDirectory = binds[2]?.split(":")[0];
      if (bundlePath === undefined || secretDirectory === undefined) throw new Error("missing staged binds");
      this.stagedModes.push((await lstat(bundlePath)).mode & 0o777);
      this.stagedModes.push((await lstat(secretDirectory)).mode & 0o777);
      for (const filename of await readdir(secretDirectory)) {
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

  public async createVolume(options: { Name?: string; Labels?: Record<string, string> }): Promise<unknown> {
    const name = options.Name;
    if (typeof name !== "string") throw new Error("missing volume name");
    this.volumes.set(name, { Name: name, Labels: structuredClone(options.Labels ?? {}) });
    this.mutations.push(`volume:${name}`);
    return this.volumes.get(name);
  }

  public getNetwork(name: string): FakeNetwork {
    return new FakeNetwork(this, name);
  }

  public async createNetwork(options: { Name: string; Driver?: string; Internal?: boolean; Attachable?: boolean; Labels?: Record<string, string> }): Promise<unknown> {
    this.networks.set(options.Name, {
      Name: options.Name,
      Driver: options.Driver,
      Internal: options.Internal,
      Attachable: options.Attachable,
      Labels: structuredClone(options.Labels ?? {}),
    });
    this.mutations.push(`network:${options.Name}`);
    return this.networks.get(options.Name);
  }
}

let temporaryRoot: string;

test.beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(repositoryRoot, ".supervisor-adapter-test-"));
});

test.afterEach(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

function buildAdapter(docker = new FakeDocker(), secretStore = new FakeSecretStore()) {
  return {
    docker,
    secretStore,
    adapter: new DockerRuntimeAdapter({
      docker: docker as never,
      secretStore,
      imageLock,
      providerCatalog,
      stagingRoot: join(temporaryRoot, "staging"),
      ingressRoot: join(temporaryRoot, "ingress"),
      initializerTimeoutMs: 1_000,
    }),
  };
}

test("initializer and gateway use exact isolated options without secret bytes", async () => {
  const { adapter, docker, secretStore } = buildAdapter();
  const request = signed();
  const observation = await adapter.provision(request);

  assert.equal(observation.lifecycle, "running");
  assert.equal(docker.created.length, 3);
  const initializer = docker.created[0]!;
  const verifier = docker.created[1]!;
  const gateway = docker.created[2]!;
  assert.equal(initializer.HostConfig?.NetworkMode, "none");
  assert.deepEqual(initializer.HostConfig?.CapDrop, ["ALL"]);
  assert.equal(initializer.HostConfig?.ReadonlyRootfs, true);
  assert.deepEqual(initializer.Env, []);
  assert.equal(initializer.HostConfig?.Binds?.some((bind) => bind.includes("docker.sock")), false);
  assert.equal(initializer.HostConfig?.AutoRemove, false);
  assert.equal(initializer.Entrypoint?.[0], "/opt/hermes/.venv/bin/python");
  assert.equal(verifier.HostConfig?.NetworkMode, "none");
  assert.deepEqual(verifier.HostConfig?.CapDrop, ["ALL"]);
  assert.equal(verifier.HostConfig?.ReadonlyRootfs, true);
  assert.equal(verifier.HostConfig?.Binds?.[0]?.endsWith(":/opt/data:ro"), true);
  assert.equal(verifier.HostConfig?.Binds?.[1]?.endsWith(":/run/core-agent/output"), true);
  assert.deepEqual(gateway.Env, [
    "API_SERVER_ENABLED=true",
    "API_SERVER_HOST=0.0.0.0",
    "API_SERVER_PORT=8642",
    "GATEWAY_MULTIPLEX_PROFILES=true",
  ]);
  assert.equal(gateway.HostConfig?.NetworkMode, "core-agent-backplane");
  assert.equal(gateway.User, "hermes");
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
  assert.deepEqual(docker.stagedModes, [0o600, 0o700, 0o600]);
  assert.equal(secretStore.materials.length, 2);
  assert.equal(secretStore.materials.every((material) => material.released), true);

  assert.deepEqual(await readdir(join(temporaryRoot, "staging")), []);
  const ingressBind = gateway.HostConfig?.Binds?.find((bind) => bind.endsWith(":/run/secrets/hermes_ingress:ro"));
  assert(ingressBind !== undefined);
  const ingressPath = ingressBind.slice(0, -":/run/secrets/hermes_ingress:ro".length);
  assert.equal(await readFile(ingressPath, "utf8"), ingressSecret);
  assert.equal((await stat(ingressPath)).mode & 0o777, 0o600);
});

test("provision validates the fixed non-secret manifest before starting the gateway", async () => {
  const docker = new FakeDocker();
  docker.manifestOverride = { ...(manifestFor() as Record<string, unknown>), generation: 8 };
  const { adapter, secretStore } = buildAdapter(docker);

  await assert.rejects(adapter.provision(signed()), /SUPERVISOR_REJECTED/);
  assert.equal(docker.created.length, 2);
  assert.equal(docker.created.some((created) => created.Labels?.["core-agent.resource"] === "runtime"), false);
  assert.equal(secretStore.materials.length, 1);
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
  assert.deepEqual(await readdir(join(temporaryRoot, "staging")), []);
});

test("lifecycle operations validate the exact managed container and preserve its volume", async () => {
  const { adapter, docker } = buildAdapter();
  const request = signed();
  await adapter.provision(request);
  const names = deriveRuntimeNames(request.runtime);
  const gateway = docker.containers.get(names.container)!;
  const ingressBind = gateway.options!.HostConfig!.Binds!.find((bind) => bind.endsWith(":/run/secrets/hermes_ingress:ro"))!;
  const ingressPath = ingressBind.slice(0, -":/run/secrets/hermes_ingress:ro".length);

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
  const ingressPath = ingressBind.slice(0, -":/run/secrets/hermes_ingress:ro".length);
  docker.containers.delete(names.container);

  const result = await adapter.execute(lifecycle("delete", "operation_delete_partial"));
  assert.equal(result.outcome, "accepted");
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
  const ingressPath = ingressBind.slice(0, -":/run/secrets/hermes_ingress:ro".length);
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
  const ingressFiles = await readdir(join(temporaryRoot, "ingress"), { recursive: true }).catch(() => []);
  assert.deepEqual(ingressFiles, []);
  assert.equal(docker.volumes.has(names.volume), true);
});
