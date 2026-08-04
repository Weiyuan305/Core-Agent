import { constants, type BigIntStats } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { lstat, open, realpath, stat, type FileHandle } from "node:fs/promises";

import {
  assertSecretReference,
  type SecretMaterial,
  type SecretReference,
  type SecretStore,
} from "./secret-store.js";

const maximumSecretBytes = 64 * 1024;
const boundedReadBytes = maximumSecretBytes + 1;

export function resolveSecretChildOpenPath(
  platform: NodeJS.Platform,
  rootFileDescriptor: number,
  canonicalRoot: string,
  filename: string,
): string {
  return platform === "linux"
    ? join("/proc/self/fd", String(rootFileDescriptor), filename)
    : join(canonicalRoot, filename);
}

interface RootIdentity {
  readonly canonicalPath: string;
  readonly device: bigint;
  readonly inode: bigint;
}

class BufferedSecretMaterial implements SecretMaterial {
  readonly #buffer: Buffer;
  #released = false;
  public readonly reference: SecretReference;

  public constructor(reference: SecretReference, buffer: Buffer) {
    this.reference = Object.freeze({ ...reference });
    this.#buffer = buffer;
  }

  public text(): string {
    if (this.#released) throw new Error("Secret material has been released");
    return this.#buffer.toString("utf8");
  }

  /**
   * Clears this private Buffer and revokes reads. This is best-effort lifetime
   * control only; it does not claim physical zeroization of JavaScript memory.
   */
  public release(): void {
    if (this.#released) return;
    this.#buffer.fill(0);
    this.#released = true;
  }
}

class SecretFileError extends Error {}

function fixedFileError(message: string): SecretFileError {
  return new SecretFileError(message);
}

function isNoFollowError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "ELOOP" || error.code === "EMLINK";
}

function validateRootMetadata(metadata: BigIntStats): void {
  if (!metadata.isDirectory()) throw fixedFileError("Secret root must be a directory");
  const currentUid = process.getuid?.();
  if (currentUid === undefined || metadata.uid !== BigInt(currentUid)) {
    throw fixedFileError("Secret root must be owned by the current uid");
  }
  if ((metadata.mode & 0o7777n) !== 0o700n) {
    throw fixedFileError("Secret root permissions must be exactly 0700");
  }
}

async function validateProtectedAncestors(canonicalRoot: string): Promise<void> {
  const currentUid = process.getuid?.();
  if (currentUid === undefined) {
    throw fixedFileError("Secret root ownership cannot be verified");
  }
  const ownerUid = BigInt(currentUid);
  let path = canonicalRoot;
  let isSecretRoot = true;
  while (true) {
    let metadata: BigIntStats;
    try {
      metadata = await lstat(path, { bigint: true });
    } catch {
      throw fixedFileError(isSecretRoot
        ? "Secret root metadata is unavailable"
        : "Secret ancestor metadata is unavailable");
    }
    if (!metadata.isDirectory()) {
      throw fixedFileError(isSecretRoot
        ? "Secret root must be a directory"
        : "Secret ancestor must be a directory");
    }
    if (isSecretRoot) {
      validateRootMetadata(metadata);
    } else {
      if (metadata.uid !== 0n && metadata.uid !== ownerUid) {
        throw fixedFileError("Secret ancestor must be owned by root or the current uid");
      }
      if ((metadata.mode & 0o22n) !== 0n) {
        throw fixedFileError("Secret ancestor permissions must prohibit group and other writes");
      }
    }

    const parent = dirname(path);
    if (parent === path) return;
    path = parent;
    isSecretRoot = false;
  }
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return sameIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function boundedRead(handle: FileHandle): Promise<Buffer> {
  const bounded = Buffer.allocUnsafe(boundedReadBytes);
  let offset = 0;
  try {
    while (offset < bounded.length) {
      const { bytesRead } = await handle.read(bounded, offset, bounded.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset === 0) throw fixedFileError("Secret file must not be empty");
    if (offset > maximumSecretBytes) throw fixedFileError("Secret file must not exceed 64 KiB");
    return Buffer.from(bounded.subarray(0, offset));
  } finally {
    bounded.fill(0);
  }
}

export class FileSecretStore implements SecretStore {
  readonly #configuredRoot: string;
  #trustedRoot: RootIdentity | undefined;

  public constructor(root: string) {
    this.#configuredRoot = resolve(root);
  }

  public async get(reference: SecretReference): Promise<SecretMaterial> {
    // Validate untrusted metadata before performing any filesystem operation.
    assertSecretReference(reference);

    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(this.#configuredRoot);
    } catch {
      throw fixedFileError("Secret root is unavailable");
    }
    await validateProtectedAncestors(canonicalRoot);

    let rootHandle: FileHandle;
    try {
      rootHandle = await open(
        canonicalRoot,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
      );
    } catch {
      throw fixedFileError("Secret root could not be opened safely");
    }

    let material: BufferedSecretMaterial | undefined;
    try {
      const rootMetadata = await rootHandle.stat({ bigint: true });
      validateRootMetadata(rootMetadata);
      this.#assertAndRememberRoot(canonicalRoot, rootMetadata);

      const filename = `${reference.reference_id}.v${reference.version}`;
      const path = join(canonicalRoot, filename);
      if (dirname(path) !== canonicalRoot) throw fixedFileError("Invalid secret reference ID");

      let fileHandle: FileHandle;
      try {
        const openPath = resolveSecretChildOpenPath(
          process.platform,
          rootHandle.fd,
          canonicalRoot,
          filename,
        );
        fileHandle = await open(openPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch (error) {
        if (isNoFollowError(error)) {
          throw fixedFileError("Secret reference must resolve to a regular file");
        }
        throw fixedFileError("Secret reference is unavailable");
      }

      try {
        await this.#assertRootStable(canonicalRoot, rootHandle, rootMetadata);
        const before = await fileHandle.stat({ bigint: true });
        this.#validateFileMetadata(before);
        await this.#assertOpenedPathStable(path, before);

        const privateBuffer = await boundedRead(fileHandle);
        try {
          const after = await fileHandle.stat({ bigint: true });
          if (!sameFileSnapshot(before, after)) {
            throw fixedFileError("Secret file changed while being read");
          }
          await this.#assertOpenedPathStable(path, after);
          await this.#assertRootStable(canonicalRoot, rootHandle, rootMetadata);
          material = new BufferedSecretMaterial(reference, privateBuffer);
          return material;
        } catch (error) {
          privateBuffer.fill(0);
          throw error;
        }
      } finally {
        try {
          await fileHandle.close();
        } catch {
          material?.release();
          throw fixedFileError("Secret file could not be closed");
        }
      }
    } catch (error) {
      material?.release();
      if (error instanceof SecretFileError) throw error;
      throw fixedFileError("Secret reference could not be read");
    } finally {
      try {
        await rootHandle.close();
      } catch {
        material?.release();
        throw fixedFileError("Secret root could not be closed");
      }
    }
  }

  #assertAndRememberRoot(canonicalPath: string, metadata: BigIntStats): void {
    const trusted = this.#trustedRoot;
    if (trusted === undefined) {
      this.#trustedRoot = Object.freeze({
        canonicalPath,
        device: metadata.dev,
        inode: metadata.ino,
      });
      return;
    }
    if (
      trusted.canonicalPath !== canonicalPath
      || trusted.device !== metadata.dev
      || trusted.inode !== metadata.ino
    ) {
      throw fixedFileError("Secret root changed after initialization");
    }
  }

  async #assertRootStable(
    canonicalPath: string,
    rootHandle: FileHandle,
    expected: BigIntStats,
  ): Promise<void> {
    const [currentCanonicalPath, handleMetadata, pathMetadata] = await Promise.all([
      realpath(this.#configuredRoot),
      rootHandle.stat({ bigint: true }),
      stat(canonicalPath, { bigint: true }),
    ]);
    validateRootMetadata(handleMetadata);
    validateRootMetadata(pathMetadata);
    if (
      currentCanonicalPath !== canonicalPath
      || !sameIdentity(expected, handleMetadata)
      || !sameIdentity(expected, pathMetadata)
    ) {
      throw fixedFileError("Secret root changed while resolving a reference");
    }
  }

  #validateFileMetadata(metadata: BigIntStats): void {
    if (!metadata.isFile()) throw fixedFileError("Secret reference must resolve to a regular file");
    const currentUid = process.getuid?.();
    if (currentUid === undefined || metadata.uid !== BigInt(currentUid)) {
      throw fixedFileError("Secret file must be owned by the current uid");
    }
    if ((metadata.mode & 0o7777n) !== 0o600n) {
      throw fixedFileError("Secret file permissions must be exactly 0600");
    }
    if (metadata.size === 0n) throw fixedFileError("Secret file must not be empty");
    if (metadata.size > BigInt(maximumSecretBytes)) {
      throw fixedFileError("Secret file must not exceed 64 KiB");
    }
  }

  async #assertOpenedPathStable(path: string, openedMetadata: BigIntStats): Promise<void> {
    const pathMetadata = await lstat(path, { bigint: true });
    if (!pathMetadata.isFile() || !sameIdentity(openedMetadata, pathMetadata)) {
      throw fixedFileError("Secret file changed while being opened");
    }
  }
}
