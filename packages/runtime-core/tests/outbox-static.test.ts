import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "repositories",
  "outbox.ts",
);
const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const schemaVersionPath = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "db", "schema-version.ts");

test("Outbox claims terminalize exhausted dead leases before normal admission", async () => {
  const source = await readFile(repositoryPath, "utf8");
  const claim = source.match(/export async function claimOutboxWakeups[\s\S]*?\n}\n/)?.[0];

  assert.match(source, /export const OUTBOX_MAX_ATTEMPTS = 10;/);
  assert.match(source, /last_error_summary: OUTBOX_EXHAUSTED_SUMMARY/);
  assert.match(source, /updated_at: sql<Date>`clock_timestamp\(\)`/);
  assert.notEqual(claim, undefined, "claimOutboxWakeups must remain statically inspectable");
  assert.match(claim!, /await recoverExhaustedOutboxWakeups\(trx\);[\s\S]*const candidates/);
});

test("exhausted Outbox recovery is ordered bounded and lock-skipping", async () => {
  const source = await readFile(repositoryPath, "utf8");
  const recovery = source.match(/async function recoverExhaustedOutboxWakeups[\s\S]*?\n}\n/)?.[0];

  assert.match(source, /export const OUTBOX_RECOVERY_BATCH_SIZE = 100;/);
  assert.notEqual(recovery, undefined, "recoverExhaustedOutboxWakeups must remain statically inspectable");
  assert.match(recovery!, /selectFrom\("outbox"\)/);
  assert.match(recovery!, /\.orderBy\("created_at"\)[\s\S]*\.orderBy\("tenant_id"\)[\s\S]*\.orderBy\("outbox_id"\)/);
  assert.match(recovery!, /\.limit\(OUTBOX_RECOVERY_BATCH_SIZE\)/);
  assert.match(recovery!, /\.forUpdate\(\)\.skipLocked\(\)/);
  assert.match(recovery!, /updateTable\("outbox"\)[\s\S]*\.where\("tenant_id", "=", candidate\.tenant_id\)[\s\S]*\.where\("outbox_id", "=", candidate\.outbox_id\)/);
  assert.match(recovery!, /\.where\("attempt_count", ">=", OUTBOX_MAX_ATTEMPTS\)/);
  assert.match(recovery!, /\.where\("status", "=", "pending"\)/);
});

test("current schema retains the version 8 exhausted Outbox recovery index", async () => {
  const migration = await readFile(join(migrationsDirectory, "008_outbox_exhausted_recovery_index.sql"), "utf8");
  const schemaVersion = await readFile(schemaVersionPath, "utf8");

  assert.match(schemaVersion, /export const EXPECTED_SCHEMA_VERSION = 11;/);
  assert.match(migration, /create index outbox_exhausted_recovery_idx/i);
  assert.match(migration, /on outbox \(created_at, tenant_id, outbox_id\)/i);
  assert.match(migration, /include \(lease_owner, lease_expires_at\)/i);
  assert.match(migration, /where status = 'pending' and attempt_count >= 10/i);
});

test("schema version 9 backfills and constrains Agent Run failure codes", async () => {
  const migration = await readFile(
    join(migrationsDirectory, "009_agent_run_failure_code.sql"),
    "utf8",
  ).catch(() => "");
  assert.match(migration, /alter table agent_runs add column failure_code text;/i);
  assert.match(migration, /set failure_code = 'RUN_FAILURE_UNKNOWN'/i);
  assert.match(migration, /agent_runs_failure_code_allowlist_check/i);
  assert.match(migration, /agent_runs_failure_code_state_check/i);
  for (const code of [
    "MODEL_BUSY",
    "MODEL_SERVICE_UNAVAILABLE",
    "MODEL_RESPONSE_TIMEOUT",
    "MODEL_ACCESS_DENIED",
    "MODEL_NOT_AVAILABLE",
    "MODEL_RESPONSE_INVALID",
    "MODEL_STREAM_INTERRUPTED",
    "MODEL_EMPTY_RESPONSE",
    "AGENT_RUNTIME_NOT_READY",
    "RUN_INTERNAL_ERROR",
    "RUN_FAILURE_UNKNOWN",
  ]) assert.match(migration, new RegExp(`'${code}'`));
});
