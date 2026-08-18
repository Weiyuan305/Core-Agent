import assert from "node:assert/strict";
import test from "node:test";

import { strictUtcTimestampMilliseconds } from "@core-agent/runtime-core";

test("strict UTC timestamp parser accepts Supabase RFC3339 Z precision from zero through nine fractional digits", () => {
  const expected = Date.parse("2026-08-17T02:03:04.123Z");
  for (const value of [
    "2026-08-17T02:03:04.123Z",
    "2026-08-17T02:03:04.1230Z",
    "2026-08-17T02:03:04.123000000Z",
  ]) assert.equal(strictUtcTimestampMilliseconds(value), expected, value);
  assert.equal(strictUtcTimestampMilliseconds("2026-08-17T02:03:04Z"), Date.parse("2026-08-17T02:03:04.000Z"));
  assert.equal(strictUtcTimestampMilliseconds("2026-08-17T02:03:04.1Z"), Date.parse("2026-08-17T02:03:04.100Z"));
  assert.equal(strictUtcTimestampMilliseconds("2026-08-17T02:03:04.12Z"), Date.parse("2026-08-17T02:03:04.120Z"));
  assert.equal(strictUtcTimestampMilliseconds("2026-08-17T02:03:04.123456789Z"), expected);
});

test("strict UTC timestamp parser rejects invalid calendar values, offsets, excess precision, and garbage", () => {
  for (const value of [
    "2025-02-29T02:03:04Z",
    "2026-13-01T02:03:04Z",
    "2026-08-17T24:00:00Z",
    "2026-08-17T02:60:00Z",
    "2026-08-17T02:03:60Z",
    "2026-08-17T02:03:04.Z",
    "2026-08-17T02:03:04.1234567890Z",
    "2026-08-17T02:03:04+00:00",
    "2026-08-17T02:03:04.123z",
    "2026-08-17T02:03:04.123Zgarbage",
  ]) assert.equal(strictUtcTimestampMilliseconds(value), undefined, value);
});
