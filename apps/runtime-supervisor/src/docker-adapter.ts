import { createHash, randomBytes } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import type Dockerode from "dockerode";

import {
  deriveManagedRuntimeNames,
  REMOVED_RUNTIME_IMAGE_REF,
  validateSupervisorRequest,
  type ProviderCatalog,
  type RuntimeObservation,
  type SecretReference,
  type SecretStore,
  type SupervisorRequestV1,
  type SupervisorResponseV1,
} from "@core-agent/runtime-core";

import { validateSupervisorPolicy } from "./policy.js";
import {
  BoundedDockerError,
  dockerFailure,
  redactDockerError,
} from "./redact-docker-error.js";

const requestHashPattern = /^sha256:[a-f0-9]{64}$/;
const maximumInitializerWaitMs = 120_000;
const managedEgressNetwork = "core-agent-egress";

interface DockerContainerLike {
  inspect(): Promise<unknown>;
  start(): Promise<unknown>;
  stop(options?: unknown): Promise<unknown>;
  restart(options?: unknown): Promise<unknown>;
  wait(options?: unknown): Promise<unknown>;
  logs(options?: unknown): Promise<Buffer | NodeJS.ReadableStream>;
  remove(options?: Dockerode.ContainerRemoveOptions): Promise<unknown>;
}

interface DockerResourceLike {
  inspect(): Promise<unknown>;
}

export interface DockerClientLike {
  getContainer(name: string): DockerContainerLike;
  createContainer(options: Dockerode.ContainerCreateOptions): Promise<DockerContainerLike>;
  getVolume(name: string): DockerResourceLike;
  createVolume(options: Dockerode.VolumeCreateOptions): Promise<unknown>;
  getNetwork(name: string): DockerResourceLike;
  createNetwork(options: Dockerode.NetworkCreateOptions): Promise<unknown>;
}

export interface DockerRuntimeAdapterOptions {
  readonly docker: DockerClientLike;
  readonly secretStore: SecretStore;
  readonly imageLock: unknown;
  readonly providerCatalog: ProviderCatalog;
  readonly stagingRoot: string;
  readonly dockerHostStagingRoot: string;
  readonly ingressRoot: string;
  readonly dockerHostIngressRoot: string;
  readonly managedRuntimeUid: number;
  readonly managedRuntimeGid: number;
  readonly initializerTimeoutMs?: number;
}

type RuntimeNames = ReturnType<typeof deriveManagedRuntimeNames>;
type ProvisionRuntimeCommandV1 = Extract<SupervisorRequestV1, { readonly kind: "provision" }>;
type LifecycleRuntimeCommandV1 = Exclude<SupervisorRequestV1, ProvisionRuntimeCommandV1>;

interface ExistingResource<T> {
  readonly handle: T;
  readonly inspection?: unknown;
}

interface HeldIngressDirectories {
  readonly root: FileHandle;
  readonly rootPath: string;
  readonly parent: FileHandle;
  readonly parentPath: string;
  readonly parentName: string;
  readonly generation: FileHandle;
  readonly generationPath: string;
  readonly generationName: string;
}

function rejected(): Error {
  return new Error("SUPERVISOR_REJECTED: Docker resource did not match managed runtime metadata");
}

function dataProperty(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) throw rejected();
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) throw rejected();
  return descriptor.value;
}

function optionalDataProperty(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) throw rejected();
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor) || !descriptor.enumerable) throw rejected();
  return descriptor.value;
}

function stringProperty(value: unknown, key: string): string {
  const item = dataProperty(value, key);
  if (typeof item !== "string") throw rejected();
  return item;
}

function booleanProperty(value: unknown, key: string): boolean {
  const item = dataProperty(value, key);
  if (typeof item !== "boolean") throw rejected();
  return item;
}

function exactStringRecord(value: unknown, expected: Readonly<Record<string, string>>): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw rejected();
  const keys = Reflect.ownKeys(value);
  const expectedKeys = Object.keys(expected);
  if (keys.length !== expectedKeys.length || keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))) {
    throw rejected();
  }
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (stringProperty(value, key) !== expectedValue) throw rejected();
  }
}

function safeStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw rejected();
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable || typeof descriptor.value !== "string") {
      throw rejected();
    }
    result.push(descriptor.value);
  }
  return result;
}

function equalStringArrays(value: unknown, expected: readonly string[]): void {
  const actual = safeStringArray(value);
  if (actual.length !== expected.length || actual.some((item, index) => item !== expected[index])) throw rejected();
}

function exactEmptyRecord(value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Reflect.ownKeys(value).length !== 0) {
    throw rejected();
  }
}

function exactNumberProperty(value: unknown, key: string, expected: number): void {
  if (dataProperty(value, key) !== expected) throw rejected();
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const descriptor = Object.getOwnPropertyDescriptor(error, "code")
    ?? Object.getOwnPropertyDescriptor(error, "statusCode");
  return descriptor !== undefined && "value" in descriptor && (descriptor.value === 404 || descriptor.value === "ENOENT");
}

