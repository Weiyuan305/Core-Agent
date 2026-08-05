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
  loadRuntimeImageLock,
  REMOVED_RUNTIME_IMAGE_REF,
  SUPERVISOR_DEADLINE_BUDGET,
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
const defaultInitializerWaitMs = SUPERVISOR_DEADLINE_BUDGET.initializerTimeoutMs;
const defaultVerifierWaitMs = SUPERVISOR_DEADLINE_BUDGET.verifierTimeoutMs;
const defaultReconciliationWaitMs = SUPERVISOR_DEADLINE_BUDGET.reconciliationTimeoutMs;
const maximumEffectWaitMs = SUPERVISOR_DEADLINE_BUDGET.effectTimeoutMs;
const managedEgressNetwork = "core-agent-egress";
const managedHomeEnvironment = "HOME=/opt/data";
const gatewayEnvironment = Object.freeze([
  managedHomeEnvironment,
  "API_SERVER_ENABLED=true",
  "API_SERVER_HOST=0.0.0.0",
  "API_SERVER_PORT=8642",
  "GATEWAY_MULTIPLEX_PROFILES=true",
]);
const egressNetworkConfiguration = Object.freeze({
  subnet: "172.31.240.0/24",
  gateway: "172.31.240.1",
  options: Object.freeze({ "com.docker.network.bridge.enable_ip_masquerade": "true" }),
});

interface DockerContainerLike {
  inspect(options?: { readonly abortSignal?: AbortSignal }): Promise<unknown>;
  start(options?: Dockerode.ContainerStartOptions): Promise<unknown>;
  stop(options?: Dockerode.ContainerStopOptions): Promise<unknown>;
  restart(options?: Dockerode.ContainerStopOptions): Promise<unknown>;
  wait(options?: Dockerode.ContainerWaitOptions): Promise<unknown>;
  logs(options?: Dockerode.ContainerLogsOptions): Promise<Buffer | NodeJS.ReadableStream>;
  remove(options?: Dockerode.ContainerRemoveOptions & { readonly abortSignal?: AbortSignal }): Promise<unknown>;
}

interface DockerResourceLike {
  inspect(options?: { readonly abortSignal?: AbortSignal }): Promise<unknown>;
}

interface LockedImageConfiguration {
  readonly environment: readonly string[];
  readonly labels: Readonly<Record<string, string>>;
}

export interface DockerClientLike {
  getContainer(name: string): DockerContainerLike;
  getImage(name: string): DockerResourceLike;
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
  readonly verifierTimeoutMs?: number;
  readonly reconciliationTimeoutMs?: number;
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

interface DockerMutationState {
  completed: boolean;
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

function exactDataKeys(value: unknown, expectedKeys: readonly string[]): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw rejected();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length
    || keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
  ) throw rejected();
  for (const key of expectedKeys) dataProperty(value, key);
}

function safeStringRecord(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw rejected();
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > 256) throw rejected();
  const result = Object.create(null) as Record<string, string>;
  for (const key of keys) {
    if (typeof key !== "string" || key.length < 1 || key.length > 256) throw rejected();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable
      || typeof descriptor.value !== "string" || descriptor.value.length > 4_096
    ) throw rejected();
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
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

function environmentRecord(value: unknown): Readonly<Record<string, string>> {
  const values = safeStringArray(value);
  if (values.length > 256) throw rejected();
  const result = Object.create(null) as Record<string, string>;
  for (const item of values) {
    const separator = item.indexOf("=");
    const name = separator < 0 ? item : item.slice(0, separator);
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(name) || Object.hasOwn(result, name)) throw rejected();
    result[name] = item;
  }
  return Object.freeze(result);
}

