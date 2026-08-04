import { createHash, timingSafeEqual } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { dirname, resolve } from "node:path";
import { lstat, open } from "node:fs/promises";

import { DomainError } from "@core-agent/runtime-core";

const MINIMUM_KEY_BYTES = 32;
const MAXIMUM_KEY_BYTES = 512;
const MAXIMUM_FILE_BYTES = MAXIMUM_KEY_BYTES + 1;
const tenantIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export interface ApiRequestContext {
  readonly requestId: string;
  readonly traceId: string;
  readonly tenantId?: string;
  readonly actorId: "core_agent_provisioner";
  readonly membershipId: "core_agent_provisioner_admin";
  readonly effectiveRole: "admin";
}

interface AuthenticationInput {
  readonly configuredDigest: Buffer;
  readonly headers: unknown;
  readonly tenantScoped: boolean;
  readonly requestId: string;
  readonly traceId: string;
}

function invalidKeyFile(): Error {
  return new Error("Bootstrap key file is invalid");
}

function validateProtectedDirectory(metadata: BigIntStats): void {
  const uid = process.getuid?.();
  if (
    uid === undefined
    || !metadata.isDirectory()
    || (metadata.uid !== 0n && metadata.uid !== BigInt(uid))
    || (metadata.mode & 0o22n) !== 0n
  ) throw invalidKeyFile();
}

async function validateProtectedAncestors(filePath: string): Promise<void> {
  let path = dirname(filePath);
  while (true) {
    validateProtectedDirectory(await lstat(path, { bigint: true }).catch(() => { throw invalidKeyFile(); }));
    const parent = dirname(path);
    if (parent === path) return;
    path = parent;
  }
}

function validateFileMetadata(metadata: BigIntStats): void {
  const uid = process.getuid?.();
  if (
    uid === undefined
    || !metadata.isFile()
    || metadata.uid !== BigInt(uid)
    || (metadata.mode & 0o7777n) !== 0o600n
    || metadata.size < BigInt(MINIMUM_KEY_BYTES + 1)
    || metadata.size > BigInt(MAXIMUM_FILE_BYTES)
  ) throw invalidKeyFile();
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

export async function loadBootstrapKeyDigest(configuredPath: string): Promise<Buffer> {
  if (configuredPath.length < 1 || configuredPath.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(configuredPath)) {
    throw invalidKeyFile();
  }
  const path = resolve(configuredPath);
  await validateProtectedAncestors(path);

  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw invalidKeyFile();
  }

  const source = Buffer.alloc(MAXIMUM_FILE_BYTES + 1);
  try {
    const before = await handle.stat({ bigint: true });
    validateFileMetadata(before);
    let offset = 0;
    while (offset < source.length) {
      const result = await handle.read(source, offset, source.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > MAXIMUM_FILE_BYTES || offset !== Number(before.size)) throw invalidKeyFile();
    const after = await handle.stat({ bigint: true });
    const pathMetadata = await lstat(path, { bigint: true });
    if (!sameFile(before, after) || !sameFile(after, pathMetadata)) throw invalidKeyFile();
    await validateProtectedAncestors(path);

    const bytes = source.subarray(0, offset);
    if (bytes.at(-1) !== 0x0a) throw invalidKeyFile();
    const key = bytes.subarray(0, -1);
    if (
      key.length < MINIMUM_KEY_BYTES
      || key.length > MAXIMUM_KEY_BYTES
      || key.includes(0x00)
      || key.includes(0x0a)
      || key.includes(0x0d)
    ) throw invalidKeyFile();
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(key);
    } catch {
      throw invalidKeyFile();
    }
    return createHash("sha256").update(key).digest();
  } catch (error) {
    if (error instanceof Error && error.message === "Bootstrap key file is invalid") throw error;
    throw invalidKeyFile();
  } finally {
    source.fill(0);
    await handle.close().catch(() => undefined);
  }
}

export function verifyBootstrapKey(configuredDigest: Buffer, authorization: string | undefined): boolean {
  const match = typeof authorization === "string" ? /^Bearer ([^\s]+)$/u.exec(authorization) : null;
  const candidateDigest = createHash("sha256").update(match?.[1] ?? "", "utf8").digest();
  const equal = configuredDigest.length === candidateDigest.length
    && timingSafeEqual(configuredDigest, candidateDigest);
  candidateDigest.fill(0);
  return match !== null && equal;
}

function ownHeader(headers: unknown, name: string): string | undefined {
  if (typeof headers !== "object" || headers === null || Array.isArray(headers)) {
    throw new DomainError("INVALID_REQUEST", "Request headers are invalid");
  }
  const descriptor = Object.getOwnPropertyDescriptor(headers, name);
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor) || !descriptor.enumerable || typeof descriptor.value !== "string") {
    throw new DomainError("INVALID_REQUEST", "Request headers are invalid");
  }
  return descriptor.value;
}

export function authenticateBootstrapRequest(input: AuthenticationInput): ApiRequestContext {
  const authorization = ownHeader(input.headers, "authorization");
  if (!verifyBootstrapKey(input.configuredDigest, authorization)) {
    throw new DomainError("UNAUTHENTICATED", "Bootstrap authentication failed");
  }

  const tenantId = ownHeader(input.headers, "x-core-agent-tenant-id");
  if (input.tenantScoped) {
    if (tenantId === undefined || !tenantIdPattern.test(tenantId)) {
      throw new DomainError("INVALID_REQUEST", "Tenant scope is invalid");
    }
    return Object.freeze({
      requestId: input.requestId,
      traceId: input.traceId,
      tenantId,
      actorId: "core_agent_provisioner",
      membershipId: "core_agent_provisioner_admin",
      effectiveRole: "admin",
    });
  }
  if (tenantId !== undefined) throw new DomainError("INVALID_REQUEST", "Tenant scope is not accepted by this route");
  return Object.freeze({
    requestId: input.requestId,
    traceId: input.traceId,
    actorId: "core_agent_provisioner",
    membershipId: "core_agent_provisioner_admin",
    effectiveRole: "admin",
  });
}
