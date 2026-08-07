import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const runtimePath = fileURLToPath(
  new URL("../../infra/hermes/runtime", import.meta.url),
);
const installerPath = join(runtimePath, "install_error_projection.py");

function runPython(source, args = []) {
  return spawnSync("python3", ["-c", source, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      PYTHONPATH: runtimePath,
      PYTHONDONTWRITEBYTECODE: "1",
    },
    timeout: 10_000,
  });
}

test("managed Hermes terminal projection emits only the closed safe envelope", () => {
  const result = runPython(String.raw`
import json
from error_projection import project_terminal_failure

class ProviderError(Exception):
    def __init__(self, message, *, status_code=None, code=None):
        super().__init__(message)
        self.status_code = status_code
        self.code = code

cases = [
    (ProviderError("rate limit exceeded", status_code=429), False),
    (ProviderError("upstream unavailable", status_code=503), True),
    (TimeoutError("provider request timed out"), False),
    (ProviderError("credential-canary", status_code=403), False),
    (ProviderError("model-canary", code="model_not_found"), False),
    (ProviderError("invalid JSON response"), True),
    (ProviderError("credential-canary https://private.invalid traceback-canary"), False),
]

print(json.dumps([
    project_terminal_failure(error, partial=partial)
    for error, partial in cases
], sort_keys=True))
`);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const projections = JSON.parse(result.stdout);
  const expected = [
    ["model_busy", true, false],
    ["model_service_unavailable", true, true],
    ["model_response_timeout", true, false],
    ["model_access_denied", false, false],
    ["model_not_available", false, false],
    ["model_response_invalid", false, true],
    ["model_response_invalid", false, false],
  ];

  assert.equal(projections.length, expected.length);
  for (let index = 0; index < projections.length; index += 1) {
    const [errorCode, retryable, partial] = expected[index];
    assert.deepEqual(projections[index], {
      choices: [{ index: 0, delta: {}, finish_reason: "error" }],
      hermes: {
        completed: false,
        partial,
        failed: true,
        error_code: errorCode,
        retryable,
      },
    });
  }

  const serialized = JSON.stringify(projections);
  for (const canary of [
    "credential-canary",
    "private.invalid",
    "traceback-canary",
    "rate limit exceeded",
    "provider request timed out",
  ]) {
    assert.doesNotMatch(serialized, new RegExp(canary, "u"));
  }
});

test("managed Hermes overlay installer is exact, one-shot, and fail-closed", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "core-agent-hermes-overlay-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, "api_server.py");

  const install = runPython(String.raw`
import hashlib
import sys
from install_error_projection import (
    UPSTREAM_AGENT_ERROR_LOG,
    UPSTREAM_IMPORT_ANCHOR,
    UPSTREAM_STREAM_CRASH_BLOCK,
    UPSTREAM_STREAM_TERMINAL_BLOCK,
    install_overlay,
)

path = sys.argv[1]
fixture = "\n".join((
    UPSTREAM_IMPORT_ANCHOR,
    UPSTREAM_AGENT_ERROR_LOG,
    UPSTREAM_STREAM_TERMINAL_BLOCK,
    UPSTREAM_STREAM_CRASH_BLOCK,
))
with open(path, "w", encoding="utf-8") as output:
    output.write(fixture)
source = open(path, "rb").read()
install_overlay(path, expected_sha256=hashlib.sha256(source).hexdigest())
`, [target]);
  assert.equal(install.status, 0, install.stderr);
  assert.equal(install.stdout, "");
  assert.equal(install.stderr, "");

  const patched = await readFile(target, "utf8");
  assert.match(
    patched,
    /from core_agent_error_projection import project_terminal_failure/u,
  );
  assert.doesNotMatch(patched, /finish_chunk\["error"\]/u);
  assert.doesNotMatch(patched, /_tb\.format_exc/u);

  const secondInstall = runPython(String.raw`
import hashlib
import sys
from install_error_projection import OverlayInstallError, install_overlay

path = sys.argv[1]
source = open(path, "rb").read()
try:
    install_overlay(path, expected_sha256=hashlib.sha256(source).hexdigest())
except OverlayInstallError as error:
    sys.stderr.write(error.code + "\n")
    raise SystemExit(1)
`, [target]);
  assert.equal(secondInstall.status, 1);
  assert.equal(secondInstall.stdout, "");
  assert.equal(secondInstall.stderr, "HERMES_PATCH_CONTEXT_INVALID\n");

  await writeFile(target, `${patched}# drift\n`, { mode: 0o600 });
  const drifted = spawnSync("python3", [installerPath, "--target", target], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      PYTHONPATH: runtimePath,
      PYTHONDONTWRITEBYTECODE: "1",
    },
    timeout: 10_000,
  });
  assert.equal(drifted.status, 1);
  assert.equal(drifted.stdout, "");
  assert.equal(drifted.stderr, "HERMES_PATCH_SOURCE_MISMATCH\n");
  assert.doesNotMatch(drifted.stderr, /api_server|drift|private/u);
});