function errorCode(error: unknown): unknown {
  if (typeof error !== "object" || error === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(error, "code");
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

async function inspectOptional<T extends DockerResourceLike>(handle: T): Promise<ExistingResource<T>> {
  try {
    return { handle, inspection: await handle.inspect() };
  } catch (error) {
    if (isNotFound(error)) return { handle };
    throw redactDockerError(error);
  }
}

function resourceDigest(...parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part).update("\0");
  return hash.digest("hex");
}

function operationInitializerName(containerName: string, operationId: string): string {
  return `${containerName}-initializer-${createHash("sha256").update(operationId).digest("hex").slice(0, 12)}`;
}

function runtimeLabels(request: ProvisionRuntimeCommandV1, names: RuntimeNames): Readonly<Record<string, string>> {
  return Object.freeze({
    "core-agent.managed": "runtime-v1",
    "core-agent.resource": "runtime",
    "core-agent.protocol-version": "1",
    "core-agent.tenant-id": request.runtime.tenant_id,
    "core-agent.runtime-id": request.runtime.runtime_id,
    "core-agent.generation": String(request.runtime.generation),
    "core-agent.image-ref": request.runtime.image_ref,
    "core-agent.volume": names.volume,
    "core-agent.network": names.network,
    "core-agent.request-hash": request.request_hash,
  });
}

function volumeLabels(
  request: ProvisionRuntimeCommandV1 | { readonly tenant_id: string; readonly runtime_id: string },
  names: RuntimeNames,
): Readonly<Record<string, string>> {
  const identity = "runtime" in request ? request.runtime : request;
  return Object.freeze({
    "core-agent.managed": "runtime-v1",
    "core-agent.resource": "runtime-volume",
    "core-agent.tenant-id": identity.tenant_id,
    "core-agent.runtime-id": identity.runtime_id,
    "core-agent.volume": names.volume,
  });
}

function networkLabels(name: string, resource: "backplane" | "egress"): Readonly<Record<string, string>> {
  return Object.freeze({
    "core-agent.managed": "runtime-v1",
    "core-agent.resource": resource,
    "core-agent.network": name,
  });
}

function managedUser(options: DockerRuntimeAdapterOptions): string {
  return `${options.managedRuntimeUid}:${options.managedRuntimeGid}`;
}

function dockerHostPath(localRoot: string, hostRoot: string, localPath: string): string {
  const local = resolve(localRoot);
  const host = resolve(hostRoot);
  const child = resolve(localPath);
  const suffix = relative(local, child);
  if (suffix === "" || suffix.startsWith("..") || isAbsolute(suffix)) throw rejected();
  return join(host, suffix);
}

function pathsOverlap(left: string, right: string): boolean {
  const leftToRight = relative(left, right);
  const rightToLeft = relative(right, left);
  return leftToRight === "" || (!leftToRight.startsWith("..") && !isAbsolute(leftToRight))
    || (!rightToLeft.startsWith("..") && !isAbsolute(rightToLeft));
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path, { bigint: true });
  const uid = process.getuid?.();
  if (
    uid === undefined
    || !metadata.isDirectory()
    || metadata.uid !== BigInt(uid)
    || (metadata.mode & 0o7777n) !== 0o700n
  ) throw dockerFailure("DEPENDENCY_UNAVAILABLE", "Supervisor private directory is unsafe");
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function childPath(parent: FileHandle, canonicalParent: string, name: string): string {
  return process.platform === "linux"
    ? join("/proc/self/fd", String(parent.fd), name)
    : join(canonicalParent, name);
}

async function validateProtectedDirectoryAncestors(canonicalRoot: string): Promise<void> {
  const uid = process.getuid?.();
  if (uid === undefined) throw rejected();
  let path = canonicalRoot;
  let root = true;
  while (true) {
    const metadata = await lstat(path, { bigint: true }).catch(() => { throw rejected(); });
    if (!metadata.isDirectory()) throw rejected();
    if (root) {
      if (metadata.uid !== BigInt(uid) || (metadata.mode & 0o7777n) !== 0o700n) throw rejected();
    } else if (
      (metadata.uid !== 0n && metadata.uid !== BigInt(uid))
      || (metadata.mode & 0o22n) !== 0n
    ) throw rejected();
    const parent = dirname(path);
    if (parent === path) return;
    path = parent;
    root = false;
  }
}

async function assertHeldPrivateDirectory(handle: FileHandle, namedPath: string): Promise<BigIntStats> {
  const held = await handle.stat({ bigint: true });
  const named = await lstat(namedPath, { bigint: true }).catch(() => { throw rejected(); });
  const uid = process.getuid?.();
  if (
    uid === undefined || !held.isDirectory() || held.uid !== BigInt(uid)
    || (held.mode & 0o7777n) !== 0o700n || !sameFileIdentity(held, named)
  ) throw rejected();
  return held;
}

async function writeExclusive(path: string, value: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(value, { encoding: "utf8" });
    await handle.sync();
  } catch {
    throw dockerFailure("DEPENDENCY_UNAVAILABLE", "Supervisor staged file could not be written");
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
  }
}

async function writeSecretMaterial(store: SecretStore, reference: SecretReference, path: string): Promise<void> {
  const material = await store.get(reference);
  try {
    await writeExclusive(path, material.text());
  } finally {
    material.release();
  }
}

function exactInitializerOptions(
  request: ProvisionRuntimeCommandV1,
  names: RuntimeNames,
  initializerName: string,
  bundlePath: string,
  secretDirectory: string,
  user: string,
): Dockerode.ContainerCreateOptions {
  return {
    name: initializerName,
    Image: request.runtime.image_ref,
    User: user,
    Entrypoint: ["/opt/hermes/.venv/bin/python", "/opt/core-agent/initialize.py"],
    Cmd: [
      "--bundle", "/run/core-agent/bootstrap/bundle.json",
      "--data-root", "/opt/data",
      "--manifest", "/opt/data/.core-agent/manifest.json",
    ],
    Env: [],
    Labels: { ...runtimeLabels(request, names), "core-agent.resource": "runtime-initializer" },
    HostConfig: {
      AutoRemove: false,
      NetworkMode: "none",
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      Binds: [
        `${names.volume}:/opt/data`,
        `${bundlePath}:/run/core-agent/bootstrap/bundle.json:ro`,
        `${secretDirectory}:/run/core-agent/secrets:ro`,
      ],
      Tmpfs: {
        "/tmp": "rw,noexec,nosuid,nodev,size=64m,mode=1777",
        "/run/core-agent/output": "rw,noexec,nosuid,nodev,size=16m,mode=0700",
      },
      Memory: 1_073_741_824,
      NanoCpus: 1_000_000_000,
      PidsLimit: 256,
    },
  };
}

