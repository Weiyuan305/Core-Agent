# Policy Plugin and Capability/MCP Gateway v1 Implementation Plan

> **Execution mode:** Implement task-by-task with `superpowers:executing-plans`,
> red-green-refactor, focused verification, and one commit per completed task.

**Goal:** Add a fail-closed private reference monitor that lets an entitled Profile
invoke one reviewed synthetic read-only MCP tool through Hermes while denying stale,
forged, altered, or replayed calls.

**Architecture:** The Worker opens a database-backed policy session for the exact Run.
A product-owned Hermes hook requests a deterministic policy decision and injects a
short-lived opaque proof. The dedicated Policy/MCP Gateway independently consumes the
proof and rechecks current Entitlement authority before calling a narrow downstream
adapter. Global reviewed bindings select the tool and server; neither Hermes nor a
customer supplies an endpoint.

**Tech stack:** Node.js 22.13.0, TypeScript 7, TypeBox 1.3.10, Fastify 5.11.2,
Kysely 0.29.4, PostgreSQL 17, Python 3 in the managed Hermes image, MCP Streamable
HTTP JSON-RPC, existing Docker/Supervisor protocol, Node test runner.

## Global constraints

- Follow `docs/superpowers/specs/2026-08-25-policy-mcp-gateway-v1-design.md`.
  Contradictions require a design amendment, not an implementation shortcut.
- Keep the Gateway outside vendored `third_party/hermes-agent`; verify its locked tree
  remains byte-identical.
- v1 allows only reviewed `mcp` Capability Versions with `read` risk and `none`
  approval. All other kinds, risks, approvals, statuses, and unknown values deny.
- The signed Trusted Context is admission evidence; PostgreSQL current authority is
  rechecked for listing, decision, and proof consumption.
- Never store/log raw tool arguments, proof text, result content, prompt, endpoint,
  credential reference, secret, or student/customer content in audit/events.
- A proof is random, short-lived, digest-stored, exact-argument-bound, and consumed at
  most once under a PostgreSQL row lock.
- No Runtime, browser, Profile, plugin, or model input can select Tenant, policy,
  Capability Version, binding, downstream endpoint, or credential.
- The only executable binding in acceptance is synthetic and deterministic. Do not
  onboard EduApply or real data.
- Keep the normal model-only Run path compatible when policy tools are disabled.
- Use exact Node 22.13.0 for release gates. Local Docker acceptance is opt-in and must
  report `NOT_RUN` if no compatible daemon exists.
- Do not push, merge, deploy, publish a real domain binding, or enable a public flag
  without separate user approval.

## Task map

| Task | Result | Primary gate |
| --- | --- | --- |
| 1 | Contracts 0.9.0 | `npm run contracts:check` |
| 2 | Schema 16 policy/MCP authority | Runtime Core migration tests |
| 3 | Immutable built-in policy and bindings | PostgreSQL catalog tests |
| 4 | Pure fail-closed evaluator and canonical arguments | Policy unit/security tests |
| 5 | Policy sessions, decisions, proofs | PostgreSQL concurrency tests |
| 6 | Audited downstream call lifecycle | Runtime Core integration tests |
| 7 | Private HTTP/MCP Gateway app | Real HTTP JSON-RPC acceptance |
| 8 | Hermes policy plugin and image config | Real Python hook tests |
| 9 | Worker session lifecycle | Worker integration tests |
| 10 | Supervisor/network/secret projection | Runtime topology tests |
| 11 | End-to-end security and acceptance | PostgreSQL + MCP + synthetic tool |
| 12 | CI, runbooks, rollback, final review | Exact Node 22 full gates |

---

### Task 1: Release Policy/MCP contracts as `@core-agent/contracts` 0.9.0

**Files**

- Create: `packages/contracts/src/policy/policy-session.ts`
- Create: `packages/contracts/src/policy/policy-decision.ts`
- Create: `packages/contracts/src/mcp/gateway.ts`
- Modify: `packages/contracts/src/errors/error-envelope.ts`
- Modify: `packages/contracts/src/events/product-event.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/registry.ts`
- Create: `packages/contracts/tests/policy-session.test.ts`
- Create: `packages/contracts/tests/policy-decision.test.ts`
- Create: `packages/contracts/tests/mcp-gateway.test.ts`
- Modify: contract release, compatibility, schema, README, and changelog files

