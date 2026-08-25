# Policy/MCP Gateway v1 operations

This runbook operates schema `16`, Contracts `0.9.0`, the private
`policy-mcp-gateway` plus `policy-gateway-ingress`, the Core-Agent Hermes policy
plugin, and the single reviewed `core_agent.synthetic_profile` fixture. It does
not authorize a remote MCP server, real customer/student data, Skills, writes,
Human Approval, payments, or an Internet-facing Gateway.

## Prerequisites and protected files

Use Node `22.13.0`, PostgreSQL `17`, the reviewed Hermes product-image lock, and
the private paths/UIDs from `.env.runtime.example`. Every Policy file must be a
regular owner-owned, single-link, non-symlink file with mode `0400` or `0600`.
Never put its bytes in environment variables, argv, logs, Git, acceptance output,
or database rows.

Required projections are:

| File | Exact content |
| --- | --- |
| Gateway-owned Worker token and Worker-owned copy | Identical one-line value, at least 32 bytes, no newline; two distinct `0600` inodes owned by each target process identity |
| Plugin identities | JSON array of `{ "token", "tenant_id", "runtime_container_id", "runtime_generation" }`, unique tokens |
| Runtime identities | JSON array of `{ "token", "tenant_id", "profile_id", "runtime_container_id", "runtime_generation" }`, unique tokens |
| Proof key | 32 raw non-NUL bytes or canonical 43-character base64url for 32 bytes |
| Trusted public keys | JSON array of Ed25519 `{ "key_id", "public_key_pem", "status", "activated_at", "retired_at"? }` |
| Worker signing key | One Ed25519 PKCS8 PEM private key |

The Supervisor-owned policy root is a protected `0700` directory. It projects
per-generation Runtime and plugin tokens under deterministic references:
`policy_runtime_<first-32-hex(sha256(tenant_id NUL runtime_id NUL profile_id NUL))>.v<generation>`
and
`policy_plugin_<first-32-hex(sha256(tenant_id NUL runtime_id NUL))>.v<generation>`.
The JSON identity projections used by the Gateway must contain the matching
current values before that Runtime generation is admitted. A token authorizes only
that exact Tenant, Profile where applicable, Runtime container, and generation; it
cannot select another active policy session. Retain the previous generation only for
the bounded rotation overlap, then securely remove it.

## Backup, migration, bootstrap, and start order

1. Back up PostgreSQL and record the application commit, schema version, policy
   hash, binding IDs/status, current Snapshot refs, Runtime generations, and
   product-image digests. Do not copy secret or proof bytes into the record.
2. Apply the protected migrator path and require schema version exactly `16`.
   Migration rollback is forward-only: never edit or drop policy/audit history.
3. Bootstrap the built-in immutable catalog using
   `node scripts/bootstrap-policy-mcp.mjs`. Run it twice; the second run must be
   an idempotent no-op with identical reviewed facts.
4. Start PostgreSQL/auth convergence, migration, `policy-mcp-gateway`, then the
   narrow `policy-gateway-ingress`, Worker, Supervisor, and managed Runtime.
   The Gateway is on `core-agent-control` only. The ingress alone bridges
   control to backplane and publishes no host port.
5. Require `/health` for process liveness and `/ready` for schema, policy hash,
   catalog, credential, and adapter readiness. Liveness alone is not release
   evidence.

## Deterministic canary and audit

Point `CONTROL_PLANE_TEST_DATABASE_URL` only at a disposable `core_agent_*`
PostgreSQL 17 database, then run:

```bash
npm run accept:policy-mcp-gateway
```

The command runs the complete acceptance twice. It starts the real Fastify HTTP
Gateway, executes the real Python Hermes hook, lists the reviewed tool, reads the
synthetic fixture, races two consumers of one proof, and checks the consumed
proof, `tool.requested -> tool.started -> tool.succeeded`, one successful call,
one AuditEvent, closure, and post-close denial. Any customer-like input is a stop
condition.

Operational queries must select identifiers, state, reason, timestamps, counts,
and hashes only. Never select proof digests together with broad diagnostics, raw
arguments, message content, tokens, or provider output. For a canary Run verify:

- one active then closed `policy_sessions` row bound to the exact Run/Profile;
- allow/deny `policy_decisions` with safe reason codes;
- one `policy_execution_proofs.state = 'consumed'` for the successful call;
- one `mcp_tool_calls.status = 'succeeded'` and its three ProductEvents;
- one `audit_events.action = 'tool.invoke'`.

## Revocation, replay, and rotation drills

- Suspend the disposable Entitlement after a session opens. `tools/list` must
  become empty, atomically close the stale session with `authority_changed`, and the
  next decision must be `SESSION_NOT_ACTIVE` without restarting Hermes.
- Reuse a consumed proof with the exact arguments. Exactly one concurrent caller
  may succeed; every replay returns `PROOF_REPLAYED` and creates no second call.
- Change one argument with a valid proof. It must return `PROOF_INVALID` without
  consuming the proof.
- Publish the new Ed25519 public key before activating the matching Worker private
  key. Keep a retired public key only for the maximum context lifetime plus skew,
  then disable it.
- Rotate Worker, plugin, Runtime, and proof keys independently. Runtime/plugin
  rotation requires a new Runtime generation and exact Supervisor adoption check.
  Proof-key rotation drains or invalidates outstanding proofs before removing the
  old in-memory key.

## Rollout, incident response, and rollback

Roll out in this order: migration, immutable bootstrap, Gateway, ingress, Worker,
product Hermes image, then one synthetic Profile. Enable no real domain binding.

On denial storms or suspected compromise: stop new session admission and Gateway
dispatch, drain already-started synthetic reads, close active policy sessions,
rotate the affected scoped identity/key, preserve database audit evidence, and
restore the previous reviewed Worker/Runtime/Gateway images. Schema `16` and its
append-only decisions/calls remain. Do not down-migrate, delete evidence, bypass
the plugin, expose the Gateway, or point Hermes directly at a downstream MCP.

The optional managed-image proof is:

```bash
CORE_AGENT_POLICY_RUNTIME_ACCEPTANCE=1 npm run accept:policy-mcp-runtime
```

It creates disposable owner-only Gateway/Runtime/plugin identities and key material,
bootstraps one reviewed synthetic B2B Entitlement/Snapshot, waits for the exact
reconciled Runtime generation, forces one synthetic read, and requires persisted
successful call, consumed-proof, closed-session, Snapshot-bound audit, and secret-scan
evidence. The disposable material is removed during cleanup. A missing Docker daemon
is reported as `NOT_RUN`, never `PASS`; any attempted scenario failure is `FAIL`.
