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

test("Outbox claims terminalize exhausted dead leases before normal admission", async () => {
  const source = await readFile(repositoryPath, "utf8");
  const claim = source.match(/export async function claimOutboxWakeups[\s\S]*?\n}\n/)?.[0];

  assert.match(source, /export const OUTBOX_MAX_ATTEMPTS = 10;/);
  assert.match(source, /last_error_summary: OUTBOX_EXHAUSTED_SUMMARY/);
  assert.match(source, /updated_at: sql<Date>`clock_timestamp\(\)`/);
  assert.notEqual(claim, undefined, "claimOutboxWakeups must remain statically inspectable");
  assert.match(claim!, /await recoverExhaustedOutboxWakeups\(trx\);[\s\S]*const candidates/);
});
