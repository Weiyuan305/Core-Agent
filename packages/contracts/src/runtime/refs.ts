import Type, { type Static } from "typebox";

import { OpaqueIdSchema, UtcTimestampSchema } from "../common/primitives.js";
import { type ContractViolation, violation } from "../common/validation.js";

export const StudentRefSchema = Type.Object(
  {
    student_id: OpaqueIdSchema,
    source_system: OpaqueIdSchema,
    source_version: Type.Optional(OpaqueIdSchema),
  },
  { additionalProperties: false, $id: "core-agent://v1/student-ref" },
);

export const CaseRefSchema = Type.Object(
  {
    case_id: OpaqueIdSchema,
    student_id: OpaqueIdSchema,
    capability_id: OpaqueIdSchema,
    source_system: Type.Optional(OpaqueIdSchema),
    source_version: Type.Optional(OpaqueIdSchema),
  },
  { additionalProperties: false, $id: "core-agent://v1/case-ref" },
);

const SnapshotFields = {
  snapshot_id: OpaqueIdSchema,
  version: Type.Integer({ minimum: 1 }),
  evaluated_at: UtcTimestampSchema,
};

export const EntitlementSnapshotRefSchema = Type.Object(SnapshotFields, {
  additionalProperties: false,
  $id: "core-agent://v1/entitlement-snapshot-ref",
});

export const ConsentSnapshotRefSchema = Type.Object(SnapshotFields, {
  additionalProperties: false,
  $id: "core-agent://v1/consent-snapshot-ref",
});

export type StudentRef = Static<typeof StudentRefSchema>;
export type CaseRef = Static<typeof CaseRefSchema>;
export type EntitlementSnapshotRef = Static<typeof EntitlementSnapshotRefSchema>;
export type ConsentSnapshotRef = Static<typeof ConsentSnapshotRefSchema>;

export function validateCaseScope(
  student: StudentRef | undefined,
  caseRef: CaseRef | undefined,
): ContractViolation[] {
  if (caseRef === undefined) return [];
  if (student === undefined) {
    return [
      violation(
        "CASE_REQUIRES_STUDENT",
        "case_ref.student_id",
        "Case scope requires a student reference",
      ),
    ];
  }
  return caseRef.student_id === student.student_id
    ? []
    : [
        violation(
          "CASE_STUDENT_MISMATCH",
          "case_ref.student_id",
          "Case and student scope do not match",
        ),
      ];
}