- [x] Write RED tests for exact closed session open/close, decision request/result,
  MCP tool descriptor, safe Tool result, and closed reason-code schemas.
- [x] Prove all resources reject additional fields, accessors, invalid IDs, unsorted
  arrays, raw endpoint/credential/proof fields in safe summaries, and unsupported
  risk/approval branches.
- [x] Add ProductEvent branches for policy session and decision lifecycle containing
  IDs, versions, decision, safe reason, and resource version only.
- [x] Run focused contract tests and record the expected missing-export failure.
- [x] Implement schemas with TypeBox, export them, register every top-level schema,
  and add stable safe errors `POLICY_DENIED` and `TOOL_UNAVAILABLE`.
- [x] Publish additive immutable 0.9.0 compatibility artifacts without changing
  historical 0.2.0-0.8.0 bytes.
- [x] Run `npm run contracts:check` under Node 22.13.0.
- [x] Commit: `feat(contracts): add policy mcp gateway protocol`

### Task 2: Add schema 16 storage and state constraints

**Files**

- Create: `packages/runtime-core/migrations/016_policy_mcp_gateway.sql`
- Create: `packages/runtime-core/src/db/policy-mcp-tables.ts`
- Modify: `packages/runtime-core/src/db/database.ts`
- Modify: `packages/runtime-core/src/db/schema-version.ts`
- Create: `packages/runtime-core/tests/policy-mcp-schema.test.ts`
- Modify: `packages/runtime-core/tests/migrations.test.ts`

- [x] Write RED migration tests for empty-to-16 and 15-to-16 upgrades, exact tables,
  indexes, foreign keys, check constraints, and schema version.
- [x] Add global `policy_versions`, `mcp_server_versions`, and `mcp_tool_bindings`.
  Published/reviewed rows are immutable and bounded; tool bindings reference one exact
  reviewed Capability Version and one exact server version.
- [x] Add tenant-scoped `policy_sessions`, `policy_decisions`,
  `policy_execution_proofs`, and `mcp_tool_calls` with composite Tenant foreign keys.
- [x] Enforce unique active `(runtime_container_id, hermes_session_ref)`, unique
  decision `(policy_session_id, tool_call_id)`, proof digest, one-way state
  vocabularies, database-clock expiry, and bounded safe summaries.
- [x] Add named immutable/history triggers and deny direct terminal-state rewrites
  outside the expected service transitions.
- [x] Add Kysely row types without representing proof plaintext or raw arguments.
- [x] Run Runtime Core migration/unit checks on PostgreSQL 17.
- [x] Commit: `feat(runtime): add policy mcp authority schema`

### Task 3: Bootstrap immutable policy and reviewed synthetic bindings

**Files**

- Create: `packages/runtime-core/src/services/policy/catalog-validation.ts`
- Create: `packages/runtime-core/src/services/policy/bootstrap-policy.ts`
- Create: `packages/runtime-core/src/repositories/policy/catalog.ts`
- Create: `packages/runtime-core/src/policy/builtin-read-policy.ts`
- Create: `infra/policy-mcp/synthetic-bindings.json`
- Create: `scripts/bootstrap-policy-mcp.mjs`
- Create: corresponding Runtime Core and script tests

- [x] Write RED tests for the canonical built-in rule document/hash and synthetic
  server/tool binding.
- [x] Reject mutable versions, public/loopback/arbitrary origins, redirects, unknown
  protocols, remote schema references, open object schemas, duplicate names,
  capability mismatch, and every non-MCP/read/none Capability.
- [x] Implement a bounded JSON-schema subset for reviewed object inputs: string,
  number, integer, boolean, null, arrays, nested closed objects, enum, const, required,
  min/max length/items/value; no `$ref`, format callbacks, defaults, coercion, or code.
- [x] Bootstrap idempotently through exact hashes. Identical replay succeeds;
  same identity with different facts conflicts. Store only an opaque credential ref.
- [x] Provide one disabled-by-default synthetic tool `core_agent.synthetic_profile`
  with a simple closed input and output contract. No customer content.
- [x] Run focused unit and PostgreSQL catalog tests.
- [x] Commit: `feat(policy): add reviewed read mcp catalog`

### Task 4: Implement canonical arguments and the pure policy evaluator

**Files**

- Create: `packages/runtime-core/src/policy/canonical-json.ts`
- Create: `packages/runtime-core/src/policy/argument-validation.ts`
- Create: `packages/runtime-core/src/policy/evaluate-read-mcp.ts`
- Create: focused unit and adversarial security tests