function exactGatewayOptions(
  request: ProvisionRuntimeCommandV1,
  names: RuntimeNames,
  ingressSecretPath: string,
  user: string,
): Dockerode.ContainerCreateOptions {
  return {
    name: names.container,
    Image: request.runtime.image_ref,
    User: user,
    Entrypoint: ["/opt/core-agent/gateway-entrypoint.sh"],
    Cmd: [],
    Env: [
      "API_SERVER_ENABLED=true",
      "API_SERVER_HOST=0.0.0.0",
      "API_SERVER_PORT=8642",
      "GATEWAY_MULTIPLEX_PROFILES=true",
    ],
    Labels: { ...runtimeLabels(request, names) },
    ExposedPorts: { "8642/tcp": {} },
    HostConfig: {
      NetworkMode: names.network,
      PortBindings: {},
      Privileged: false,
      ReadonlyRootfs: true,
      CapAdd: [],
      CapDrop: ["ALL"],
      Devices: [],
      SecurityOpt: ["no-new-privileges:true"],
      Binds: [
        `${names.volume}:/opt/data`,
        `${ingressSecretPath}:/run/secrets/hermes_ingress:ro`,
      ],
      Tmpfs: {
        "/run": "rw,nosuid,nodev,size=64m,mode=0755,exec",
        "/tmp": "rw,nosuid,nodev,size=256m,mode=1777",
        "/var/tmp": "rw,nosuid,nodev,size=64m,mode=1777",
      },
      Memory: 4_294_967_296,
      NanoCpus: 2_000_000_000,
      PidsLimit: 512,
      RestartPolicy: { Name: "unless-stopped" },
    },
    NetworkingConfig: {
      EndpointsConfig: {
        [names.network]: {},
        [managedEgressNetwork]: {},
      },
    },
    Healthcheck: {
      Test: ["CMD-SHELL", "curl --fail --silent http://127.0.0.1:8642/health >/dev/null || exit 1"],
      Interval: 10_000_000_000,
      Timeout: 5_000_000_000,
      Retries: 12,
      StartPeriod: 30_000_000_000,
    },
  };
}

