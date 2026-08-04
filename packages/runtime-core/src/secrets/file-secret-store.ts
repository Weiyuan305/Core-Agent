import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { open, realpath, type FileHandle } from "node:fs/promises";

import {
  assertSecretReference,
  type SecretMaterial,
  type SecretReference,
  type SecretStore,
} from "./secret-store.js";

const maximumSecretBytes = 64 * 1024;

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

export class FileSecretStore implements SecretStore {
  readonly #configuredRoot: string;

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

    const filename = `${reference.reference_id}.v${reference.version}`;
    const path = join(canonicalRoot, filename);
    if (dirname(path) !== canonicalRoot) throw fixedFileError("Invalid secret reference ID");

    let handle: FileHandle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (isNoFollowError(error)) {
        throw fixedFileError("Secret reference must resolve to a regular file");
      }
      throw fixedFileError("Secret reference is unavailable");
    }

    let material: BufferedSecretMaterial | undefined;
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) throw fixedFileError("Secret reference must resolve to a regular file");

      const currentUid = process.getuid?.();
      if (currentUid === undefined || metadata.uid !== currentUid) {
        throw fixedFileError("Secret file must be owned by the current uid");
      }
      if ((metadata.mode & 0o7777) !== 0o600) {
        throw fixedFileError("Secret file permissions must be exactly 0600");
      }
      if (metadata.size > maximumSecretBytes) {
        throw fixedFileError("Secret file must not exceed 64 KiB");
      }

      const readBuffer = await handle.readFile();
      try {
        if (readBuffer.length > maximumSecretBytes) {
          throw fixedFileError("Secret file must not exceed 64 KiB");
        }
        material = new BufferedSecretMaterial(reference, Buffer.from(readBuffer));
        return material;
      } finally {
        readBuffer.fill(0);
      }
    } catch (error) {
      material?.release();
      if (error instanceof SecretFileError) throw error;
      throw fixedFileError("Secret reference could not be read");
    } finally {
      try {
        await handle.close();
      } catch {
        material?.release();
        throw fixedFileError("Secret file could not be closed");
      }
    }
  }
}
