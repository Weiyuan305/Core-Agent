import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
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

function requestFor(operationId: string, generation = 1) {
  const data = {
    protocol_version: 1 as const,
    operation_id: operationId,
    kind: "inspect" as const,
    tenant_id: "tenant_a",
    runtime_id: "runtime_a",
    generation,
  };
  return { ...data, request_hash: canonicalSupervisorRequestHash(data) };
}

function digestFor(operationId: string): string {
  return createHash("sha256").update(operationId).digest("hex");
}

function guardPathFor(operationId: string): string {
  return join(journalRoot, `${digestFor(operationId)}.guard.sqlite`);
}

function stagedRecord(requestValue: ReturnType<typeof startRequest>, stage: string): string {
  return `${canonicalJson({
    operation_id: requestValue.operation_id,
    protocol_version: 1,
    request_hash: requestValue.request_hash,
    stage,
    state: "pending",
  })}\n`;
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

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

let temporaryRoot: string;
let journalRoot: string;

async function runIsolatedJournalScript(source: string): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
      cwd: repositoryRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0 && signal === null) {
        resolvePromise({ stdout, stderr });
      } else {
        rejectPromise(new Error(`isolated journal child failed: code=${code ?? "null"} signal=${signal ?? "null"} stderr=${stderr}`));
      }
    });
  });
}

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

test("a stale path-unlink takeover never permits a second callback", async () => {
  const moduleUrl = new URL("../src/operation-journal.ts", import.meta.url).href;
  const result = await runIsolatedJournalScript(`
    import { createRequire, syncBuiltinESMExports } from "node:module";
    import { createHash } from "node:crypto";
    import { mkdir, writeFile, utimes } from "node:fs/promises";
    import { canonicalSupervisorRequestHash } from "@core-agent/runtime-core";

    const journalRoot = ${JSON.stringify(journalRoot)};
    const requestData = {
      protocol_version: 1,
      operation_id: "operation_journal_private",
      kind: "inspect",
      tenant_id: "tenant_a",
      runtime_id: "runtime_a",
      generation: 1,
    };
    const request = { ...requestData, request_hash: canonicalSupervisorRequestHash(requestData) };
    const digest = createHash("sha256").update(request.operation_id).digest("hex");
    const lockPath = journalRoot + "/" + digest + ".lock";
    await mkdir(journalRoot, { recursive: true, mode: 0o700 });
    await writeFile(lockPath, JSON.stringify({
      owner_token: "a".repeat(64),
      protocol_version: 1,
      request_hash: request.request_hash,
      stage: "reserved",
    }) + "\\n", { mode: 0o600 });
    const stale = new Date(Date.now() - 151_000);
    await utimes(lockPath, stale, stale);

    const require = createRequire(import.meta.url);
    const fsPromises = require("node:fs/promises");
    const originalUnlink = fsPromises.unlink;
    let lockUnlinks = 0;
    let markFirstUnlink;
    const firstUnlinkEntered = new Promise((resolve) => { markFirstUnlink = resolve; });
    let releaseFirstUnlink;
    const firstUnlinkMayProceed = new Promise((resolve) => { releaseFirstUnlink = resolve; });
    fsPromises.unlink = async (path, ...arguments_) => {
      if (String(path) === lockPath && ++lockUnlinks === 1) {
        markFirstUnlink();
        await firstUnlinkMayProceed;
      }
      return originalUnlink(path, ...arguments_);
    };
    syncBuiltinESMExports();
    const { OperationJournal } = await import(${JSON.stringify(moduleUrl)});
    let callbacks = 0;
    let releaseCallbacks;
    const callbacksReleased = new Promise((resolve) => { releaseCallbacks = resolve; });
    let secondCallback;
    const bothCallbacks = new Promise((resolve) => { secondCallback = resolve; });
    const execute = async () => {
      callbacks += 1;
      if (callbacks === 2) secondCallback();
      await callbacksReleased;
      return {
        protocol_version: 1,
        operation_id: request.operation_id,
        outcome: "accepted",
        observation: {
          tenant_id: "tenant_a",
          runtime_id: "runtime_a",
          generation: 1,
          exists: true,
          lifecycle: "running",
          health: "healthy",
          image_ref: "managed/runtime@sha256:${"a".repeat(64)}",
          private_origin: "http://172.30.0.7:8642",
        },
      };
    };
    const first = new OperationJournal({ directory: journalRoot }).run(request, execute);
    void first.catch(() => undefined);
    const attempt = await Promise.race([
      firstUnlinkEntered.then(() => "legacy-unlink"),
      new Promise((resolve) => setTimeout(() => resolve("no-legacy-unlink"), 200)),
    ]);
    if (attempt === "legacy-unlink") {
      const second = new OperationJournal({ directory: journalRoot }).run(request, execute);
      void second.catch(() => undefined);
      const secondStarted = await Promise.race([
        new Promise((resolve) => {
          const timer = setInterval(() => {
            if (callbacks >= 1) {
              clearInterval(timer);
              resolve(true);
            }
          }, 1);
        }),
        new Promise((resolve) => setTimeout(() => resolve(false), 200)),
      ]);
      if (secondStarted) {
        releaseFirstUnlink();
        await Promise.race([
          bothCallbacks,
          new Promise((resolve) => setTimeout(resolve, 200)),
        ]);
      }
      releaseCallbacks();
      await Promise.allSettled([first, second]);
    } else {
      await Promise.allSettled([first]);
    }
    console.log(JSON.stringify({ callbacks }));
  `);
  const report = JSON.parse(result.stdout) as { readonly callbacks: number };
  assert.ok(report.callbacks <= 1, `stale takeover dispatched ${report.callbacks} callbacks`);
});

