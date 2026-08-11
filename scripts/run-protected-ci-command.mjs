#!/usr/bin/env node

import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const maximumOutputBytes = 64 * 1024 * 1024;
const maximumRuntimeMs = 15 * 60 * 1000;

function fixedFailure(message = "protected CI command failed") {
  return new Error(message);
}

async function readProtectedSecret(path) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) throw fixedFailure();
  const named = await lstat(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.()
      || (before.mode & 0o7777) !== 0o600 || before.size < 32 || before.size > 4_096
      || named.dev !== before.dev || named.ino !== before.ino) throw fixedFailure();
    const material = Buffer.alloc(before.size);
    const { bytesRead } = await handle.read(material, 0, material.length, 0);
    const after = await handle.stat();
    if (bytesRead !== material.length || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      material.fill(0);
      throw fixedFailure();
    }
    return material;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.length < 5 || argv[0] !== "--secret-file" || argv[2] !== "--") {
    throw fixedFailure();
  }
  const secretFile = argv[1];
  const command = argv[3];
  const args = argv.slice(4);
  if (typeof command !== "string" || command.length === 0 || args.some((value) => typeof value !== "string")) {
    throw fixedFailure();
  }
  return { secretFile, command, args };
}

function terminate(child) {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill("SIGKILL");
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

export async function runProtectedCiCommand({ secretFile, command, args, environment = process.env }) {
  const secret = await readProtectedSecret(secretFile);
  let total = 0;
  let rejected = false;
  let globalTail = Buffer.alloc(0);
  const stdout = [];
  const stderr = [];
  let timer;
  let child;
  try {
    child = spawn(command, args, {
      cwd: process.cwd(),
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const inspect = (target) => (chunk) => {
      if (rejected) return;
      const bytes = Buffer.from(chunk);
      total += bytes.length;
      const candidate = Buffer.concat([globalTail, bytes]);
      if (total > maximumOutputBytes || candidate.includes(secret)) {
        rejected = true;
        terminate(child);
        return;
      }
      target.push(bytes);
      const retained = Math.max(0, secret.length - 1);
      globalTail = candidate.subarray(Math.max(0, candidate.length - retained));
    };
    child.stdout.on("data", inspect(stdout));
    child.stderr.on("data", inspect(stderr));
    timer = setTimeout(() => {
      rejected = true;
      terminate(child);
    }, maximumRuntimeMs);
    timer.unref?.();
    const outcome = await new Promise((resolvePromise) => {
      child.once("error", () => resolvePromise({ code: null, signal: null }));
      child.once("close", (code, signal) => resolvePromise({ code, signal }));
    });
    if (rejected) return { rejected: true, status: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    return {
      rejected: false,
      status: Number.isInteger(outcome.code) ? outcome.code : 1,
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr),
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    secret.fill(0);
    globalTail.fill(0);
  }
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    const result = await runProtectedCiCommand(options);
    if (result.rejected) {
      process.stderr.write("protected CI command output rejected\n");
      process.exitCode = 1;
      return;
    }
    if (result.stdout.length > 0) process.stdout.write(result.stdout);
    if (result.stderr.length > 0) process.stderr.write(result.stderr);
    process.exitCode = result.status;
  } catch {
    process.stderr.write("protected CI command failed\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
