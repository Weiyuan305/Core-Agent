# Conversation Reliability v1 verification evidence

Status: deterministic verification and real-provider happy path passed

Evidence execution date: 2026-08-07

Evidence recorded: 2026-08-10

This record contains no prompt, assistant response, credential, provider body,
internal URL, or traceback. Synthetic scenarios use only fixed anonymous fixtures.

## Deterministic verification

| Boundary | Result | Evidence |
| --- | --- | --- |
| Contracts and compatibility | Passed | Closed Agent Run codes, optional historic `run.failed.failure_code`, schema release `0.4.0` |
| Runtime Core and Worker | Passed | Managed terminal parsing, exact durable code, no post-dispatch replay, lease-fenced recovery |
| Gateway | Passed | Internal code maps to a closed public reason; internal Run ID and operator summary are absent from Browser frames |
| Web UI | Passed | Zero-content and partial failure states, approved Chinese copy, explicit action state |
| Browser and accessibility | Passed | Desktop, compact, and iPhone projects; six Playwright flows; axe reported zero violations |
| Full integration | Passed | 42 tests, including seven end-to-end Conversation Reliability scenarios |

The end-to-end matrix runs the real local application boundary:

```text
Fake Hermes -> Worker -> PostgreSQL -> ProductEvent -> Client Gateway
```

It covers success, busy, unavailable, timeout, denied, missing model, malformed
response, mid-stream interruption, empty response, an unknown managed terminal,
Runtime inspection failure, concurrent retry admission, failed-child retry chaining,
unsafe-to-replay Worker/API restart recovery, and public Conversation isolation.

For every failed scenario the suite asserts one terminal `run.failed` ProductEvent,
one allowlisted durable `failure_code`, an operator-only bounded
`failure_summary`, a public reason without internal diagnostics, and no automatic
provider replay. Partial deltas remain in the public stream; zero-output failure
creates no assistant message. Concurrent retry requests create one child Run with
the failed parent reference.

Verification commands:

```bash
npm run check
npm test
npm run test:postgres
npm run test:integration
npm run test:runtime
npm run web:build
npm run test:browser -w @core-agent/control-plane-web
git diff --check
```

`npm run check` was executed from a protected short local worktree path because macOS
limits Unix-domain socket path length. The same source tree at the normal nested
worktree path exceeds that host limit in Runtime Supervisor tests; this is a test-host
path constraint, not a changed product result.

## Managed Hermes image evidence

The disposable local image is:

```text
core-agent-hermes-runtime:conversation-reliability-local
sha256:4038409fc441a4322b5292d5df9e0e01d5a3471402b43385cf06573d98b7be05
```

The exact upstream target hash and closed terminal projection passed the offline
synthetic image check. This mutable local image was not published and is not release
evidence. The product-image lock remains unchanged.

## Real-provider acceptance

| Check | Result |
| --- | --- |
| Deterministic happy path | Passed |
| Deterministic failure mapping | Passed |
| Real configured-provider happy path through the current Control Plane and reviewed product image | Passed |
| Conversation Reliability milestone accepted | Yes |

The configured real-provider check used anonymous, non-sensitive Browser input through
Gateway, API, Worker, Runtime Core, and the reviewed managed product image. Two Runs
completed at `2026-08-07T09:59:51.389Z` and `2026-08-07T10:00:52.941Z`. Both reached
`succeeded` with no failure code. Browser observation confirmed incremental assistant
output, terminal recovery to ready, long-transcript scrolling, return-to-latest, and
student-inspector collapse/reopen behavior.

The accepted target was private release `v0.1.3` on `linux/arm64`, locked at
`sha256:518bc0734d94c44760a62368a2dbb633ebce511a73534ab987aa621862d2a7be`.
The running managed container's immutable image reference and image ID matched that
lock. Evidence records no prompt, assistant response, provider identity, header,
credential, internal URL, customer data, or student data.

## Rollback boundary

Database migration 009 is forward-only. A prior application build that does not write
`failure_code` for failed Runs is not compatible after migration. Application rollback
therefore requires a schema-v9-aware build.

Hermes image rollback remains independent and selects the previous reviewed immutable
digest while retaining the schema-v9-aware application:

- `linux/amd64`: `sha256:421f09a140d5b048586749d9f9753f3a2d3fa8571cebac462ae503c646ccb93e`
- `linux/arm64`: `sha256:518bc0734d94c44760a62368a2dbb633ebce511a73534ab987aa621862d2a7be`

No image was published, no product lock changed, and no deployment occurred during
this implementation.

## Product boundary

This milestone is suitable for continued local and internal synthetic evaluation. It
does not authorize public consultant or student data. Identity, Consent, Retention,
Data Governance, and operational support routing remain release gates. The mandatory
non-sensitive real-provider happy path later passed through the reviewed source-built
managed product image and is recorded in the Runtime v1 acceptance evidence.
