import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  canonicalSupervisorRequestHash,
  type SupervisorResponseV1,
} from "@core-agent/runtime-core";

import { OperationJournal } from "../src/operation-journal.js";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const imageRef = `managed/runtime@sha256:${"a".repeat(64)}`;

function request(generation = 1) {
  const data = {
    protocol_version: 1 as const,
    operation_id: "operation_journal_private",
    kind: "inspect" as const,
    tenant_id: "tenant_a",
    runtime_id: "runtime_a",
    generation,
  };
  return { ...data, request_hash: canonicalSupervisorRequestHash(data) };
}

function response(operationId = request().operation_id): SupervisorResponseV1 {
  return {
    protocol_version: 1,
    operation_id: operationId,
    outcome: "accepted",
    observation: {
      tenant_id: "tenant_a",
      runtime_id: "runtime_a",
      generation: 1,
      exists: true,
      lifecycle: "running",
      health: "healthy",
      image_ref: imageRef,
      private_origin: "http://172.30.0.7:8642",
    },
  };
}

let temporaryRoot: string;
let journalRoot: string;

test.beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(repositoryRoot, ".supervisor-journal-test-"));
  journalRoot = join(temporaryRoot, "journal");
});

test.afterEach(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

test("journal shares an in-flight hash and rejects a conflicting hash immediately", async () => {
  const journal = new OperationJournal({ directory: journalRoot });
  let executions = 0;
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const execute = async () => {
    executions += 1;
    markEntered();
    await blocked;
    return response();
  };
  const first = journal.run(request(), execute);
  const replay = journal.run(request(), execute);
  await entered;
  const conflict = await journal.run(request(2), execute);
  assert.deepEqual(conflict, {
    protocol_version: 1,
    operation_id: request().operation_id,
    outcome: "rejected",
    code: "SUPERVISOR_REJECTED",
    retryable: false,
    summary: "Operation ID was already used for different request metadata",
  });
  assert.equal(executions, 1);
  release();
  const [firstResponse, replayResponse] = await Promise.all([first, replay]);
  assert.deepEqual(replayResponse, firstResponse);
  assert.equal(executions, 1);
});

test("journal atomically persists a bounded digest-named 0600 record and replays after restart", async () => {
  const original = new OperationJournal({ directory: journalRoot });
  let executions = 0;
  const first = await original.run(request(), async () => {
    executions += 1;
    return response();
  });
  assert.equal(first.outcome, "accepted");

  const names = await readdir(journalRoot);
  const expectedName = `${createHash("sha256").update(request().operation_id).digest("hex")}.json`;
  assert.deepEqual(names, [expectedName]);
  assert.equal(names[0]?.includes(request().operation_id), false);
  assert.equal((await lstat(journalRoot)).mode & 0o777, 0o700);
  const recordPath = join(journalRoot, expectedName);
  assert.equal((await lstat(recordPath)).mode & 0o777, 0o600);
  const recordText = await readFile(recordPath, "utf8");
  const record = JSON.parse(recordText);
  assert.deepEqual(Object.keys(record).sort(), [
    "completed_at",
    "operation_id",
    "protocol_version",
    "request_hash",
    "response",
  ]);
  assert.doesNotMatch(recordText, /synthetic-supervisor|provider_secret|ingress_secret/);

  const restarted = new OperationJournal({ directory: journalRoot });
  const replay = await restarted.run(request(), async () => {
    executions += 1;
    return response();
  });
  assert.deepEqual(replay, first);
  assert.equal(executions, 1);
});

test("journal refuses symlinked or permissive records before dispatch", async () => {
  const digest = createHash("sha256").update(request().operation_id).digest("hex");
  await new OperationJournal({ directory: journalRoot }).run(request(), async () => response());
  const recordPath = join(journalRoot, `${digest}.json`);
  await chmod(recordPath, 0o644);
  let dispatched = false;
  await assert.rejects(
    new OperationJournal({ directory: journalRoot }).run(request(), async () => {
      dispatched = true;
      return response();
    }),
    /SUPERVISOR_REJECTED/,
  );
  assert.equal(dispatched, false);

  await rm(recordPath);
  const outside = join(temporaryRoot, "outside.json");
  await writeFile(outside, "{}", { mode: 0o600 });
  await symlink(outside, recordPath);
  await assert.rejects(
    new OperationJournal({ directory: journalRoot }).run(request(), async () => response()),
    /SUPERVISOR_REJECTED/,
  );
});
