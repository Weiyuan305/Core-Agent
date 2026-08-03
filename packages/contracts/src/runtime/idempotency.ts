import Type, { type Static } from "typebox";

import {
  OpaqueIdSchema,
  ResourceVersionSchema,
  SchemaVersionSchema,
} from "../common/primitives.js";

export const PayloadHashSchema = Type.String({ pattern: "^sha256:[a-f0-9]{64}$" });

export const IdempotencyRequestFields = {
  schema_version: SchemaVersionSchema,
  idempotency_key: OpaqueIdSchema,
  payload_hash: PayloadHashSchema,
} as const;

export const IdempotencyRequestSchema = Type.Object(IdempotencyRequestFields, {
  additionalProperties: false,
  $id: "core-agent://v1/idempotency-request",
});

export const VersionedWriteRequestSchema = Type.Object(
  {
    ...IdempotencyRequestFields,
    expected_resource_version: ResourceVersionSchema,
  },
  { additionalProperties: false, $id: "core-agent://v1/versioned-write-request" },
);

export const IdempotencyRecordSchema = Type.Object(
  {
    schema_version: SchemaVersionSchema,
    tenant_id: OpaqueIdSchema,
    idempotency_key: OpaqueIdSchema,
    payload_hash: PayloadHashSchema,
    result_ref: OpaqueIdSchema,
  },
  { additionalProperties: false, $id: "core-agent://v1/idempotency-record" },
);

export type IdempotencyRequest = Static<typeof IdempotencyRequestSchema>;
export type IdempotencyRecord = Static<typeof IdempotencyRecordSchema>;
export type VersionedWriteRequest = Static<typeof VersionedWriteRequestSchema>;

export function resolveIdempotency(
  existing: Pick<IdempotencyRecord, "idempotency_key" | "payload_hash" | "result_ref"> | undefined,
  incoming: Pick<IdempotencyRequest, "idempotency_key" | "payload_hash">,
): { decision: "new" } | { decision: "replay"; result_ref: string } | { decision: "conflict"; error_code: "IDEMPOTENCY_CONFLICT" } {
  if (existing === undefined || existing.idempotency_key !== incoming.idempotency_key) {
    return { decision: "new" };
  }
  if (existing.payload_hash === incoming.payload_hash) {
    return { decision: "replay", result_ref: existing.result_ref };
  }
  return { decision: "conflict", error_code: "IDEMPOTENCY_CONFLICT" };
}