- [x] Write RED table tests for every allow predicate and each closed denial reason.
- [x] Reject non-plain values, accessors, unsupported prototypes, non-finite numbers,
  duplicate parsed keys at the HTTP boundary, reserved proof fields, excessive bytes,
  depth, nodes, properties, arrays, or strings.
- [x] Produce a versioned deterministic canonical JSON byte sequence and SHA-256 hash;
  prove object-key order does not change the hash and semantic changes do.
- [x] Implement the evaluator as a pure function over explicit current-authority,
  Capability, binding, session, and argument facts. Unknown fields/branches deny.
- [x] Prove no evaluator output includes arguments, endpoint, credential, or exception.
- [x] Run focused tests and `git diff --check`.
- [x] Commit: `feat(policy): enforce read mcp decisions`

### Task 5: Implement session admission, decisions, and single-use proofs

**Files**

- Create: `packages/runtime-core/src/repositories/policy/sessions.ts`
- Create: `packages/runtime-core/src/repositories/policy/decisions.ts`
- Create: `packages/runtime-core/src/repositories/policy/proofs.ts`
- Create: `packages/runtime-core/src/services/policy/open-policy-session.ts`
- Create: `packages/runtime-core/src/services/policy/close-policy-session.ts`
- Create: `packages/runtime-core/src/services/policy/issue-tool-decision.ts`
- Create: `packages/runtime-core/src/services/policy/consume-execution-proof.ts`
- Create: PostgreSQL integration and concurrency tests

- [x] Write RED admission tests for signature/audience/issuer/TTL, exact Run/Session/
  Runtime/Snapshot linkage, idempotency, and conflict reuse.
- [x] Open sessions only after `requireCurrentSnapshotAuthority` and current identity,
  session, run, and runtime-generation checks. Use database time for expiry.
- [x] Issue 32-byte random opaque proofs; store only an HMAC-SHA-256 digest using a
  Gateway-only key material interface. Bind all exact facts and cap TTL at 30 seconds.
- [x] Make an identical unconsumed decision idempotent; deny changed arguments/tool,
  duplicate tool-call ID with changed facts, and already-consumed replay.
- [x] Consume under `SELECT ... FOR UPDATE`, recheck current authority in the same
  transaction, mark used once, and invalidate on close/currentness change.
- [x] Run two concurrent consumers against real PostgreSQL and prove exactly one wins.
- [x] Prove tables, audit, errors, and captured logs never contain proof plaintext or
  raw arguments.
- [x] Commit: `feat(policy): add run bound execution proofs`

### Task 6: Implement audited read-only downstream invocation

**Files**

- Create: `packages/runtime-core/src/policy/mcp-invocation-port.ts`
- Create: `packages/runtime-core/src/services/policy/list-authorized-tools.ts`
- Create: `packages/runtime-core/src/services/policy/invoke-authorized-tool.ts`
- Create: `packages/runtime-core/src/repositories/policy/tool-calls.ts`
- Modify: event/audit transaction helpers as needed
- Create: deterministic adapter and lifecycle tests

- [x] Write RED tests for sorted authorized listing, proof stripping, exact downstream
  binding selection, requested/started/terminal transitions, and bounded result.
- [x] Define an injected invocation port that accepts only platform-selected immutable
  binding facts, validated arguments, safe trace identifiers, timeout, and abort
  signal. It cannot accept caller-supplied origin or credentials.
- [x] Implement the deterministic synthetic adapter and an unavailable production
  adapter. v1 readiness denies if a non-synthetic remote adapter is requested.
- [x] Emit Tool ProductEvents and AuditEvents transactionally with IDs/hashes/safe
  reasons only. Record exactly one terminal call outcome.
- [x] Map timeout, adapter, response-contract, and internal errors to calm stable
  failures; never return or log raw exceptions.
- [x] Run unit and PostgreSQL lifecycle tests.
- [x] Commit: `feat(policy): add audited mcp invocation boundary`

### Task 7: Build the private Policy/MCP Gateway application

**Files**

- Create: `apps/policy-mcp-gateway/package.json`
- Create: `apps/policy-mcp-gateway/tsconfig.json`
- Create: `apps/policy-mcp-gateway/src/{config,auth,server,main}.ts`
- Create: `apps/policy-mcp-gateway/src/routes/{sessions,decisions,mcp,health}.ts`
- Create: Gateway HTTP, MCP, and security tests
- Modify: root workspace scripts and lockfile