function exactManifestVerifierOptions(
  request: ProvisionRuntimeCommandV1,
  names: RuntimeNames,
  verifierName: string,
  outputDirectory: string,
  user: string,
): Dockerode.ContainerCreateOptions {
  return {
    name: verifierName,
    Image: request.runtime.image_ref,
    User: user,
    Entrypoint: ["/opt/hermes/.venv/bin/python"],
    Cmd: [
      "-c",
      "import os; from pathlib import Path; data=Path('/opt/data/.core-agent/manifest.json').read_bytes(); fd=os.open('/run/core-agent/output/manifest.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600); os.write(fd,data); os.fsync(fd); os.close(fd)",
    ],
    Env: [],
    Labels: { ...runtimeLabels(request, names), "core-agent.resource": "runtime-manifest-verifier" },
    HostConfig: {
      AutoRemove: false,
      NetworkMode: "none",
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      Binds: [
        `${names.volume}:/opt/data:ro`,
        `${outputDirectory}:/run/core-agent/output`,
      ],
      Tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=16m,mode=1777" },
      Memory: 134_217_728,
      NanoCpus: 500_000_000,
      PidsLimit: 32,
    },
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function expectedManifest(request: ProvisionRuntimeCommandV1): unknown {
  const profiles = [...request.runtime.profiles]
    .sort((left, right) => left.profile_id.localeCompare(right.profile_id))
    .map((profile) => ({
      profile_id: profile.profile_id,
      hermes_profile_ref: profile.hermes_profile_ref,
      description: profile.description,
      provider_base_url: profile.provider_base_url,
      model_id: profile.model_id,
      provider_secret_file: `/run/core-agent/secrets/provider-${resourceDigest(profile.profile_id).slice(0, 32)}`,
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

async function readPrivateManifest(path: string): Promise<Buffer> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    const uid = process.getuid?.();
    if (
      uid === undefined
      || !before.isFile()
      || before.uid !== BigInt(uid)
      || (before.mode & 0o7777n) !== 0o600n
      || before.size < 1n
      || before.size > 65_536n
    ) throw rejected();
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw rejected();
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const pathMetadata = await lstat(path, { bigint: true });
    if (
      before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || before.dev !== pathMetadata.dev || before.ino !== pathMetadata.ino
    ) throw rejected();
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return bytes;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("SUPERVISOR_REJECTED:")) throw error;
    throw rejected();
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
  }
}

function validateManifest(value: Buffer, request: ProvisionRuntimeCommandV1): void {
  const expected = Buffer.from(`${canonicalJson(expectedManifest(request))}\n`, "utf8");
  try {
    if (!value.equals(expected)) throw rejected();
  } finally {
    expected.fill(0);
  }
}

function validateVolumeInspection(
  value: unknown,
  request: ProvisionRuntimeCommandV1 | { readonly tenant_id: string; readonly runtime_id: string },
  names: RuntimeNames,
): void {
  if (stringProperty(value, "Name") !== names.volume) throw rejected();
  exactStringRecord(dataProperty(value, "Labels"), volumeLabels(request, names));
  // Deliberately do not read Docker's volume Mountpoint/host-path field.
}

function validateNetworkInspection(
  value: unknown,
  name: string,
  resource: "backplane" | "egress",
  internal: boolean,
): void {
  if (
    stringProperty(value, "Name") !== name
    || stringProperty(value, "Driver") !== "bridge"
    || booleanProperty(value, "Internal") !== internal
    || booleanProperty(value, "Attachable") !== false
  ) throw rejected();
  exactStringRecord(dataProperty(value, "Labels"), networkLabels(name, resource));
}

function validateGatewayInspection(
  value: unknown,
  request: ProvisionRuntimeCommandV1 | undefined,
  identity: { readonly tenant_id: string; readonly runtime_id: string; readonly generation: number },
  names: RuntimeNames,
  ingressPath: string,
  user: string,
): RuntimeObservation {
  if (stringProperty(value, "Name") !== `/${names.container}`) throw rejected();
  const config = dataProperty(value, "Config");
  const labels = dataProperty(config, "Labels");
  const requestHash = request === undefined
    ? stringProperty(labels, "core-agent.request-hash")
    : request.request_hash;
  if (!requestHashPattern.test(requestHash)) throw rejected();
  const imageRef = request === undefined
    ? stringProperty(labels, "core-agent.image-ref")
    : request.runtime.image_ref;
  const expectedLabels = runtimeLabels({
    protocol_version: 1,
    operation_id: request?.operation_id ?? "lifecycle_adoption",
    kind: "provision",
    request_hash: requestHash,
    runtime: {
      ...identity,
      image_ref: imageRef,
      platform: "linux/amd64",
      volume_ref: names.volume,
      ingress_secret_ref: { reference_id: "placeholder", version: 1, purpose: "hermes_ingress" },
      profiles: [],
    },
  }, names);
  exactStringRecord(labels, expectedLabels);
  if (stringProperty(config, "Image") !== imageRef || stringProperty(config, "User") !== user) throw rejected();
  equalStringArrays(dataProperty(config, "Env"), [
    "API_SERVER_ENABLED=true",
    "API_SERVER_HOST=0.0.0.0",
    "API_SERVER_PORT=8642",
    "GATEWAY_MULTIPLEX_PROFILES=true",
  ]);
  equalStringArrays(dataProperty(config, "Entrypoint"), ["/opt/core-agent/gateway-entrypoint.sh"]);
  equalStringArrays(dataProperty(config, "Cmd"), []);
  const exposedPorts = dataProperty(config, "ExposedPorts");
  if (typeof exposedPorts !== "object" || exposedPorts === null || Reflect.ownKeys(exposedPorts).length !== 1) throw rejected();
  exactEmptyRecord(dataProperty(exposedPorts, "8642/tcp"));

  const hostConfig = dataProperty(value, "HostConfig");
  if (
    stringProperty(hostConfig, "NetworkMode") !== names.network
    || booleanProperty(hostConfig, "Privileged") !== false
    || booleanProperty(hostConfig, "ReadonlyRootfs") !== true
  ) {
    throw rejected();
  }
  equalStringArrays(dataProperty(hostConfig, "CapAdd"), []);
  equalStringArrays(dataProperty(hostConfig, "CapDrop"), ["ALL"]);
  equalStringArrays(dataProperty(hostConfig, "Devices"), []);
  equalStringArrays(dataProperty(hostConfig, "SecurityOpt"), ["no-new-privileges:true"]);
  exactEmptyRecord(dataProperty(hostConfig, "PortBindings"));
  exactStringRecord(dataProperty(hostConfig, "Tmpfs"), {
    "/run": "rw,nosuid,nodev,size=64m,mode=0755,exec",
    "/tmp": "rw,nosuid,nodev,size=256m,mode=1777",
    "/var/tmp": "rw,nosuid,nodev,size=64m,mode=1777",
  });
  exactNumberProperty(hostConfig, "Memory", 4_294_967_296);
  exactNumberProperty(hostConfig, "NanoCpus", 2_000_000_000);
  exactNumberProperty(hostConfig, "PidsLimit", 512);
  if (stringProperty(dataProperty(hostConfig, "RestartPolicy"), "Name") !== "unless-stopped") throw rejected();
  const binds = safeStringArray(dataProperty(hostConfig, "Binds"));
  if (
    binds.length !== 2
    || binds[0] !== `${names.volume}:/opt/data`
    || binds[1] !== `${ingressPath}:/run/secrets/hermes_ingress:ro`
  ) throw rejected();

  const healthcheck = dataProperty(config, "Healthcheck");
  equalStringArrays(dataProperty(healthcheck, "Test"), [
    "CMD-SHELL",
    "curl --fail --silent http://127.0.0.1:8642/health >/dev/null || exit 1",
  ]);
  exactNumberProperty(healthcheck, "Interval", 10_000_000_000);
  exactNumberProperty(healthcheck, "Timeout", 5_000_000_000);
  exactNumberProperty(healthcheck, "Retries", 12);
  exactNumberProperty(healthcheck, "StartPeriod", 30_000_000_000);

  const state = dataProperty(value, "State");
  const running = booleanProperty(state, "Running");
  const healthValue = optionalDataProperty(state, "Health");
  const dockerHealth = healthValue === undefined ? undefined : stringProperty(healthValue, "Status");
  const health: RuntimeObservation["health"] = dockerHealth === "healthy"
    ? "healthy"
    : dockerHealth === "unhealthy"
      ? "unhealthy"
      : "unknown";
  const networks = dataProperty(dataProperty(value, "NetworkSettings"), "Networks");
  const expectedNetworks = [names.network, managedEgressNetwork];
  const actualNetworks = Reflect.ownKeys(networks as object);
  if (
    actualNetworks.length !== expectedNetworks.length
    || actualNetworks.some((key) => typeof key !== "string" || !expectedNetworks.includes(key))
  ) throw rejected();
  const network = dataProperty(networks, names.network);
  const address = stringProperty(network, "IPAddress");
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)) throw rejected();
  return {
    ...identity,
    exists: true,
    lifecycle: running ? "running" : "stopped",
    health,
    image_ref: imageRef,
    private_origin: `http://${address}:8642`,
  };
}

async function validatePersistentIngress(path: string): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(path, { bigint: true });
  } catch {
    throw rejected();
  }
  const uid = process.getuid?.();
  if (
    uid === undefined
    || !metadata.isFile()
    || metadata.uid !== BigInt(uid)
    || (metadata.mode & 0o7777n) !== 0o600n
  ) throw rejected();
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw dockerFailure("DEPENDENCY_TIMEOUT", "Docker runtime operation timed out");
  }
}