test("per-operation guards do not serialize unrelated operation IDs", async () => {
  const firstRequest = requestFor("operation_journal_parallel_a");
  const secondRequest = requestFor("operation_journal_parallel_b");
  const firstJournal = new OperationJournal({ directory: journalRoot });
  const secondJournal = new OperationJournal({ directory: journalRoot });
  let entered = 0;
  let markBothEntered!: () => void;
  const bothEntered = new Promise<void>((resolve) => { markBothEntered = resolve; });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const execute = async (requestValue: ReturnType<typeof requestFor>) => {
    entered += 1;
    if (entered === 2) markBothEntered();
    await blocked;
    return response(requestValue.operation_id);
  };

  const first = firstJournal.run(firstRequest, () => execute(firstRequest));
  const second = secondJournal.run(secondRequest, () => execute(secondRequest));
  await Promise.race([
    bothEntered,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("unrelated operation was serialized")), 500)),
  ]);
  release();
  assert.equal((await first).operation_id, firstRequest.operation_id);
  assert.equal((await second).operation_id, secondRequest.operation_id);
  assert.equal((await lstat(guardPathFor(firstRequest.operation_id))).mode & 0o777, 0o600);
  assert.equal((await lstat(guardPathFor(secondRequest.operation_id))).mode & 0o777, 0o600);
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

