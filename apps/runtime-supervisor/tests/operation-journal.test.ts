import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
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

function startRequest() {
  const data = {
    protocol_version: 1 as const,
    operation_id: "operation_journal_stage",
    kind: "start" as const,
    tenant_id: "tenant_a",
    runtime_id: "runtime_a",
    generation: 1,
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

test("two journal instances reserve one digest before either dispatches", async () => {
  const firstJournal = new OperationJournal({ directory: journalRoot });
  const secondJournal = new OperationJournal({ directory: journalRoot });
  let executions = 0;
  let entered!: () => void;
  const firstEntered = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const execute = async () => {
    executions += 1;
    entered();
    await blocked;
    return response();
  };

  const first = firstJournal.run(request(), execute);
  await firstEntered;
  const second = secondJournal.run(request(), execute);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(executions, 1);
  release();
  assert.deepEqual(await second, await first);
  assert.equal(executions, 1);
});

test("an unsafe FIFO reservation cannot be masked by a valid concurrent completion", async () => {
  const digest = createHash("sha256").update(request().operation_id).digest("hex");
  const sourceRoot = join(temporaryRoot, "completed-source");
  await new OperationJournal({ directory: sourceRoot }).run(request(), async () => response());
  const completedBytes = await readFile(join(sourceRoot, `${digest}.json`));

  await mkdir(journalRoot, { mode: 0o700 });
  const reservationPath = join(journalRoot, `${digest}.lock`);
  execFileSync("mkfifo", [reservationPath]);
  await chmod(reservationPath, 0o600);
  let executions = 0;
  const pending = new OperationJournal({ directory: journalRoot }).run(request(), async () => {
    executions += 1;
    return response();
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  await writeFile(join(journalRoot, `${digest}.json`), completedBytes, { mode: 0o600 });
  const writer = await open(reservationPath, "w");
  await writer.close();
  await assert.rejects(pending, /SUPERVISOR_REJECTED: Operation journal record is unsafe/u);
  assert.equal(executions, 0);
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

test("journal atomically advances only request-compatible canonical reservation stages", async () => {
  const stagedRequest = startRequest();
  const digest = createHash("sha256").update(stagedRequest.operation_id).digest("hex");
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let markAdvanced!: () => void;
  const advanced = new Promise<void>((resolve) => { markAdvanced = resolve; });
  const pending = new OperationJournal({ directory: journalRoot }).run(stagedRequest, async (...args: unknown[]) => {
    const context = args[1] as {
      readonly stage: string;
      readonly recovered: boolean;
      advance(stage: string): Promise<void>;
    } | undefined;
    assert.ok(context, "journal must supply a durable reservation context");
    assert.equal(context.stage, "reserved");
    assert.equal(context.recovered, false);
    await assert.rejects(context.advance("delete_pending"), /SUPERVISOR_REJECTED/u);
    await context.advance("start_pending");
    assert.equal(context.stage, "start_pending");
    markAdvanced();
    await blocked;
    return response(stagedRequest.operation_id);
  });
  await Promise.race([advanced, pending]);

  const reservationPath = join(journalRoot, `${digest}.lock`);
  assert.equal((await lstat(reservationPath)).mode & 0o777, 0o600);
  const reservationText = await readFile(reservationPath, "utf8");
  const reservation = JSON.parse(reservationText) as Record<string, unknown>;
  assert.deepEqual(Object.keys(reservation), ["owner_token", "protocol_version", "request_hash", "stage"]);
  assert.equal(reservation.protocol_version, 1);
  assert.equal(reservation.request_hash, stagedRequest.request_hash);
  assert.equal(reservation.stage, "start_pending");
  assert.doesNotMatch(reservationText, /operation_journal_stage|tenant_a|runtime_a|secret/u);

  release();
  assert.equal((await pending).outcome, "accepted");
});

test("journal rejects every semantically valid noncanonical reservation encoding", async () => {
  const stagedRequest = startRequest();
  const digest = createHash("sha256").update(stagedRequest.operation_id).digest("hex");
  const reservationPath = join(journalRoot, `${digest}.lock`);
  const ownerToken = "a".repeat(64);
  const encodings = [
    `${JSON.stringify({
      protocol_version: 1,
      request_hash: stagedRequest.request_hash,
      owner_token: ownerToken,
      stage: "start_pending",
    })}\n`,
    `{ "owner_token":"${ownerToken}","protocol_version":1,"request_hash":"${stagedRequest.request_hash}","stage":"start_pending"}\n`,
    `{"owner_token":"${ownerToken}","protocol_version":1,"protocol_version":1,"request_hash":"${stagedRequest.request_hash}","stage":"start_pending"}\n`,
    `{"owner_token":"${ownerToken}","protocol_version":1.0,"request_hash":"${stagedRequest.request_hash}","stage":"start_pending"}\n`,
  ];

  for (const [index, encoding] of encodings.entries()) {
    const caseRoot = join(temporaryRoot, `noncanonical-reservation-${index}`);
    await mkdir(caseRoot, { mode: 0o700 });
    const casePath = join(caseRoot, `${digest}.lock`);
    await writeFile(casePath, encoding, { mode: 0o600 });
    const stale = new Date(Date.now() - 151_000);
    await utimes(casePath, stale, stale);
    let dispatched = false;
    await assert.rejects(
      new OperationJournal({ directory: caseRoot }).run(stagedRequest, async () => {
        dispatched = true;
        return response(stagedRequest.operation_id);
      }),
      /SUPERVISOR_REJECTED: Operation journal record is unsafe/u,
    );
    assert.equal(dispatched, false, `encoding ${index} must fail before dispatch`);
  }

  await assert.rejects(lstat(reservationPath), { code: "ENOENT" });
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

test("journal rejects duplicate reordered or whitespace-varied record bytes before dispatch", async () => {
  const digest = createHash("sha256").update(request().operation_id).digest("hex");
  await new OperationJournal({ directory: journalRoot }).run(request(), async () => response());
  const recordPath = join(journalRoot, `${digest}.json`);
  const record = JSON.parse(await readFile(recordPath, "utf8")) as Record<string, unknown>;
  const reordered = {
    response: record.response,
    request_hash: record.request_hash,
    protocol_version: record.protocol_version,
    operation_id: record.operation_id,
    completed_at: record.completed_at,
  };
  const variants = [
    `${JSON.stringify(record, null, 2)}\n`,
    `${JSON.stringify(reordered)}\n`,
    `${JSON.stringify(record).replace(
      '{"completed_at":',
      `{"completed_at":${JSON.stringify(record.completed_at)},"completed_at":`,
    )}\n`,
  ];
  for (const variant of variants) {
    await writeFile(recordPath, variant, { encoding: "utf8", mode: 0o600 });
    let dispatched = false;
    await assert.rejects(
      new OperationJournal({ directory: journalRoot }).run(request(), async () => {
        dispatched = true;
        return response();
      }),
      /SUPERVISOR_REJECTED/,
    );
    assert.equal(dispatched, false);
  }
});

test("journal rejects a writable ancestor before dispatch", async () => {
  await chmod(temporaryRoot, 0o770);
  let dispatched = false;
  await assert.rejects(
    new OperationJournal({ directory: journalRoot }).run(request(), async () => {
      dispatched = true;
      return response();
    }),
    /SUPERVISOR_REJECTED/,
  );
  assert.equal(dispatched, false);
});

test("journal recovers a digest-scoped stale reservation and bounds staleness beyond operations", async () => {
  assert.throws(
    () => new OperationJournal({ directory: journalRoot, reservationStaleMs: 120_000 }),
    /SUPERVISOR_REJECTED/,
  );
  const digest = createHash("sha256").update(request().operation_id).digest("hex");
  await new OperationJournal({ directory: journalRoot }).run(
    { ...request(), operation_id: "prepare_journal", request_hash: canonicalSupervisorRequestHash({
      protocol_version: 1,
      operation_id: "prepare_journal",
      kind: "inspect",
      tenant_id: "tenant_a",
      runtime_id: "runtime_a",
      generation: 1,
    }) },
    async () => response("prepare_journal"),
  );
  const lockPath = join(journalRoot, `${digest}.lock`);
  await writeFile(lockPath, `${JSON.stringify({
    protocol_version: 1,
    request_hash: request().request_hash,
    owner_token: "a".repeat(64),
    stage: "reserved",
  })}\n`, { mode: 0o600 });
  const stale = new Date(Date.now() - 151_000);
  await utimes(lockPath, stale, stale);

  let executions = 0;
  const result = await new OperationJournal({ directory: journalRoot }).run(request(), async () => {
    executions += 1;
    return response();
  });
  assert.equal(result.outcome, "accepted");
  assert.equal(executions, 1);
  await assert.rejects(lstat(lockPath), { code: "ENOENT" });
});