function boundedWait<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      action();
    };
    const onAbort = (): void => finish(() => {
      rejectPromise(dockerFailure("DEPENDENCY_TIMEOUT", "Docker runtime operation timed out"));
    });
    const timer = setTimeout(() => {
      finish(() => rejectPromise(dockerFailure("DEPENDENCY_TIMEOUT", "Docker initializer timed out")));
    }, timeoutMs);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) onAbort();
    promise.then(
      (value) => {
        finish(() => resolvePromise(value));
      },
      () => {
        finish(() => rejectPromise(dockerFailure("DEPENDENCY_UNAVAILABLE", "Docker initializer wait failed")));
      },
    );
  });
}

function parseWaitStatus(value: unknown): number {
  const status = dataProperty(value, "StatusCode");
  if (typeof status !== "number" || !Number.isSafeInteger(status)) {
    throw dockerFailure("DEPENDENCY_UNAVAILABLE", "Docker initializer returned an invalid status");
  }
  return status;
}

export class DockerRuntimeAdapter {
  readonly #options: DockerRuntimeAdapterOptions;
  readonly #runtimeLocks = new Map<string, Promise<void>>();

  public constructor(options: DockerRuntimeAdapterOptions) {
    if (
      options.initializerTimeoutMs !== undefined
      && (!Number.isSafeInteger(options.initializerTimeoutMs)
        || options.initializerTimeoutMs < 1
        || options.initializerTimeoutMs > maximumInitializerWaitMs)
    ) throw dockerFailure("DEPENDENCY_TIMEOUT", "Initializer timeout configuration is invalid");
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (
      uid === undefined || gid === undefined
      || options.managedRuntimeUid !== uid || options.managedRuntimeGid !== gid
      || resolve(options.stagingRoot) !== options.stagingRoot
      || resolve(options.ingressRoot) !== options.ingressRoot
      || resolve(options.dockerHostStagingRoot) !== options.dockerHostStagingRoot
      || resolve(options.dockerHostIngressRoot) !== options.dockerHostIngressRoot
      || pathsOverlap(options.stagingRoot, options.ingressRoot)
      || pathsOverlap(options.dockerHostStagingRoot, options.dockerHostIngressRoot)
    ) throw rejected();
    this.#options = options;
  }