test("journal permanently retains a bounded digest-named 0600 SQLite guard and replays after restart", async () => {
  const original = new OperationJournal({ directory: journalRoot });
  let executions = 0;
  const first = await original.run(request(), async () => {
    executions += 1;
    return response();
  });
  assert.equal(first.outcome, "accepted");

  const names = await readdir(journalRoot);
  const digest = digestFor(request().operation_id);
  const expectedName = `${digest}.json`;
  const expectedGuardName = `${digest}.guard.sqlite`;
  assert.deepEqual(names.sort(), [expectedGuardName, expectedName]);
  assert.equal(names.some((name) => name.includes(request().operation_id)), false);
  assert.equal((await lstat(journalRoot)).mode & 0o777, 0o700);
  const recordPath = join(journalRoot, expectedName);
  assert.equal((await lstat(recordPath)).mode & 0o777, 0o600);
  const guardMetadata = await lstat(join(journalRoot, expectedGuardName));
  assert.equal(guardMetadata.isFile(), true);
  assert.equal(guardMetadata.mode & 0o777, 0o600);
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

test("journal atomically advances only request-compatible canonical durable stages inside its permanent guard", async () => {
  const stagedRequest = startRequest();
  const digest = createHash("sha256").update(stagedRequest.operation_id).digest("hex");
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let markAdvanced!: () => void;
  const advanced = new Promise<void>((resolve) => { markAdvanced = resolve; });
  const pendingRun = new OperationJournal({ directory: journalRoot }).run(stagedRequest, async (...args: unknown[]) => {
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
  await Promise.race([advanced, pendingRun]);

  try {
    const recordPath = join(journalRoot, `${digest}.json`);
    assert.equal((await lstat(recordPath)).mode & 0o777, 0o600);
    assert.equal((await lstat(guardPathFor(stagedRequest.operation_id))).mode & 0o777, 0o600);
    const pendingText = await readFile(recordPath, "utf8");
    const pending = JSON.parse(pendingText) as Record<string, unknown>;
    assert.deepEqual(Object.keys(pending).sort(), ["operation_id", "protocol_version", "request_hash", "stage", "state"]);
    assert.equal(pending.protocol_version, 1);
    assert.equal(pending.request_hash, stagedRequest.request_hash);
    assert.equal(pending.stage, "start_pending");
    assert.equal(pending.state, "pending");
    assert.doesNotMatch(pendingText, /tenant_a|runtime_a|secret/u);
  } finally {
    release();
    await pendingRun;
  }
});

test("journal rejects every semantically valid noncanonical pending-stage encoding", async () => {
  const stagedRequest = startRequest();
  const digest = createHash("sha256").update(stagedRequest.operation_id).digest("hex");
  const encodings = [
    `${JSON.stringify(JSON.parse(stagedRecord(stagedRequest, "start_pending")), null, 2)}\n`,
    `{ "operation_id":"${stagedRequest.operation_id}","protocol_version":1,"request_hash":"${stagedRequest.request_hash}","stage":"start_pending","state":"pending"}\n`,
    `{"operation_id":"${stagedRequest.operation_id}","protocol_version":1,"protocol_version":1,"request_hash":"${stagedRequest.request_hash}","stage":"start_pending","state":"pending"}\n`,
    `{"operation_id":"${stagedRequest.operation_id}","protocol_version":1.0,"request_hash":"${stagedRequest.request_hash}","stage":"start_pending","state":"pending"}\n`,
  ];

  for (const [index, encoding] of encodings.entries()) {
    const caseRoot = join(temporaryRoot, `noncanonical-reservation-${index}`);
    await mkdir(caseRoot, { mode: 0o700 });
    const casePath = join(caseRoot, `${digest}.json`);
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

test("journal fails closed before dispatch for a symlinked, nonregular, or permissive permanent guard", async () => {
  const operationId = request().operation_id;
  const guardPath = guardPathFor(operationId);
  const unsafeCases: Array<{
    readonly name: string;
    prepare(path: string, root: string): Promise<void>;
  }> = [
    {
      name: "symlink",
      async prepare(path, root) {
        const outside = join(root, "outside.guard.sqlite");
        await writeFile(outside, "SQLite format 3\0", { mode: 0o600 });
        await symlink(outside, path);
      },
    },
    {
      name: "fifo",
      async prepare(path) {
        execFileSync("mkfifo", [path]);
        await chmod(path, 0o600);
      },
    },
    {
      name: "permissive",
      async prepare(path) {
        await writeFile(path, "SQLite format 3\0", { mode: 0o644 });
      },
    },
  ];

  for (const unsafeCase of unsafeCases) {
    const caseRoot = join(temporaryRoot, `unsafe-guard-${unsafeCase.name}`);
    const caseJournalRoot = join(caseRoot, "journal");
    await mkdir(caseJournalRoot, { recursive: true, mode: 0o700 });
    const caseGuardPath = join(caseJournalRoot, `${digestFor(operationId)}.guard.sqlite`);
    await unsafeCase.prepare(caseGuardPath, caseRoot);
    let dispatched = false;
    await assert.rejects(
      new OperationJournal({ directory: caseJournalRoot }).run(request(), async () => {
        dispatched = true;
        return response();
      }),
      /SUPERVISOR_REJECTED: Operation journal record is unsafe/u,
    );
    assert.equal(dispatched, false, `${unsafeCase.name} guard must fail before dispatch`);
  }

  await assert.rejects(lstat(guardPath), { code: "ENOENT" });
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

test("journal fails closed when a legacy digest-scoped reservation is present", async () => {
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
  await writeFile(lockPath, `${canonicalJson({
    protocol_version: 1,
    request_hash: request().request_hash,
    owner_token: "a".repeat(64),
    stage: "reserved",
  })}\n`, { mode: 0o600 });
  const stale = new Date(Date.now() - 151_000);
  await utimes(lockPath, stale, stale);

  let executions = 0;
  await assert.rejects(
    new OperationJournal({ directory: journalRoot }).run(request(), async () => {
      executions += 1;
      return response();
    }),
    /SUPERVISOR_REJECTED: Operation journal record is unsafe/u,
  );
  assert.equal(executions, 0);
  assert.equal((await lstat(lockPath)).isFile(), true);
});
