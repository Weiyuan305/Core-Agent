# Entitlement and Capability Registry v1 test evidence

This is the go/no-go record for Contracts `0.8.0`, database schema `15`, the
Capability projection Supervisor protocol `2`, and the role-specific service
management Web surface.

## Current status

- Deterministic contract/type/build gates: **PASS** (`npm run check`).
- Runtime contract and acceptance-runner suites: **PASS**, 208/208.
- Real PostgreSQL suites: **PASS**, Runtime Core 445/445, Identity Gateway 3/3,
  and Control Plane API 15/15.
- Real PostgreSQL/fake-Supervisor integration: **PASS**, 105/105, including
  catalog-to-Runtime admission, revocation/in-flight semantics, conflicting
  upgrade/rollback, and B2C idle stop/wake.
- Browser acceptance: **PASS**, 49 passed, 0 failed, 2 documented conditional
  skips across 51 scheduled tests.
- Evidence scans: **PASS**, all seven canaries absent from tracked evidence and all
  five globally forbidden canaries absent from public PostgreSQL text surfaces.
- Opt-in real local Runtime acceptance: **NOT_RUN**. No Docker-compatible local
  Runtime daemon is available after the approved Colima removal. The built-in driver,
  profile-only Compose companion, cleanup modes, and closed report validation are
  implemented and deterministically tested, but this is not a substitute for a live
  report.
- Real managed MCP/tools/Skills: **DISABLED and out of scope**.
- Public authenticated student chat: **NO-GO** until the separate public
  Conversation gateway design is accepted and implemented.

## Executed acceptance record

- Date: `2026-08-25` (`Asia/Shanghai`).
- Implementation commit: `b1fb4e5c79aff22e5396a09ae54ca04b77b4a0db`.
- CI-equivalent teardown review fix: `c1f00a35ce146878f82e5b027704b2ffd90356ad`.
- `npm run check`: exit `0`.
- `npm run test:runtime`: 208 passed, 0 failed, 0 skipped.
- `npm run test:postgres`: Runtime Core 445/445, Identity Gateway 3/3,
  Control Plane API 15/15; all exited `0`.
- `npm run test:integration`: 105 passed, 0 failed, 0 skipped. The B2B
  concurrency authority additionally proves 20 concurrent attempts consume exactly
  3 seats.
- `npm run test:browser -w @core-agent/control-plane-web`: 51 scheduled,
  49 passed, 0 failed, 2 conditional skips.
- Seven tracked-evidence canary scans and five public PostgreSQL canary scans:
  all exited `0`.
- `git diff --check` and all four acceptance-runner `node --check` commands:
  exit `0`.
- `npm run test:runtime:database-auth-topology`: **NOT_RUN** because the local
  Docker daemon is unavailable; its credential-volume behavior is covered by the
  deterministic projector and Compose contract suites, but that does not replace
  the Docker topology run.

The deterministic suites compare every generated Capability manifest to its exact
`sha256:` digest and prove that rollback restores the prior logical Capability set
through a strictly newer generation and therefore a new manifest digest. Disposable
test digest values are not retained as release evidence. No live Runtime manifest
digest exists because the opt-in local run is `NOT_RUN`.

## Mandatory commands

```bash
for canary in \
  synthetic-private-price-canary-8b31f10a \
  synthetic-private-receipt-canary-a4d627ce \
  manifest:sha256:237dc659237dc659237dc659237dc659237dc659237dc659237dc659237dc659 \
  synthetic-private-tool-schema-canary-c981a20f \
  synthetic-private-provider-secret-canary-5d0e126b \
  synthetic-private-external-order-canary-b71f826c \
  synthetic-private-customer-content-canary-09ce74a5
do
  node scripts/verify-no-secret.mjs "$canary"
done
npm run contracts:check
npm run check
npm run test:runtime
npm run test:postgres
npm run test:integration
npm run test:browser -w @core-agent/control-plane-web
```

Only in an approved disposable local Runtime environment:

```bash
CORE_AGENT_CAPABILITY_ACCEPTANCE=1 \
CORE_AGENT_CAPABILITY_ACCEPTANCE_TENANT=synthetic-capability-acceptance-<nonce> \
CORE_AGENT_CAPABILITY_ACCEPTANCE_CLEANUP_MODE=preserve-volume \
npm run accept:capability-runtime
```

## Deterministic acceptance mapping

| Requirement | Evidence |
| --- | --- |
| reviewed immutable Capability and published Pack | Runtime Core PostgreSQL catalog suites and `entitlement-capability.test.ts` |
| B2B seat/B2C automatic resolution | PostgreSQL seat/automatic-assignment suites and full integration slices |
| canonical immutable snapshot and signed context | snapshot, Trusted Context, admission, and integration audit assertions |
| durable intent; no direct Docker | Worker repository/handler tests and fake Supervisor request history |
| exact manifest and availability | protocol-v2 projection test with provision/inspect digest equality |
| exact snapshot on Conversation/Run | integration success and audit snapshot-ref assertion |
| revocation and in-flight completion | held Hermes response plus stale pre-effect and new-admission denial |
| conflict preservation and rollback generation | release/pointer/Runtime before-after PostgreSQL assertions |
| B2C 30-minute stop/wake | real database clock, Worker, fake Supervisor stop/start, one wake intent, retained Volume |
| private material exclusion | seven canaries scanned across database, events, audit, logs, error envelopes, Supervisor, and Hermes |
| role-specific Web management | desktop, compact, and iPhone browser tests with chat fail-closed |

## Evidence handling

The privacy canaries cover price, receipt, artifact, tool schema, provider secret,
external order, and customer content. Every category is injected through its actual
catalog or Entitlement command ingress. Artifact references and opaque external order
references are legitimate only in `capability_versions.artifact_ref` and
`entitlements.external_order_ref`; the database scanner allowlists only those exact
columns. They remain forbidden from public summaries, events, logs, and Runtime/Hermes
requests where not explicitly required. Price, receipt, provider secret, raw tool
schema, and customer content are not legitimate authority fields and must be absent
from every scanned surface.

The optional Runtime report is valid only if its schema is closed and the tenant is
hashed. Never retain raw database output, session/CSRF credentials, provider bodies,
customer/student data, container paths, Docker output, or Hermes prompts. A runner
failure code is not acceptance evidence.

## Remaining exclusions

- No payment provider, checkout, price/tax/invoice/receipt/refund flow.
- No real MCP invocation, managed tool schema, Skill loading, Policy execution,
  Human Approval, or irreversible external write.
- No claim that an authenticated Web user can chat through a public gateway.
- No live local Runtime pass until a Docker-compatible local Runtime is available and
  the built-in driver produces a passing redacted report with successful cleanup.
