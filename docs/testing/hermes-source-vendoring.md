# Hermes Source Vendoring Equivalence

Status: Passed for local `linux/arm64` equivalence; release cutover not authorized

Date: 2026-08-10

This record compares the accepted official-image-based Core-Agent runtime with
the first source-built candidate. It is intentionally content-free: evidence is
limited to immutable source identities, image identities, platforms, command
outcomes, counts, fixed states, and allowlisted event families. Conversation
content, provider bodies, headers, credentials, internal endpoints, customer
data, and student data are excluded.

The accepted runtime remains release authority until every gate below passes
and the later manual cutover is separately approved. A local candidate image is
development evidence only and does not modify
`infra/hermes/product-images.lock.json`.

<!-- hermes-source-evidence:start -->
```json
{
  "schema_version": 1,
  "status": "passed",
  "candidate_source_commit": "e57d2773ea7205471925605b233471a2472cadad",
  "upstream_commit": "cc4cab2f592e60a197e796506de9168f74baf3ea",
  "upstream_tree": "fcdc6093750ed0a3a556e20927799d7245ba65e4",
  "product_tree": "d14fc8ade54364ab43c5d541f95c5c3458551075",
  "accepted_image": "ghcr.io/weiyuan305/core-agent-hermes-runtime:v0.1.3@sha256:518bc0734d94c44760a62368a2dbb633ebce511a73534ab987aa621862d2a7be",
  "candidate_image_id": "sha256:9c5fc4ffc8e80d439718ff4330d3a88da6f6de6db1c51f219b38b6369cdad7c3",
  "platform": "linux/arm64",
  "deterministic": {
    "status": "passed",
    "source_verify": "passed",
    "candidate_build": "passed",
    "runtime_contract": "153_of_153_passed",
    "check": "533_of_533_passed",
    "unit": "502_of_502_passed",
    "postgres": "151_of_151_passed",
    "integration": "42_of_42_passed"
  },
  "synthetic": {
    "status": "passed",
    "provisioning_profiles": 2,
    "profile_routes": 2,
    "multi_turn": "passed",
    "new_conversation": "passed",
    "restart_recovery": "passed",
    "explicit_retry": "passed",
    "cleanup": "passed",
    "secret_zeroization": "passed",
    "event_types": [
      "conversation.created",
      "message.created",
      "run.queued",
      "run.started",
      "message.delta",
      "message.completed",
      "run.failed",
      "run.completed"
    ]
  },
  "browser": {
    "status": "passed_deterministic",
    "viewports": [
      "desktop_1440x960",
      "compact_1024x820",
      "iphone_390x844"
    ],
    "streaming": "passed",
    "new_conversation": "passed",
    "partial_failure": "passed",
    "zero_content_failure": "passed",
    "retry": "passed",
    "identity_exposure": "none_detected"
  },
  "live_provider": {
    "status": "passed",
    "multi_turn": "passed",
    "new_conversation": "passed",
    "restart_recovery": "passed",
    "explicit_retry": "passed",
    "controlled_failure_code": "RUN_INTERNAL_ERROR",
    "failed_runs": 1,
    "successful_retries": 1,
    "completed_outputs": 1
  }
}
```
<!-- hermes-source-evidence:end -->

## Current bounded results

- Source provenance verification passed with the locked upstream and product
  trees shown above.
- The local source candidate built successfully for `linux/arm64` using two
  isolated Buildx contexts.
- Image inspection reported runtime user `hermes`, the fixed Core-Agent gateway
  entrypoint, and no credential-bearing environment variable.
- The complete deterministic gates passed: 533 check assertions, 502 unit
  assertions, 151 PostgreSQL assertions, and 42 fake-boundary integration
  assertions. The runtime contract subset accounted for 153 unit assertions.
- Deterministic browser acceptance passed at desktop, compact, and iPhone
  viewports. Twenty-two cases passed and two desktop-only cases were skipped on
  narrower viewports by design. Streaming, Conversation creation, long-list and
  transcript scrolling, partial and zero-content failures, retry, focus,
  overflow, and accessibility were covered without exposing internal identity.

- The strict source-candidate smoke reached `ready`, completed one anonymous
  Run, emitted one completed output, and performed its default ordered cleanup.
- An isolated source-candidate runtime initialized two consultant Profiles.
  Both authenticated Profile model routes returned non-empty allowlisted model
  metadata, while an unknown Profile remained closed. This route-only check
  made no model-provider call.
- The operator-approved live path passed same-Conversation multi-turn reuse,
  new-Conversation isolation, API and Worker restart recovery, and one explicit
  child-Run retry. Only counts, states, allowlisted event families, and the
  fixed controlled-failure code are retained here.
- The controlled failure used fixed invalid ingress material, restored the
  protected original before retry, and revalidated its regular-file identity,
  exact `0600` mode, and non-empty state. The temporary backup was absent after
  completion.
- Final cleanup left no managed runtime container, smoke Compose service,
  two-Profile test container, network, staging directory, or disposable test
  volume. Persistent runtime data volumes remain subject to the existing
  non-destructive retention policy.

This evidence accepts local functional and security equivalence only for the
recorded `linux/arm64` candidate. It does not authorize publication, change the
accepted product-image lock, claim `linux/amd64` coverage, or perform release
cutover.
