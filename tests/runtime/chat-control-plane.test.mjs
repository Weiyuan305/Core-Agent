import assert from "node:assert/strict";
import test from "node:test";

import {
  parseChatArguments,
  validateChatInput,
} from "../../scripts/lib/control-plane-chat.mjs";

test("chat arguments allow only the optional retained-runtime flag", () => {
  const defaults = parseChatArguments([]);
  const retained = parseChatArguments(["--keep-runtime"]);

  assert.deepEqual(defaults, { keepRuntime: false });
  assert.deepEqual(retained, { keepRuntime: true });
  assert.ok(Object.isFrozen(defaults));
  assert.ok(Object.isFrozen(retained));

  for (const argv of [
    ["--unknown"],
    ["--keep-runtime", "--keep-runtime"],
    ["--keep-runtime", "extra"],
    "--keep-runtime",
    [1],
  ]) {
    assert.throws(() => parseChatArguments(argv), /^Error: CHAT_ARGUMENT_INVALID$/u);
  }
});

test("chat input accepts bounded text and exact commands", () => {
  for (const value of [
    "anonymous synthetic question",
    "x".repeat(4_000),
    "/new",
    "/restart",
    "/exit",
  ]) {
    assert.equal(validateChatInput(value), value);
  }
});

test("chat input rejects unsafe text and command prefixes with fixed errors", () => {
  for (const value of [
    "",
    "   ",
    "x".repeat(4_001),
    "unsafe\u0000control",
    "unsafe\u001fcontrol",
    "unsafe\u007fcontrol",
    "\ud800",
    "/exit now",
    "/new conversation",
    "/restart api",
    null,
    1,
    {},
  ]) {
    assert.throws(() => validateChatInput(value), /^Error: CHAT_INPUT_INVALID$/u);
  }
});