  public async execute(value: unknown, signal?: AbortSignal): Promise<SupervisorResponseV1> {
    let request: SupervisorRequestV1;
    try {
      request = validateSupervisorPolicy(value, this.#options);
    } catch {
      return {
        protocol_version: 1,
        operation_id: this.#safeOperationId(value),
        outcome: "rejected",
        code: "SUPERVISOR_REJECTED",
        retryable: false,
        summary: "Runtime request did not match managed Supervisor policy",
      };
    }
    try {
      assertNotAborted(signal);
      const observation = await this.#withRuntimeLock(request, async () => (
        request.kind === "provision"
          ? this.#provisionValidated(request, signal)
          : this.#lifecycleValidated(request, signal)
      ));
      return { protocol_version: 1, operation_id: request.operation_id, outcome: "accepted", observation };
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("SUPERVISOR_REJECTED:")) {
        return {
          protocol_version: 1,
          operation_id: request.operation_id,
          outcome: "rejected",
          code: "SUPERVISOR_REJECTED",
          retryable: false,
          summary: "Docker resource did not match managed runtime metadata",
        };
      }
      const failure = redactDockerError(error);
      return {
        protocol_version: 1,
        operation_id: request.operation_id,
        outcome: "failed",
        code: failure.code,
        retryable: true,
        summary: failure.code === "DEPENDENCY_TIMEOUT"
          ? "Docker runtime operation timed out"
          : "Docker runtime dependency was unavailable",
      };
    }
  }

  public async provision(value: unknown): Promise<RuntimeObservation> {
    const request = validateSupervisorPolicy(value, this.#options);
    if (request.kind !== "provision") throw rejected();
    return this.#withRuntimeLock(request, () => this.#provisionValidated(request));
  }

  async #withRuntimeLock<T>(
    request: SupervisorRequestV1,
    operation: () => Promise<T>,
  ): Promise<T> {
    const identity = request.kind === "provision" ? request.runtime : request;
    const key = resourceDigest(identity.tenant_id, identity.runtime_id);
    const prior = this.#runtimeLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    this.#runtimeLocks.set(key, current);
    await prior;
    try {
      return await operation();
    } finally {
      release();
      if (this.#runtimeLocks.get(key) === current) this.#runtimeLocks.delete(key);
    }
  }

  async #provisionValidated(request: ProvisionRuntimeCommandV1, signal?: AbortSignal): Promise<RuntimeObservation> {
    assertNotAborted(signal);
    const names = deriveManagedRuntimeNames(request.runtime);
    const runtimeDigest = resourceDigest(request.runtime.tenant_id, request.runtime.runtime_id);
    const ingressParent = join(resolve(this.#options.ingressRoot), runtimeDigest);
    const ingressDirectory = join(ingressParent, `g-${request.runtime.generation}`);
    const ingressPath = join(ingressDirectory, "hermes_ingress");
    const dockerIngressPath = dockerHostPath(
      this.#options.ingressRoot,
      this.#options.dockerHostIngressRoot,
      ingressPath,
    );
    const user = managedUser(this.#options);
    const initializerName = operationInitializerName(names.container, request.operation_id);
    const verifierName = `${initializerName}-manifest`;

    const gateway = await inspectOptional(this.#options.docker.getContainer(names.container));
    const initializer = await inspectOptional(this.#options.docker.getContainer(initializerName));
    const verifier = await inspectOptional(this.#options.docker.getContainer(verifierName));
    const volume = await inspectOptional(this.#options.docker.getVolume(names.volume));
    const network = await inspectOptional(this.#options.docker.getNetwork(names.network));
    const egressNetwork = await inspectOptional(this.#options.docker.getNetwork(managedEgressNetwork));

    await this.#validateIngressGeneration(runtimeDigest, request.runtime.generation);

    if (volume.inspection !== undefined) validateVolumeInspection(volume.inspection, request, names);
    if (network.inspection !== undefined) validateNetworkInspection(network.inspection, names.network, "backplane", true);
    if (egressNetwork.inspection !== undefined) validateNetworkInspection(egressNetwork.inspection, managedEgressNetwork, "egress", false);
    if (initializer.inspection !== undefined || verifier.inspection !== undefined) throw rejected();
    if (gateway.inspection !== undefined) {
      if (volume.inspection === undefined || network.inspection === undefined || egressNetwork.inspection === undefined) throw rejected();
      await validatePersistentIngress(ingressPath);
      const observation = validateGatewayInspection(gateway.inspection, request, request.runtime, names, dockerIngressPath, user);
      await ensurePrivateDirectory(this.#options.stagingRoot);
      const adoptionStage = await mkdtemp(join(resolve(this.#options.stagingRoot), "operation-"));
      await chmod(adoptionStage, 0o700);
      try {
        await this.#verifyManifest(request, names, verifierName, adoptionStage, signal);
      } finally {
        await rm(adoptionStage, { recursive: true, force: true });
      }
      if (observation.lifecycle === "running") return observation;
      assertNotAborted(signal);
      await gateway.handle.start();
      const resumed = validateGatewayInspection(
        await gateway.handle.inspect(),
        request,
        request.runtime,
        names,
        dockerIngressPath,
        user,
      );
      if (resumed.lifecycle !== "running") throw rejected();
      return resumed;
    }

    if (volume.inspection === undefined) {
      assertNotAborted(signal);
      await this.#options.docker.createVolume({ Name: names.volume, Labels: { ...volumeLabels(request, names) } });
    }
    if (network.inspection === undefined) {
      assertNotAborted(signal);
      await this.#options.docker.createNetwork({
        Name: names.network,
        Driver: "bridge",
        Internal: true,
        Attachable: false,
        Labels: { ...networkLabels(names.network, "backplane") },
      });
    }
    if (egressNetwork.inspection === undefined) {
      assertNotAborted(signal);
      await this.#options.docker.createNetwork({
        Name: managedEgressNetwork,
        Driver: "bridge",
        Internal: false,
        Attachable: false,
        Labels: { ...networkLabels(managedEgressNetwork, "egress") },
      });
    }

    await ensurePrivateDirectory(this.#options.stagingRoot);
    const stageDirectory = await mkdtemp(join(resolve(this.#options.stagingRoot), "operation-"));
    await chmod(stageDirectory, 0o700);
    try {
      const secretDirectory = join(stageDirectory, "secrets");
      await mkdir(secretDirectory, { mode: 0o700 });
      const profiles = [];
      for (const profile of [...request.runtime.profiles].sort((left, right) => left.profile_id.localeCompare(right.profile_id))) {
        assertNotAborted(signal);
        const secretFilename = `provider-${resourceDigest(profile.profile_id).slice(0, 32)}`;
        await writeSecretMaterial(
          this.#options.secretStore,
          profile.provider_secret_ref,
          join(secretDirectory, secretFilename),
        );
        profiles.push({
          profile_id: profile.profile_id,
          hermes_profile_ref: profile.hermes_profile_ref,
          description: profile.description,
          provider_base_url: profile.provider_base_url,
          model_id: profile.model_id,
          provider_secret_file: `/run/core-agent/secrets/${secretFilename}`,
        });
      }
      const bundlePath = join(stageDirectory, "bundle.json");
      await writeExclusive(bundlePath, `${JSON.stringify({
        bundle_version: 1,
        tenant_id: request.runtime.tenant_id,
        runtime_id: request.runtime.runtime_id,
        generation: request.runtime.generation,
        image_ref: request.runtime.image_ref,
        profiles,
      })}\n`);

      assertNotAborted(signal);
      const initializerContainer = await this.#options.docker.createContainer(exactInitializerOptions(
        request,
        names,
        initializerName,
        dockerHostPath(this.#options.stagingRoot, this.#options.dockerHostStagingRoot, bundlePath),
        dockerHostPath(this.#options.stagingRoot, this.#options.dockerHostStagingRoot, secretDirectory),
        user,
      ));
      try {
        assertNotAborted(signal);
        await initializerContainer.start();
        const waited = await boundedWait(
          initializerContainer.wait(),
          this.#options.initializerTimeoutMs ?? maximumInitializerWaitMs,
          signal,
        );
        if (parseWaitStatus(waited) !== 0) {
          await initializerContainer.logs({ stdout: false, stderr: true, tail: 64 }).catch(() => Buffer.alloc(0));
          throw dockerFailure("DEPENDENCY_UNAVAILABLE", "Docker initializer failed");
        }
      } finally {
        await initializerContainer.remove({ force: true, v: false }).catch(() => undefined);
      }

      await this.#verifyManifest(request, names, verifierName, stageDirectory, signal);
      assertNotAborted(signal);
      const ingressMaterial = await this.#options.secretStore.get(request.runtime.ingress_secret_ref);
      try {
        assertNotAborted(signal);
        await this.#writeIngressCredential(runtimeDigest, request.runtime.generation, ingressMaterial.text());
      } finally {
        ingressMaterial.release();
      }
      assertNotAborted(signal);
      let gatewayContainer: DockerContainerLike | undefined;
      try {
        gatewayContainer = await this.#options.docker.createContainer(exactGatewayOptions(
          request,
          names,
          dockerIngressPath,
          user,
        ));
        assertNotAborted(signal);
        await gatewayContainer.start();
        const observation = validateGatewayInspection(
          await gatewayContainer.inspect(),
          request,
          request.runtime,
          names,
          dockerIngressPath,
          user,
        );
        if (observation.lifecycle !== "running") throw rejected();
        return observation;
      } catch (error) {
        if (gatewayContainer !== undefined) {
          await gatewayContainer.remove({ force: true, v: false }).catch(() => undefined);
        }
        await this.#removeIngressCredential(runtimeDigest, request.runtime.generation);
        throw error;
      }
    } catch (error) {
      if (error instanceof BoundedDockerError || (error instanceof Error && error.message.startsWith("SUPERVISOR_REJECTED:"))) {
        throw error;
      }
      throw redactDockerError(error);
    } finally {
      await rm(stageDirectory, { recursive: true, force: true });
    }
  }

  async #verifyManifest(
    request: ProvisionRuntimeCommandV1,
    names: RuntimeNames,
    verifierName: string,
    stageDirectory: string,
    signal?: AbortSignal,
  ): Promise<void> {
    assertNotAborted(signal);
    const outputDirectory = join(stageDirectory, "output");
    await mkdir(outputDirectory, { mode: 0o700 });
    const verifierContainer = await this.#options.docker.createContainer(exactManifestVerifierOptions(
      request,
      names,
      verifierName,
      dockerHostPath(this.#options.stagingRoot, this.#options.dockerHostStagingRoot, outputDirectory),
      managedUser(this.#options),
    ));
    try {
      assertNotAborted(signal);
      await verifierContainer.start();
      const waited = await boundedWait(
        verifierContainer.wait(),
        this.#options.initializerTimeoutMs ?? maximumInitializerWaitMs,
        signal,
      );
      if (parseWaitStatus(waited) !== 0) {
        throw dockerFailure("DEPENDENCY_UNAVAILABLE", "Docker manifest verifier failed");
      }
    } finally {
      await verifierContainer.remove({ force: true, v: false }).catch(() => undefined);
    }
    assertNotAborted(signal);
    const manifest = await readPrivateManifest(join(outputDirectory, "manifest.json"));
    try {
      validateManifest(manifest, request);
    } finally {
      manifest.fill(0);
    }
  }

  async #lifecycleValidated(request: LifecycleRuntimeCommandV1, signal?: AbortSignal): Promise<RuntimeObservation> {
    assertNotAborted(signal);
    const names = deriveManagedRuntimeNames(request);
    const runtimeDigest = resourceDigest(request.tenant_id, request.runtime_id);
    const ingressParent = join(resolve(this.#options.ingressRoot), runtimeDigest);
    const ingressDirectory = join(ingressParent, `g-${request.generation}`);
    const ingressPath = join(ingressDirectory, "hermes_ingress");
    const dockerIngressPath = dockerHostPath(
      this.#options.ingressRoot,
      this.#options.dockerHostIngressRoot,
      ingressPath,
    );
    const user = managedUser(this.#options);
    await this.#validateIngressGeneration(runtimeDigest, request.generation);
    const [container, volume, network, egressNetwork] = await Promise.all([
      inspectOptional(this.#options.docker.getContainer(names.container)),
      inspectOptional(this.#options.docker.getVolume(names.volume)),
      inspectOptional(this.#options.docker.getNetwork(names.network)),
      inspectOptional(this.#options.docker.getNetwork(managedEgressNetwork)),
    ]);
    if (container.inspection === undefined) {
      if (request.kind === "delete") {
        await this.#removeIngressCredential(runtimeDigest, request.generation);
      }
      if (request.kind === "inspect" || request.kind === "delete") {
        return {
          tenant_id: request.tenant_id,
          runtime_id: request.runtime_id,
          generation: request.generation,
          exists: false,
          lifecycle: "removed",
          health: "unknown",
          image_ref: REMOVED_RUNTIME_IMAGE_REF,
        };
      }
      throw rejected();
    }
    if (volume.inspection === undefined || network.inspection === undefined || egressNetwork.inspection === undefined) throw rejected();
    validateVolumeInspection(volume.inspection, request, names);
    validateNetworkInspection(network.inspection, names.network, "backplane", true);
    validateNetworkInspection(egressNetwork.inspection, managedEgressNetwork, "egress", false);
    await validatePersistentIngress(ingressPath);
    const before = validateGatewayInspection(container.inspection, undefined, request, names, dockerIngressPath, user);
    if (request.kind === "inspect") return before;
    assertNotAborted(signal);
    if (request.kind === "start") await container.handle.start();
    else if (request.kind === "stop") await container.handle.stop({ t: 30 });
    else if (request.kind === "restart") await container.handle.restart({ t: 30 });
    else {
      await container.handle.remove({ force: true, v: false });
      await this.#removeIngressCredential(runtimeDigest, request.generation);
      const { private_origin: _privateOrigin, ...withoutOrigin } = before;
      return { ...withoutOrigin, exists: false, lifecycle: "removed", health: "unknown", image_ref: REMOVED_RUNTIME_IMAGE_REF };
    }
    return validateGatewayInspection(await container.handle.inspect(), undefined, request, names, dockerIngressPath, user);
  }

  async #validateIngressGeneration(runtimeDigest: string, generation: number): Promise<void> {
    const held = await this.#openIngressDirectories(runtimeDigest, generation, false);
    if (held !== undefined) await this.#closeIngressDirectories(held);
  }

  async #openIngressDirectories(
    runtimeDigest: string,
    generation: number,
    create: boolean,
  ): Promise<HeldIngressDirectories | undefined> {
    const rootPath = resolve(this.#options.ingressRoot);
    if (create) await ensurePrivateDirectory(rootPath);
    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(rootPath);
    } catch (error) {
      if (!create && isNotFound(error)) return undefined;
      throw rejected();
    }
    if (canonicalRoot !== rootPath) throw rejected();
    await validateProtectedDirectoryAncestors(canonicalRoot);
    let root: FileHandle;
    try {
      root = await open(rootPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    } catch {
      throw rejected();
    }
    const parentName = runtimeDigest;
    const parentPath = join(rootPath, parentName);
    const generationName = `g-${generation}`;
    const generationPath = join(parentPath, generationName);
    let parent: FileHandle | undefined;
    let generationHandle: FileHandle | undefined;
    try {
      await assertHeldPrivateDirectory(root, rootPath);
      if (create) {
        await mkdir(childPath(root, rootPath, parentName), { mode: 0o700 }).catch((error) => {
          if (errorCode(error) !== "EEXIST") throw rejected();
        });
      }
      try {
        parent = await open(
          childPath(root, rootPath, parentName),
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
      } catch (error) {
        if (!create && isNotFound(error)) return undefined;
        throw rejected();
      }
      await assertHeldPrivateDirectory(parent, childPath(root, rootPath, parentName));
      const entries = await readdir(process.platform === "linux" ? join("/proc/self/fd", String(parent.fd)) : parentPath);
      if (entries.some((entry) => entry !== generationName)) throw rejected();
      if (create) {
        await mkdir(childPath(parent, parentPath, generationName), { mode: 0o700 }).catch((error) => {
          if (errorCode(error) !== "EEXIST") throw rejected();
        });
      }
      try {
        generationHandle = await open(
          childPath(parent, parentPath, generationName),
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
      } catch (error) {
        if (!create && isNotFound(error)) return undefined;
        throw rejected();
      }
      await assertHeldPrivateDirectory(generationHandle, childPath(parent, parentPath, generationName));
      return {
        root,
        rootPath,
        parent,
        parentPath,
        parentName,
        generation: generationHandle,
        generationPath,
        generationName,
      };
    } catch (error) {
      await generationHandle?.close().catch(() => undefined);
      await parent?.close().catch(() => undefined);
      await root.close().catch(() => undefined);
      if (error instanceof Error && error.message.startsWith("SUPERVISOR_REJECTED:")) throw error;
      throw rejected();
    } finally {
      if (generationHandle === undefined) await parent?.close().catch(() => undefined);
      if (generationHandle === undefined) await root.close().catch(() => undefined);
    }
  }

  async #writeIngressCredential(runtimeDigest: string, generation: number, value: string): Promise<string> {
    const held = await this.#openIngressDirectories(runtimeDigest, generation, true);
    if (held === undefined) throw rejected();
    const temporaryName = `.pending-${randomBytes(16).toString("hex")}`;
    const temporaryPath = childPath(held.generation, held.generationPath, temporaryName);
    const finalPath = childPath(held.generation, held.generationPath, "hermes_ingress");
    try {
      await writeExclusive(temporaryPath, value);
      await assertHeldPrivateDirectory(held.root, held.rootPath);
      await assertHeldPrivateDirectory(held.parent, childPath(held.root, held.rootPath, held.parentName));
      await assertHeldPrivateDirectory(held.generation, childPath(held.parent, held.parentPath, held.generationName));
      await rename(temporaryPath, finalPath);
      await held.generation.sync();
      return join(held.generationPath, "hermes_ingress");
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
      await this.#closeIngressDirectories(held);
    }
  }

  async #removeIngressCredential(runtimeDigest: string, generation: number): Promise<void> {
    const held = await this.#openIngressDirectories(runtimeDigest, generation, false);
    if (held === undefined) return;
    try {
      const credentialPath = childPath(held.generation, held.generationPath, "hermes_ingress");
      let credential: FileHandle | undefined;
      try {
        credential = await open(credentialPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch (error) {
        if (!isNotFound(error)) throw rejected();
      }
      if (credential !== undefined) {
        try {
          const heldFile = await credential.stat({ bigint: true });
          const namedFile = await lstat(credentialPath, { bigint: true });
          const uid = process.getuid?.();
          if (
            uid === undefined || !heldFile.isFile() || heldFile.uid !== BigInt(uid)
            || (heldFile.mode & 0o7777n) !== 0o600n || !sameFileIdentity(heldFile, namedFile)
          ) throw rejected();
          await unlink(credentialPath);
        } finally {
          await credential.close().catch(() => undefined);
        }
      }
      await assertHeldPrivateDirectory(held.root, held.rootPath);
      await assertHeldPrivateDirectory(held.parent, childPath(held.root, held.rootPath, held.parentName));
      await assertHeldPrivateDirectory(held.generation, childPath(held.parent, held.parentPath, held.generationName));
      await rmdir(childPath(held.parent, held.parentPath, held.generationName));
      await rmdir(childPath(held.root, held.rootPath, held.parentName));
      await held.root.sync();
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("SUPERVISOR_REJECTED:")) throw error;
      throw rejected();
    } finally {
      await this.#closeIngressDirectories(held);
    }
  }

  async #closeIngressDirectories(held: HeldIngressDirectories): Promise<void> {
    await held.generation.close().catch(() => undefined);
    await held.parent.close().catch(() => undefined);
    await held.root.close().catch(() => undefined);
  }

  #safeOperationId(value: unknown): string {
    try {
      const request = validateSupervisorRequest(value);
      return request.operation_id;
    } catch {
      return "invalid_request";
    }
  }
}