function validateMergedEnvironment(
  value: unknown,
  imageEnvironment: readonly string[],
  runtimeEnvironment: readonly string[],
): void {
  const expected = {
    ...environmentRecord(imageEnvironment),
    ...environmentRecord(runtimeEnvironment),
  };
  exactStringRecord(environmentRecord(value), expected);
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

function abortOptions(signal?: AbortSignal): { readonly abortSignal?: AbortSignal } {
  return signal === undefined ? {} : { abortSignal: signal };
}

const unresolvedDockerMutation = new Promise<never>(() => undefined);

async function settleDockerMutation<T>(
  promise: Promise<T>,
  state: DockerMutationState,
  signal?: AbortSignal,
): Promise<T> {
  try {
    const result = await promise;
    state.completed = true;
    return result;
  } catch (error) {
    // Aborting the HTTP request does not prove that the Docker daemon cancelled
    // a mutation it already accepted. Keep the stable journal reservation live
    // until process restart can reconcile the derived resource through adoption.
    if (signal?.aborted === true) return unresolvedDockerMutation;
    throw error;
  }
}

async function inspectOptional<T extends DockerResourceLike>(
  handle: T,
  signal?: AbortSignal,
): Promise<ExistingResource<T>> {
  try {
    return { handle, inspection: await handle.inspect(abortOptions(signal)) };
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

function supervisorPathFromDockerHost(localRoot: string, hostRoot: string, hostPath: string): string {
  const local = resolve(localRoot);
  const host = resolve(hostRoot);
  const child = resolve(hostPath);
  const suffix = relative(host, child);
  if (suffix === "" || suffix.startsWith("..") || isAbsolute(suffix)) throw rejected();
  return join(local, suffix);
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

async function removeProtectedStageTree(path: string): Promise<boolean> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (error) {
    return isNotFound(error);
  }
  try {
    await assertHeldPrivateDirectory(handle, path);
    const names = await readdir(path);
    for (const name of names) {
      if (name.length < 1 || name === "." || name === ".." || name.includes("/")) return false;
      const child = join(path, name);
      let metadata: BigIntStats;
      try {
        metadata = await lstat(child, { bigint: true });
      } catch {
        return false;
      }
      const uid = process.getuid?.();
      if (uid === undefined || metadata.uid !== BigInt(uid) || metadata.isSymbolicLink()) return false;
      if (metadata.isDirectory()) {
        if ((metadata.mode & 0o7777n) !== 0o700n || !await removeProtectedStageTree(child)) return false;
      } else if (metadata.isFile()) {
        if ((metadata.mode & 0o7777n) !== 0o600n) return false;
        try {
          await unlink(child);
        } catch {
          return false;
        }
      } else return false;
    }
    await assertHeldPrivateDirectory(handle, path);
    try {
      await rmdir(path);
      return true;
    } catch {
      return false;
    }
  } catch {
    return false;
  } finally {
    await handle.close().catch(() => undefined);
  }
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
    Env: [managedHomeEnvironment],
    Labels: { ...runtimeLabels(request, names), "core-agent.resource": "runtime-initializer" },
    HostConfig: {
      AutoRemove: false,
      NetworkMode: "none",
      Privileged: false,
      PublishAllPorts: false,
      PortBindings: {},
      RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
      IpcMode: "private",
      PidMode: "",
      UTSMode: "",
      UsernsMode: "",
      ...({ CgroupnsMode: "private" } as { readonly CgroupnsMode: string }),
      ReadonlyRootfs: true,
      CapAdd: [],
      CapDrop: ["ALL"],
      Devices: [],
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
    Env: [...gatewayEnvironment],
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
    Env: [managedHomeEnvironment],
    Labels: { ...runtimeLabels(request, names), "core-agent.resource": "runtime-manifest-verifier" },
    HostConfig: {
      AutoRemove: false,
      NetworkMode: "none",
      Privileged: false,
      PublishAllPorts: false,
      PortBindings: {},
      RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
      IpcMode: "private",
      PidMode: "",
      UTSMode: "",
      UsernsMode: "",
      ...({ CgroupnsMode: "private" } as { readonly CgroupnsMode: string }),
      ReadonlyRootfs: true,
      CapAdd: [],
      CapDrop: ["ALL"],
      Devices: [],
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

function bindSource(value: string, destination: string): string {
  const suffix = `:${destination}`;
  if (!value.endsWith(suffix)) throw rejected();
  const source = value.slice(0, -suffix.length);
  if (source.length < 1 || source.includes(":")) throw rejected();
  return source;
}

function assertDockerStagingChild(root: string, path: string, suffix: string): string {
  const canonicalRoot = resolve(root);
  if (canonicalRoot !== root || resolve(path) !== path) throw rejected();
  const child = relative(canonicalRoot, path);
  const segments = child.split("/");
  if (
    child.startsWith("..") || isAbsolute(child)
    || segments.length !== 2
    || !/^operation-[^/]+$/u.test(segments[0] ?? "")
    || `/${segments[1] ?? ""}` !== suffix
  ) throw rejected();
  return dirname(path);
}

interface ExpectedHelperMount {
  readonly type: "volume" | "bind";
  readonly destination: string;
  readonly readWrite: boolean;
  readonly name?: string;
  readonly source?: string;
}

function validateHelperMounts(value: unknown, expected: readonly ExpectedHelperMount[]): void {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== expected.length) {
    throw rejected();
  }
  const remaining = [...expected];
  for (let index = 0; index < value.length; index += 1) {
    const mount = dataProperty(value, String(index));
    const destination = stringProperty(mount, "Destination");
    const expectedIndex = remaining.findIndex((item) => item.destination === destination);
    if (expectedIndex < 0) throw rejected();
    const expectedMount = remaining.splice(expectedIndex, 1)[0]!;
    if (
      stringProperty(mount, "Type") !== expectedMount.type
      || booleanProperty(mount, "RW") !== expectedMount.readWrite
    ) throw rejected();
    if (expectedMount.type === "volume") {
      if (stringProperty(mount, "Name") !== expectedMount.name) throw rejected();
    } else if (stringProperty(mount, "Source") !== expectedMount.source) throw rejected();
  }
  if (remaining.length !== 0) throw rejected();
}

function safePrivateNamespaceMode(value: unknown, key: string): void {
  const mode = stringProperty(value, key);
  if (mode !== "" && mode !== "private") throw rejected();
}

function validateHelperInspection(
  value: unknown,
  request: ProvisionRuntimeCommandV1,
  names: RuntimeNames,
  helperName: string,
  resource: "runtime-initializer" | "runtime-manifest-verifier",
  user: string,
  dockerHostStagingRoot: string,
  imageConfiguration: LockedImageConfiguration,
): string {
  if (stringProperty(value, "Name") !== `/${helperName}`) throw rejected();
  const config = dataProperty(value, "Config");
  if (stringProperty(config, "Image") !== request.runtime.image_ref || stringProperty(config, "User") !== user) throw rejected();
  exactStringRecord(dataProperty(config, "Labels"), {
    ...imageConfiguration.labels,
    ...runtimeLabels(request, names),
    "core-agent.resource": resource,
  });
  validateMergedEnvironment(dataProperty(config, "Env"), imageConfiguration.environment, [managedHomeEnvironment]);
  const hostConfig = dataProperty(value, "HostConfig");
  if (
    booleanProperty(hostConfig, "AutoRemove") !== false
    || stringProperty(hostConfig, "NetworkMode") !== "none"
    || booleanProperty(hostConfig, "Privileged") !== false
    || booleanProperty(hostConfig, "PublishAllPorts") !== false
    || booleanProperty(hostConfig, "ReadonlyRootfs") !== true
  ) throw rejected();
  exactEmptyRecord(dataProperty(hostConfig, "PortBindings"));
  const restartPolicy = dataProperty(hostConfig, "RestartPolicy");
  exactDataKeys(restartPolicy, ["Name", "MaximumRetryCount"]);
  if (
    stringProperty(restartPolicy, "Name") !== "no"
    || dataProperty(restartPolicy, "MaximumRetryCount") !== 0
  ) throw rejected();
  safePrivateNamespaceMode(hostConfig, "IpcMode");
  if (stringProperty(hostConfig, "PidMode") !== "" || stringProperty(hostConfig, "UTSMode") !== "") throw rejected();
  if (stringProperty(hostConfig, "UsernsMode") !== "") throw rejected();
  safePrivateNamespaceMode(hostConfig, "CgroupnsMode");
  equalStringArrays(dataProperty(hostConfig, "CapAdd"), []);
  equalStringArrays(dataProperty(hostConfig, "CapDrop"), ["ALL"]);
  equalStringArrays(dataProperty(hostConfig, "Devices"), []);
  equalStringArrays(dataProperty(hostConfig, "SecurityOpt"), ["no-new-privileges:true"]);
  const binds = safeStringArray(dataProperty(hostConfig, "Binds"));
  const networks = dataProperty(dataProperty(value, "NetworkSettings"), "Networks");
  if (typeof networks !== "object" || networks === null || Reflect.ownKeys(networks).length !== 0) throw rejected();

  if (resource === "runtime-initializer") {
    equalStringArrays(dataProperty(config, "Entrypoint"), ["/opt/hermes/.venv/bin/python", "/opt/core-agent/initialize.py"]);
    equalStringArrays(dataProperty(config, "Cmd"), [
      "--bundle", "/run/core-agent/bootstrap/bundle.json",
      "--data-root", "/opt/data",
      "--manifest", "/opt/data/.core-agent/manifest.json",
    ]);
    exactStringRecord(dataProperty(hostConfig, "Tmpfs"), {
      "/tmp": "rw,noexec,nosuid,nodev,size=64m,mode=1777",
      "/run/core-agent/output": "rw,noexec,nosuid,nodev,size=16m,mode=0700",
    });
    exactNumberProperty(hostConfig, "Memory", 1_073_741_824);
    exactNumberProperty(hostConfig, "NanoCpus", 1_000_000_000);
    exactNumberProperty(hostConfig, "PidsLimit", 256);
    if (binds.length !== 3 || binds[0] !== `${names.volume}:/opt/data`) throw rejected();
    const bundle = bindSource(binds[1]!, "/run/core-agent/bootstrap/bundle.json:ro");
    const secrets = bindSource(binds[2]!, "/run/core-agent/secrets:ro");
    const operationRoot = assertDockerStagingChild(dockerHostStagingRoot, bundle, "/bundle.json");
    if (assertDockerStagingChild(dockerHostStagingRoot, secrets, "/secrets") !== operationRoot) throw rejected();
    validateHelperMounts(dataProperty(value, "Mounts"), [
      { type: "volume", name: names.volume, destination: "/opt/data", readWrite: true },
      { type: "bind", source: bundle, destination: "/run/core-agent/bootstrap/bundle.json", readWrite: false },
      { type: "bind", source: secrets, destination: "/run/core-agent/secrets", readWrite: false },
    ]);
    return operationRoot;
  }

  equalStringArrays(dataProperty(config, "Entrypoint"), ["/opt/hermes/.venv/bin/python"]);
  equalStringArrays(dataProperty(config, "Cmd"), [
    "-c",
    "import os; from pathlib import Path; data=Path('/opt/data/.core-agent/manifest.json').read_bytes(); fd=os.open('/run/core-agent/output/manifest.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600); os.write(fd,data); os.fsync(fd); os.close(fd)",
  ]);
  exactStringRecord(dataProperty(hostConfig, "Tmpfs"), {
    "/tmp": "rw,noexec,nosuid,nodev,size=16m,mode=1777",
  });
  exactNumberProperty(hostConfig, "Memory", 134_217_728);
  exactNumberProperty(hostConfig, "NanoCpus", 500_000_000);
  exactNumberProperty(hostConfig, "PidsLimit", 32);
  if (binds.length !== 2 || binds[0] !== `${names.volume}:/opt/data:ro`) throw rejected();
  const output = bindSource(binds[1]!, "/run/core-agent/output");
  const operationRoot = assertDockerStagingChild(dockerHostStagingRoot, output, "/output");
  validateHelperMounts(dataProperty(value, "Mounts"), [
    { type: "volume", name: names.volume, destination: "/opt/data", readWrite: false },
    { type: "bind", source: output, destination: "/run/core-agent/output", readWrite: true },
  ]);
  return operationRoot;
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
  if (resource === "egress") {
    if (
      stringProperty(value, "Scope") !== "local"
      || booleanProperty(value, "Ingress") !== false
      || booleanProperty(value, "EnableIPv6") !== false
    ) throw rejected();
    exactStringRecord(dataProperty(value, "Options"), egressNetworkConfiguration.options);
    const ipam = dataProperty(value, "IPAM");
    exactDataKeys(ipam, ["Driver", "Options", "Config"]);
    if (stringProperty(ipam, "Driver") !== "default" || dataProperty(ipam, "Options") !== null) throw rejected();
    const configurations = dataProperty(ipam, "Config");
    if (!Array.isArray(configurations) || Object.getPrototypeOf(configurations) !== Array.prototype || configurations.length !== 1) {
      throw rejected();
    }
    const configuration = dataProperty(configurations, "0");
    exactStringRecord(configuration, {
      Subnet: egressNetworkConfiguration.subnet,
      Gateway: egressNetworkConfiguration.gateway,
    });
  }
}

function gatewayImageReference(value: unknown): string {
  const config = dataProperty(value, "Config");
  const imageRef = stringProperty(config, "Image");
  if (stringProperty(dataProperty(config, "Labels"), "core-agent.image-ref") !== imageRef) throw rejected();
  return imageRef;
}

function validateGatewayInspection(
  value: unknown,
  request: ProvisionRuntimeCommandV1 | undefined,
  identity: { readonly tenant_id: string; readonly runtime_id: string; readonly generation: number },
  names: RuntimeNames,
  ingressPath: string,
  user: string,
  imageConfiguration: LockedImageConfiguration,
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
  const expectedLabels = {
    ...imageConfiguration.labels,
    ...runtimeLabels({
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
    }, names),
  };
  exactStringRecord(labels, expectedLabels);
  if (stringProperty(config, "Image") !== imageRef || stringProperty(config, "User") !== user) throw rejected();
  validateMergedEnvironment(dataProperty(config, "Env"), imageConfiguration.environment, gatewayEnvironment);
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

type BoundedDockerAttempt<T> =
  | { readonly outcome: "fulfilled"; readonly value: T }
  | { readonly outcome: "rejected"; readonly error: unknown }
  | { readonly outcome: "timed-out" };

async function boundedDockerAttempt<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<BoundedDockerAttempt<T>> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const result: Promise<BoundedDockerAttempt<T>> = Promise.resolve()
    .then(() => operation(controller.signal))
    .then(
      (value): BoundedDockerAttempt<T> => ({ outcome: "fulfilled", value }),
      (error: unknown): BoundedDockerAttempt<T> => ({ outcome: "rejected", error }),
    );
  const timeout = new Promise<BoundedDockerAttempt<T>>((resolvePromise) => {
    timer = setTimeout(() => {
      controller.abort();
      resolvePromise({ outcome: "timed-out" });
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([result, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
    const initializerTimeoutMs = options.initializerTimeoutMs ?? defaultInitializerWaitMs;
    const verifierTimeoutMs = options.verifierTimeoutMs ?? defaultVerifierWaitMs;
    const reconciliationTimeoutMs = options.reconciliationTimeoutMs ?? defaultReconciliationWaitMs;
    if (
      !Number.isSafeInteger(initializerTimeoutMs)
      || initializerTimeoutMs < 1
      || initializerTimeoutMs > maximumEffectWaitMs
    ) throw dockerFailure("DEPENDENCY_TIMEOUT", "Initializer timeout configuration is invalid");
    if (
      !Number.isSafeInteger(verifierTimeoutMs)
      || verifierTimeoutMs < 1
      || verifierTimeoutMs > maximumEffectWaitMs
    ) throw dockerFailure("DEPENDENCY_TIMEOUT", "Verifier timeout configuration is invalid");
    if (
      !Number.isSafeInteger(reconciliationTimeoutMs)
      || reconciliationTimeoutMs < 1
      || reconciliationTimeoutMs > maximumEffectWaitMs
    ) throw dockerFailure("DEPENDENCY_TIMEOUT", "Reconciliation timeout configuration is invalid");
    if (
      initializerTimeoutMs
        + verifierTimeoutMs
        + (reconciliationTimeoutMs * 5)
        + SUPERVISOR_DEADLINE_BUDGET.effectOverheadMs
      >= SUPERVISOR_DEADLINE_BUDGET.effectTimeoutMs
    ) throw dockerFailure("DEPENDENCY_TIMEOUT", "Aggregate effect timeout configuration is invalid");
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
    const mutationState: DockerMutationState = { completed: false };
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
          ? this.#provisionValidated(request, mutationState, signal)
          : this.#lifecycleValidated(request, mutationState, signal)
      ));
      return { protocol_version: 1, operation_id: request.operation_id, outcome: "accepted", observation };
    } catch (error) {
      if (signal?.aborted === true) {
        if (mutationState.completed) return unresolvedDockerMutation;
        return {
          protocol_version: 1,
          operation_id: request.operation_id,
          outcome: "failed",
          code: "DEPENDENCY_TIMEOUT",
          retryable: true,
          summary: "Docker runtime operation timed out",
        };
      }
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
    const mutationState: DockerMutationState = { completed: false };
    return this.#withRuntimeLock(request, () => this.#provisionValidated(request, mutationState));
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

  async #inspectLockedImageConfiguration(imageRef: string, signal?: AbortSignal): Promise<LockedImageConfiguration> {
    let lockedReferences: readonly string[];
    try {
      const lock = loadRuntimeImageLock(this.#options.imageLock);
      lockedReferences = Object.values(lock.platforms).map(({ reference }) => reference);
    } catch {
      throw rejected();
    }
    if (!lockedReferences.includes(imageRef)) throw rejected();
    let inspection: unknown;
    try {
      inspection = await this.#options.docker.getImage(imageRef).inspect(abortOptions(signal));
    } catch (error) {
      throw redactDockerError(error);
    }
    const config = dataProperty(inspection, "Config");
    const environment = safeStringArray(dataProperty(config, "Env"));
    environmentRecord(environment);
    return Object.freeze({
      environment,
      labels: safeStringRecord(dataProperty(config, "Labels")),
    });
  }

  async #removeAndProveContainerAbsent(
    container: DockerContainerLike,
    name: string,
    mutationState: DockerMutationState,
  ): Promise<void> {
    const timeoutMs = this.#options.reconciliationTimeoutMs ?? defaultReconciliationWaitMs;
    const reconciliationDeadlineMs = Date.now() + timeoutMs;
    await boundedDockerAttempt(
      (cleanupSignal) => container.remove({ force: true, v: false, ...abortOptions(cleanupSignal) }),
      timeoutMs,
    );
    const remainingMs = reconciliationDeadlineMs - Date.now();
    if (remainingMs <= 0) return unresolvedDockerMutation;
    const absence = await boundedDockerAttempt(
      (reconciliationSignal) => this.#options.docker.getContainer(name).inspect(abortOptions(reconciliationSignal)),
      remainingMs,
    );
    if (absence.outcome === "rejected" && isNotFound(absence.error)) {
      mutationState.completed = false;
      return;
    }
    // A fulfilled inspection, timeout, or unclassified inspection failure
    // cannot prove the exact daemon object absent. The journal reservation must
    // remain live because either the helper can still run or force-remove can
    // still take effect after the local request returned.
    return unresolvedDockerMutation;
  }

  async #provisionValidated(
    request: ProvisionRuntimeCommandV1,
    mutationState: DockerMutationState,
    signal?: AbortSignal,
  ): Promise<RuntimeObservation> {
    assertNotAborted(signal);
    const imageConfiguration = await this.#inspectLockedImageConfiguration(request.runtime.image_ref, signal);
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

    const gateway = await inspectOptional(this.#options.docker.getContainer(names.container), signal);
    const initializer = await inspectOptional(this.#options.docker.getContainer(initializerName), signal);
    const verifier = await inspectOptional(this.#options.docker.getContainer(verifierName), signal);
    const volume = await inspectOptional(this.#options.docker.getVolume(names.volume), signal);
    const network = await inspectOptional(this.#options.docker.getNetwork(names.network), signal);
    const egressNetwork = await inspectOptional(this.#options.docker.getNetwork(managedEgressNetwork), signal);

    await this.#validateIngressGeneration(runtimeDigest, request.runtime.generation);

    if (volume.inspection !== undefined) validateVolumeInspection(volume.inspection, request, names);
    if (network.inspection !== undefined) validateNetworkInspection(network.inspection, names.network, "backplane", true);
    if (egressNetwork.inspection !== undefined) validateNetworkInspection(egressNetwork.inspection, managedEgressNetwork, "egress", false);
    const initializerStage = initializer.inspection === undefined
      ? undefined
      : validateHelperInspection(
        initializer.inspection,
        request,
        names,
        initializerName,
        "runtime-initializer",
        user,
        this.#options.dockerHostStagingRoot,
        imageConfiguration,
      );
    const verifierStage = verifier.inspection === undefined
      ? undefined
      : validateHelperInspection(
        verifier.inspection,
        request,
        names,
        verifierName,
        "runtime-manifest-verifier",
        user,
        this.#options.dockerHostStagingRoot,
        imageConfiguration,
      );
    if (initializerStage !== undefined && verifierStage !== undefined && initializerStage !== verifierStage) throw rejected();
    if (initializer.inspection !== undefined) {
      await this.#removeAndProveContainerAbsent(initializer.handle, initializerName, mutationState);
    }
    if (verifier.inspection !== undefined) {
      await this.#removeAndProveContainerAbsent(verifier.handle, verifierName, mutationState);
    }
    const residueStage = initializerStage ?? verifierStage;
    if (residueStage !== undefined) {
      const localStage = supervisorPathFromDockerHost(
        this.#options.stagingRoot,
        this.#options.dockerHostStagingRoot,
        residueStage,
      );
      if (!await removeProtectedStageTree(localStage)) return unresolvedDockerMutation;
    }
    if (gateway.inspection !== undefined) {
      if (volume.inspection === undefined || network.inspection === undefined || egressNetwork.inspection === undefined) throw rejected();
      await validatePersistentIngress(ingressPath);
      const observation = validateGatewayInspection(
        gateway.inspection,
        request,
        request.runtime,
        names,
        dockerIngressPath,
        user,
        imageConfiguration,
      );
      await ensurePrivateDirectory(this.#options.stagingRoot);
      const adoptionStage = await mkdtemp(join(resolve(this.#options.stagingRoot), "operation-"));
      await chmod(adoptionStage, 0o700);
      try {
        await this.#verifyManifest(request, names, verifierName, adoptionStage, mutationState, signal);
      } finally {
        await rm(adoptionStage, { recursive: true, force: true });
      }
      if (observation.lifecycle === "running") return observation;
      assertNotAborted(signal);
      await settleDockerMutation(gateway.handle.start(abortOptions(signal)), mutationState, signal);
      const resumed = validateGatewayInspection(
        await gateway.handle.inspect(abortOptions(signal)),
        request,
        request.runtime,
        names,
        dockerIngressPath,
        user,
        imageConfiguration,
      );
      if (resumed.lifecycle !== "running") throw rejected();
      return resumed;
    }

    if (volume.inspection === undefined) {
      assertNotAborted(signal);
      await settleDockerMutation(this.#options.docker.createVolume({
        Name: names.volume,
        Labels: { ...volumeLabels(request, names) },
        ...abortOptions(signal),
      }), mutationState, signal);
    }
    if (network.inspection === undefined) {
      assertNotAborted(signal);
      await settleDockerMutation(this.#options.docker.createNetwork({
        Name: names.network,
        Driver: "bridge",
        Internal: true,
        Attachable: false,
        Labels: { ...networkLabels(names.network, "backplane") },
        ...abortOptions(signal),
      }), mutationState, signal);
    }
    if (egressNetwork.inspection === undefined) {
      assertNotAborted(signal);
      await settleDockerMutation(this.#options.docker.createNetwork({
        Name: managedEgressNetwork,
        Driver: "bridge",
        Internal: false,
        Attachable: false,
        EnableIPv6: false,
        Options: { ...egressNetworkConfiguration.options },
        IPAM: {
          Driver: "default",
          Config: [{
            Subnet: egressNetworkConfiguration.subnet,
            Gateway: egressNetworkConfiguration.gateway,
          }],
        },
        Labels: { ...networkLabels(managedEgressNetwork, "egress") },
        ...abortOptions(signal),
      }), mutationState, signal);
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
      const initializerContainer = await settleDockerMutation(this.#options.docker.createContainer({ ...exactInitializerOptions(
        request,
        names,
        initializerName,
        dockerHostPath(this.#options.stagingRoot, this.#options.dockerHostStagingRoot, bundlePath),
        dockerHostPath(this.#options.stagingRoot, this.#options.dockerHostStagingRoot, secretDirectory),
        user,
      ), ...abortOptions(signal) }), mutationState, signal);
      try {
        assertNotAborted(signal);
        await settleDockerMutation(initializerContainer.start(abortOptions(signal)), mutationState, signal);
        const waited = await boundedWait(
          initializerContainer.wait(abortOptions(signal)),
          this.#options.initializerTimeoutMs ?? defaultInitializerWaitMs,
          signal,
        );
        if (parseWaitStatus(waited) !== 0) {
          await initializerContainer.logs({ stdout: false, stderr: true, tail: 64, ...abortOptions(signal) })
            .catch(() => Buffer.alloc(0));
          throw dockerFailure("DEPENDENCY_UNAVAILABLE", "Docker initializer failed");
        }
      } finally {
        await this.#removeAndProveContainerAbsent(initializerContainer, initializerName, mutationState);
      }

      await this.#verifyManifest(request, names, verifierName, stageDirectory, mutationState, signal);
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
        gatewayContainer = await settleDockerMutation(this.#options.docker.createContainer({ ...exactGatewayOptions(
          request,
          names,
          dockerIngressPath,
          user,
        ), ...abortOptions(signal) }), mutationState, signal);
        assertNotAborted(signal);
        await settleDockerMutation(gatewayContainer.start(abortOptions(signal)), mutationState, signal);
        const observation = validateGatewayInspection(
          await gatewayContainer.inspect(abortOptions(signal)),
          request,
          request.runtime,
          names,
          dockerIngressPath,
          user,
          imageConfiguration,
        );
        if (observation.lifecycle !== "running") throw rejected();
        return observation;
      } catch (error) {
        if (gatewayContainer !== undefined) {
          await this.#removeAndProveContainerAbsent(gatewayContainer, names.container, mutationState);
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
    mutationState: DockerMutationState,
    signal?: AbortSignal,
  ): Promise<void> {
    assertNotAborted(signal);
    const outputDirectory = join(stageDirectory, "output");
    await mkdir(outputDirectory, { mode: 0o700 });
    const verifierContainer = await settleDockerMutation(this.#options.docker.createContainer({ ...exactManifestVerifierOptions(
      request,
      names,
      verifierName,
      dockerHostPath(this.#options.stagingRoot, this.#options.dockerHostStagingRoot, outputDirectory),
      managedUser(this.#options),
    ), ...abortOptions(signal) }), mutationState, signal);
    try {
      assertNotAborted(signal);
      await settleDockerMutation(verifierContainer.start(abortOptions(signal)), mutationState, signal);
      const waited = await boundedWait(
        verifierContainer.wait(abortOptions(signal)),
        this.#options.verifierTimeoutMs ?? defaultVerifierWaitMs,
        signal,
      );
      if (parseWaitStatus(waited) !== 0) {
        throw dockerFailure("DEPENDENCY_UNAVAILABLE", "Docker manifest verifier failed");
      }
    } finally {
      await this.#removeAndProveContainerAbsent(verifierContainer, verifierName, mutationState);
    }
    assertNotAborted(signal);
    const manifest = await readPrivateManifest(join(outputDirectory, "manifest.json"));
    try {
      validateManifest(manifest, request);
    } finally {
      manifest.fill(0);
    }
  }

  async #lifecycleValidated(
    request: LifecycleRuntimeCommandV1,
    mutationState: DockerMutationState,
    signal?: AbortSignal,
  ): Promise<RuntimeObservation> {
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
      inspectOptional(this.#options.docker.getContainer(names.container), signal),
      inspectOptional(this.#options.docker.getVolume(names.volume), signal),
      inspectOptional(this.#options.docker.getNetwork(names.network), signal),
      inspectOptional(this.#options.docker.getNetwork(managedEgressNetwork), signal),
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
    const imageConfiguration = await this.#inspectLockedImageConfiguration(gatewayImageReference(container.inspection), signal);
    validateVolumeInspection(volume.inspection, request, names);
    validateNetworkInspection(network.inspection, names.network, "backplane", true);
    validateNetworkInspection(egressNetwork.inspection, managedEgressNetwork, "egress", false);
    await validatePersistentIngress(ingressPath);
    const before = validateGatewayInspection(
      container.inspection,
      undefined,
      request,
      names,
      dockerIngressPath,
      user,
      imageConfiguration,
    );
    if (request.kind === "inspect") return before;
    assertNotAborted(signal);
    if (request.kind === "start") {
      await settleDockerMutation(container.handle.start(abortOptions(signal)), mutationState, signal);
    } else if (request.kind === "stop") {
      await settleDockerMutation(container.handle.stop({ t: 30, ...abortOptions(signal) }), mutationState, signal);
    } else if (request.kind === "restart") {
      await settleDockerMutation(container.handle.restart({ t: 30, ...abortOptions(signal) }), mutationState, signal);
    } else {
      await settleDockerMutation(
        container.handle.remove({ force: true, v: false, ...abortOptions(signal) }),
        mutationState,
        signal,
      );
      await this.#removeIngressCredential(runtimeDigest, request.generation);
      const { private_origin: _privateOrigin, ...withoutOrigin } = before;
      return { ...withoutOrigin, exists: false, lifecycle: "removed", health: "unknown", image_ref: REMOVED_RUNTIME_IMAGE_REF };
    }
    return validateGatewayInspection(
      await container.handle.inspect(abortOptions(signal)),
      undefined,
      request,
      names,
      dockerIngressPath,
      user,
      imageConfiguration,
    );
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
