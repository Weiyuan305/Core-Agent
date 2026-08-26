import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { EXPECTED_SCHEMA_VERSION } from "../src/db/schema-version.js";

const migrationUrl = new URL("../migrations/016_policy_mcp_gateway.sql", import.meta.url);

test("schema 16 adds the complete policy MCP authority", async () => {
  assert.equal(EXPECTED_SCHEMA_VERSION, 16);
  const migration = await readFile(migrationUrl, "utf8");
  for (const relation of [
    "policy_versions",
    "mcp_server_versions",
    "mcp_tool_bindings",
    "policy_sessions",
    "policy_decisions",
    "policy_execution_proofs",
    "mcp_tool_calls",
  ]) {
    assert.match(migration, new RegExp(`create table ${relation} \\(`));
  }
  assert.doesNotMatch(migration, /proof_plaintext|raw_arguments|raw_result/iu);
});

test("published policy and MCP catalog rows are immutable", async () => {
  const migration = await readFile(migrationUrl, "utf8");
  assert.match(migration, /core_agent_enforce_policy_catalog_immutable/);
  for (const relation of ["policy_versions", "mcp_server_versions", "mcp_tool_bindings"]) {
    assert.match(migration, new RegExp(`create trigger ${relation}_immutable`));
  }
});

test("proof and call storage exposes only digest and safe metadata", async () => {
  const migration = await readFile(migrationUrl, "utf8");
  assert.match(migration, /proof_digest bytea not null unique/);
  assert.match(migration, /arguments_hash text not null/);
  assert.match(migration, /safe_result_summary text/);
  assert.match(migration, /policy_execution_proofs_state_check/);
  assert.match(migration, /policy_sessions_active_runtime_session_key/);
  assert.match(migration, /constraint mcp_tool_calls_lifecycle_check check/);
  assert.match(migration, /status = 'requested' and started_at is null and finished_at is null/);
  assert.match(migration, /status = 'succeeded' and started_at is not null[\s\S]+finished_at is not null/);
  assert.match(migration, /expires_at > created_at and updated_at >= created_at/);
  assert.match(migration, /consumed_at >= created_at and consumed_at <= expires_at/);
  assert.match(migration, /state = 'expired'[\s\S]+invalidated_at >= expires_at/);
  assert.match(migration, /started_at is null or started_at >= requested_at/);
});
