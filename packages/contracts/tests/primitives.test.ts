import assert from "node:assert/strict";
import test from "node:test";
import Schema from "typebox/schema";

import {
  CaseRefSchema,
  ResourceMetadataSchema,
  StudentRefSchema,
  validateCaseScope,
} from "../src/index.js";

const metadata = {
  schema_version: 1,
  resource_version: 1,
  created_at: "2026-08-03T01:02:03Z",
  updated_at: "2026-08-03T01:02:03Z",
};

test("resource metadata accepts UTC Z timestamps", () => {
  assert.equal(Schema.Compile(ResourceMetadataSchema).Check(metadata), true);
});

test("resource metadata rejects resource version zero with valid UTC timestamps", () => {
  assert.equal(
    Schema.Compile(ResourceMetadataSchema).Check({
      ...metadata,
      resource_version: 0,
    }),
    false,
  );
});

test("resource metadata rejects timezone offsets with a valid resource version", () => {
  assert.equal(
    Schema.Compile(ResourceMetadataSchema).Check({
      ...metadata,
      updated_at: "2026-08-03T09:02:03+08:00",
    }),
    false,
  );
});

test("opaque references reject empty identifiers", () => {
  assert.equal(
    Schema.Compile(StudentRefSchema).Check({
      student_id: "",
      source_system: "eduapply",
    }),
    false,
  );
  assert.equal(
    Schema.Compile(CaseRefSchema).Check({
      case_id: "case_demo",
      student_id: "student_demo",
      capability_id: "",
    }),
    false,
  );
});

test("case scope must reference the selected student", () => {
  assert.deepEqual(
    validateCaseScope(
      { student_id: "student_demo", source_system: "eduapply" },
      {
        case_id: "case_demo",
        student_id: "student_other",
        capability_id: "eduapply.application",
      },
    ).map((item) => item.code),
    ["CASE_STUDENT_MISMATCH"],
  );
});

test("case scope requires a student reference", () => {
  assert.deepEqual(
    validateCaseScope(undefined, {
      case_id: "case_demo",
      student_id: "student_demo",
      capability_id: "eduapply.application",
    }).map((item) => item.code),
    ["CASE_REQUIRES_STUDENT"],
  );
});
