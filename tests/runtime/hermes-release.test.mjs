import assert from "node:assert/strict";
import test from "node:test";

import {
  validateReleaseVersion,
  validateSourceCommit,
} from "../../scripts/generate-hermes-product-lock.mjs";

test("Hermes releases accept only canonical immutable identities", () => {
  assert.equal(validateReleaseVersion("v0.1.0"), "v0.1.0");
  assert.equal(validateSourceCommit("a".repeat(40)), "a".repeat(40));

  for (const value of [
    "latest",
    "0.1.0",
    "v01.0.0",
    "v0.1",
    "v0.1.0-rc.1",
    "v0.1.0\n",
  ]) {
    assert.throws(
      () => validateReleaseVersion(value),
      /RELEASE_VERSION_INVALID/,
    );
  }

  for (const value of ["a".repeat(39), "A".repeat(40), "g".repeat(40), "main"]) {
    assert.throws(
      () => validateSourceCommit(value),
      /RELEASE_SOURCE_COMMIT_INVALID/,
    );
  }
});
