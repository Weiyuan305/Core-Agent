import assert from "node:assert/strict";
import test from "node:test";
import Schema from "typebox/schema";

import * as contracts from "../src/index.js";
import type { ProductEventEnvelope } from "../src/index.js";

test("idempotency contracts are exported", () => {
  assert.equal(typeof contracts.resolveIdempotency, "function");
  assert.notEqual(contracts.VersionedWriteRequestSchema, undefined);
});

test("same idempotency key and payload replays the stored result", () => {
  const payloadHash = `sha256:${"a".repeat(64)}`;
  assert.deepEqual(
    contracts.resolveIdempotency(
      { idempotency_key: "idem_demo", payload_hash: payloadHash, result_ref: "run_demo" },
      { idempotency_key: "idem_demo", payload_hash: payloadHash },
    ),
    { decision: "replay", result_ref: "run_demo" },
  );
});

test("same idempotency key and different payload conflicts", () => {
  assert.deepEqual(
    contracts.resolveIdempotency(
      { idempotency_key: "idem_demo", payload_hash: `sha256:${"a".repeat(64)}`, result_ref: "run_demo" },
      { idempotency_key: "idem_demo", payload_hash: `sha256:${"b".repeat(64)}` },
    ),
    { decision: "conflict", error_code: "IDEMPOTENCY_CONFLICT" },
  );
});

test("versioned writes require an optimistic concurrency version", () => {
  const validator = Schema.Compile(contracts.VersionedWriteRequestSchema);
  const request = { schema_version: 1, idempotency_key: "idem_demo", payload_hash: `sha256:${"a".repeat(64)}` };
  assert.equal(validator.Check(request), false);
  assert.equal(validator.Check({ ...request, expected_resource_version: 7 }), true);
});

const event = (eventId: string, sequence: number): ProductEventEnvelope => ({
  schema_version: 1,
  event_id: eventId,
  event_type: "future.event",
  occurred_at: "2026-08-03T01:02:03Z",
  sequence,
  tenant_id: "tenant_demo",
  request_id: "request_demo",
  trace_id: "trace_demo",
  correlation_id: "conversation_demo",
  causation_id: "run_demo",
  payload: {},
});

test("event consumer deduplicates at-least-once delivery", () => {
  assert.deepEqual(
    contracts.consumeEventBatch({ last_sequence: 3, seen_event_ids: ["event_old"] }, [event("event_four", 4), event("event_four", 4)]),
    { accepted: [event("event_four", 4)], cursor: { last_sequence: 4, seen_event_ids: ["event_old", "event_four"] }, violations: [] },
  );
});

test("event consumer reports out-of-order input without losing cursor", () => {
  const result = contracts.consumeEventBatch({ last_sequence: 3, seen_event_ids: [] }, [event("event_five", 5), event("event_four", 4)]);
  assert.deepEqual(result.violations.map((item) => item.code), ["EVENT_SEQUENCE_OUT_OF_ORDER"]);
  assert.equal(result.cursor.last_sequence, 5);
});

test("unknown events advance the single-stream cursor", () => {
  assert.deepEqual(
    contracts.consumeEventBatch({ last_sequence: 3, seen_event_ids: [] }, [event("event_four", 4)]),
    { accepted: [event("event_four", 4)], cursor: { last_sequence: 4, seen_event_ids: ["event_four"] }, violations: [] },
  );
});

test("approval resume requires current authority versions", () => {
  assert.deepEqual(
    contracts.validateApprovalResume(
      { membership_status: "active", entitlement_version: 7, consent_version: 2, case_scope_valid: true },
      { membership_status: "active", entitlement_version: 8, consent_version: 2, case_scope_valid: true },
    ).map((item) => item.code),
    ["AUTHORITY_CHANGED_AFTER_APPROVAL"],
  );
});

test("approval resume rechecks active membership and case scope", () => {
  assert.deepEqual(
    contracts.validateApprovalResume(
      { membership_status: "active", entitlement_version: 7, consent_version: 2, case_scope_valid: true },
      { membership_status: "revoked", entitlement_version: 7, consent_version: 2, case_scope_valid: false },
    ).map((item) => item.code),
    ["MEMBERSHIP_NOT_ACTIVE", "CASE_SCOPE_INVALID"],
  );
});
