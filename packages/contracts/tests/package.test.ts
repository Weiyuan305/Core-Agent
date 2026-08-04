import assert from "node:assert/strict";
import test from "node:test";

import { CONTRACT_PACKAGE_VERSION, WIRE_SCHEMA_VERSION } from "../src/index.js";

test("exports the package and wire versions", () => {
  assert.equal(CONTRACT_PACKAGE_VERSION, "0.3.0");
  assert.equal(WIRE_SCHEMA_VERSION, 1);
});