- [x] Write RED HTTP tests for exact private auth, content type, body/header limits,
  no CORS/cookies/forwarded identity, unknown routes, and safe error envelopes.
- [x] Write RED MCP exchange: `initialize`, initialized notification, `tools/list`,
  decision, proof-injected `tools/call`, and synthetic text result.
- [x] Implement the Streamable HTTP JSON-RPC subset negotiated by vendored Hermes:
  protocol version `2025-03-26`, JSON response mode, `Mcp-Session-Id`, and only the
  allowed methods. Reject batches and unsupported server capabilities.
- [x] Require three separate authentication audiences: Worker session routes, Runtime
  MCP route, and plugin decision route. Compare bounded secrets in constant time.
- [x] Make `/health` liveness-only and `/ready` prove schema 16, built-in policy hash,
  binding bootstrap, proof key, and adapter mode.
- [x] Test malformed JSON/duplicate keys, oversized input, forged identity, protocol
  mismatch, unknown method, changed arguments, no proof, replay, and safe logs.
- [x] Add the app to root `check`, unit, build, and integration commands.
- [x] Commit: `feat(gateway): add private policy mcp service`

### Task 8: Add the fail-closed Hermes Policy Plugin

**Files**

- Create: `infra/hermes/plugins/core-agent-policy/plugin.yaml`
- Create: `infra/hermes/plugins/core-agent-policy/__init__.py`
- Create: `infra/hermes/plugins/core-agent-policy/tests/test_policy_plugin.py`
- Modify: `infra/hermes/Dockerfile`
- Modify: `infra/hermes/managed/config.yaml`
- Modify: managed-image/runtime verification tests

- [x] Write RED Python tests with a real plugin context for allow, denial, timeout,
  malformed JSON, missing config, exception, non-Gateway tool, reserved input, and
  proof overwrite.
- [x] Register only `pre_tool_call`. Read the fixed Gateway origin and Runtime identity
  secret from platform-projected environment/file, never hook arguments or Profile.
- [x] Use a short bounded standard-library HTTP request. On every failure return
  `block`; on allow return `modify` with an exact copied argument object and reserved
  proof.
- [x] Redact proof, arguments, body, headers, and raw exceptions from logs/messages.
- [x] Copy the standalone plugin into the product image, enable only it, and configure
  exactly one `core_agent_gateway` HTTP MCP server with active Profile identity.
- [x] Prove the upstream Hermes source lock/tree is unchanged.
- [x] Run Python plugin tests and managed-image/config tests.
- [x] Commit: `feat(hermes): add core agent policy plugin`

### Task 9: Bind Worker Run execution to policy sessions

**Files**

- Create: `apps/control-plane-worker/src/policy-gateway-client.ts`
- Modify: `apps/control-plane-worker/src/main.ts`
- Modify: `apps/control-plane-worker/src/handlers/execute-agent-run.ts`
- Modify: Worker configuration and tests

- [x] Write RED tests proving a policy-enabled Run opens exactly one session after
  current authority succeeds and before Hermes receives content.
- [x] Project exact signed Trusted Context, Run/Conversation/Core Session/Hermes
  session, Runtime generation, and trace facts through a bounded private client.
- [x] Always attempt close after terminal persistence; retries are idempotent. If open
  fails, do not enter Hermes. If close fails, terminal Run remains correct and expiry
  protects future calls while a bounded cleanup job retries.
- [x] Keep policy-disabled/model-only Runs byte-compatible and do not create sessions.
- [x] Ensure cancellation and crash recovery cannot reuse an active Hermes session for
  another Run.
- [x] Run Worker and execute-run integration tests.
- [x] Commit: `feat(worker): bind runs to policy sessions`

### Task 10: Project Gateway topology and per-Runtime identity

**Files**

- Modify: `apps/runtime-supervisor/src/docker-adapter.ts`
- Modify: Supervisor protocol/config and tests
- Modify: `infra/runtime/compose.dev.yaml`
- Create: `scripts/policy-gateway-ingress-proxy.mjs`
- Modify: runtime-network/path/secret preparation and tests
- Modify: product initializer/entrypoint only where projection requires it

- [x] Write RED exact-inspection tests for the added `core-agent-backplane` endpoint,
  Gateway identity read-only mount, fixed non-secret origin, and absence of database,
  Worker, downstream, or control-plane credentials.
