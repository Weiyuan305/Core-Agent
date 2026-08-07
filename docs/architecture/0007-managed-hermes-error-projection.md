# ADR 0007: Managed Hermes Terminal Error Projection

Status: Accepted

Date: 2026-08-07

Decision ID: D20

## Context

Core-Agent consumes Hermes through streaming `/v1/chat/completions`. The pinned
Hermes `v2026.7.30` gateway sends abnormal provider outcomes in a terminal SSE
record that can include the raw exception string in both `error.message` and
`hermes.error`. That data can contain provider response bodies, URLs, model
names, credential fragments, or tracebacks. It is not a safe product protocol.

Core-Agent's extension rule remains plugin-first. Model-provider plugins can
control request construction, but that hook is upstream of several abnormal
provider terminals. Generic post-LLM hooks are not guaranteed to run when the
provider fails before a normal model response exists. Neither hook can prove
that every terminal record has been projected into a complete, closed shape.

The Runtime Core parser must receive a machine-readable failure class without
receiving arbitrary provider text. It must also distinguish a terminal failure
from a transport interruption and preserve partial assistant deltas.

## Decision

The managed Hermes product image owns one narrow overlay at the streaming Chat
Completions terminal projection seam. The overlay is not added to an unrelated
local Hermes checkout and is not applied dynamically by Control Plane code.

The overlay targets exactly:

- upstream image tag: `nousresearch/hermes-agent:v2026.7.30`;
- source path: `/opt/hermes/gateway/platforms/api_server.py`;
- source SHA-256:
  `2d5526cd830e6aebcaecc0d9083cfd3aa63bdcfacc2389b7beec6ca32ae99dd8`.

The image build runs an installer that requires that exact regular file, hash,
and patch context. Missing, changed, previously patched, or ambiguous input
fails the build. The reviewed textual patch lives at
`infra/hermes/patches/v2026.7.30-gateway-error-projection.patch`.

A failed stream emits exactly:

```json
{
  "choices": [{ "index": 0, "delta": {}, "finish_reason": "error" }],
  "hermes": {
    "completed": false,
    "partial": false,
    "failed": true,
    "error_code": "model_service_unavailable",
    "retryable": true
  }
}
```

The only admitted error codes are `model_busy`,
`model_service_unavailable`, `model_response_timeout`,
`model_access_denied`, `model_not_available`, and
`model_response_invalid`. Classification may inspect an internal exception's
bounded type, status, code, and text, but none of those raw values is returned.
Unknown input maps to `model_response_invalid`. Logs contain a fixed failure
code and a generated completion identifier, not the exception string.

Successful terminal records retain the upstream OpenAI-compatible shape. The
overlay does not change prompts, provider selection, tools, memory, request
construction, session routing, or normal delta streaming. Runtime Core remains
responsible for strict terminal validation and durable internal classification.

## Alternatives considered

### Provider plugin only

Rejected for this milestone. It cannot cover failures that occur outside or
before the normal provider response lifecycle, so a raw terminal can still
escape from the gateway.

### General post-LLM hook only

Rejected. Abnormal early provider paths do not guarantee that the hook runs,
and a missing hook invocation would look like an ordinary transport failure.

### Parse raw provider messages in Runtime Core

Rejected. It crosses a trust boundary with arbitrary text, exposes sensitive
data to more components, and makes product behavior depend on unstable vendor
wording.

### Maintain a broad Hermes fork

Rejected for the current scope. It increases upgrade and security review cost
without being necessary for one terminal projection seam.

## Consequences

- The product image has an intentional, documented plugin-first exception.
- Every upstream Hermes upgrade requires re-inspection, a new reviewed patch,
  a new pinned source hash, and the complete release test suite.
- A changed upstream source stops the image build instead of applying a fuzzy
  or partial patch.
- Managed streaming clients receive no provider message, URL, model name,
  credential, response body, or traceback in a failed terminal record.
- Direct use of upstream, unpatched Hermes is outside the Core-Agent managed
  runtime contract.

## Release and rollback

The overlay is first built and tested under an explicitly local tag. It is
published only through the existing manual private multi-platform image
workflow. The immutable product-image lock changes only after both platform
digests are reviewed.

Rollback selects the previous accepted product-image digest and increments the
Runtime generation through the existing lifecycle path. It does not rebuild an
old mutable tag and does not roll back the additive Agent Run database
migration. Tolerant Runtime Core and Gateway consumers continue to map legacy
failures to their conservative unknown/invalid fallbacks.

## Related records

- [Conversation Reliability v1 design](../superpowers/specs/2026-08-07-conversation-reliability-v1-design.md)
- [Hermes Runtime distribution](0001-hermes-runtime-distribution.md)
- [Internal API security and streaming](0004-control-plane-internal-api-security-and-streaming.md)
