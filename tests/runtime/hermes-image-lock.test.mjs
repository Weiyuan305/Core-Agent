import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  hostToImagePlatform,
  resolveHermesImage,
  validateImageLock
} from "../../scripts/resolve-hermes-image.mjs";

const lockUrl = new URL("../../infra/hermes/base-images.lock.json", import.meta.url);
const lock = JSON.parse(await readFile(lockUrl, "utf8"));

test("image lock contains valid immutable references", () => {
  assert.doesNotThrow(() => validateImageLock(lock));
  assert.equal(lock.tag, "v2026.7.7");
  assert.match(resolveHermesImage(lock, "linux/amd64"), /@sha256:[a-f0-9]{64}$/);
  assert.match(resolveHermesImage(lock, "linux/arm64"), /@sha256:[a-f0-9]{64}$/);
});

test("host architecture maps to the matching Linux image", () => {
  assert.equal(hostToImagePlatform("darwin", "arm64"), "linux/arm64");
  assert.equal(hostToImagePlatform("linux", "x64"), "linux/amd64");
  assert.throws(
    () => hostToImagePlatform("linux", "riscv64"),
    /Unsupported host architecture/
  );
});

test("resolver rejects unknown platforms", () => {
  assert.throws(
    () => resolveHermesImage(lock, "linux/s390x"),
    /No locked Hermes image/
  );
});