- [x] Add a least-privilege Gateway service on the control network and a narrow ingress
  proxy on control plus backplane; do not publish the ingress on the host.
- [x] Generate/rotate one per-Runtime identity through the existing secret-reference
  boundary and mount it read-only to the managed Runtime. The Supervisor never returns
  its value through API inspection.
- [x] Update exact container/network validation and rollback cleanup. Preserve private
  Tenant network and controlled provider egress behavior.
- [x] Configure Gateway health/readiness, non-root UID, read-only filesystem, dropped
  capabilities, bounded CPU/memory/PIDs, tmpfs, and no Docker socket.
- [x] Run Supervisor unit, runtime topology, compose semantic, and secret-scan tests.
- [x] Commit: `feat(runtime): route hermes through policy gateway`

### Task 11: Add end-to-end deterministic acceptance and adversarial security tests

**Files**

- Create: `tests/integration/policy-mcp-gateway.test.ts`
- Create: `scripts/accept-policy-mcp-gateway.mjs`
- Create: `scripts/accept-policy-mcp-runtime.mjs`
- Create: security fixtures/reports under ignored acceptance output
- Modify: root scripts and CI-equivalent runtime tests

- [x] Start a real temporary PostgreSQL 17 instance, migrate empty-to-16, bootstrap a
  synthetic Tenant/Profile/Entitlement/Snapshot/Runtime/Run and reviewed synthetic
  binding, then start the real Gateway HTTP server.
- [x] Complete initialize/list/decision/call and verify a genuine synthetic read
  response, persisted consumed proof, Tool event sequence, AuditEvent, and closed
  policy session.
- [x] In the same acceptance attempt wrong Tenant/Profile/Runtime, stale Snapshot,
  revoked Entitlement, blocked binding, unknown tool, reserved injection, altered
  arguments, expired proof, concurrent replay, unsupported method, and oversized
  request; prove each denies without leaking existence or input.
- [x] Execute the real Python plugin against the live local Gateway for allow and deny.
- [x] Add an opt-in managed Runtime driver that uses the locked product image and
  reports `PASS`, `FAIL`, or `NOT_RUN` with a reason. Never turn missing Docker into
  deterministic `PASS`.
- [x] Run deterministic acceptance twice to prove idempotent bootstrap and cleanup.
- [x] Commit: `test: accept policy mcp gateway end to end`

### Task 12: Finish CI, operations, rollback, and review

**Files**

- Create: `docs/operations/policy-mcp-gateway.md`
- Modify: `README.md`, `.env.example`, CI workflows, runtime docs, and design status
- Create/update: acceptance report template and compatibility evidence

- [x] Document prerequisites, secret files, bootstrap, start order, readiness, safe
  synthetic canary, audit queries, revocation drill, proof replay drill, rotation,
  backup, rollback, and explicit out-of-scope boundaries.
- [x] Add CI gates for contracts, Gateway, Python plugin, PostgreSQL concurrency,
  deterministic end-to-end, Runtime semantics, source-lock verification, secret scan,
  and `git diff --check`.
- [x] Run exact Node 22.13.0 gates:

  ```bash
  npm exec --yes --package=node@22.13.0 -- npm run check
  npm exec --yes --package=node@22.13.0 -- npm test
  npm exec --yes --package=node@22.13.0 -- npm run test:postgres
  npm exec --yes --package=node@22.13.0 -- npm run test:integration
  npm exec --yes --package=node@22.13.0 -- npm run accept:policy-mcp-gateway
  npm exec --yes --package=node@22.13.0 -- npm audit --omit=dev
  npm exec --yes --package=node@22.13.0 -- node scripts/verify-no-secret.mjs synthetic-policy-mcp-secret-sentinel-v1
  git diff --check
  ```

- [x] Run the opt-in local Runtime acceptance if a Docker-compatible daemon is
  present; otherwise preserve explicit `NOT_RUN` evidence.
- [x] Review every branch against the spec, inspect changed-file scope, search for
  TODO/TBD/placeholders, verify no upstream Hermes change, and confirm no raw
  argument/proof/secret logging.
- [x] Update design status with exact deterministic and live Runtime evidence.
- [x] Commit: `docs: operate policy mcp gateway v1`
- [x] Confirm clean worktree and report exact commits, tests, limitations, and next
  safe step. Do not push or create a PR until the user asks.
