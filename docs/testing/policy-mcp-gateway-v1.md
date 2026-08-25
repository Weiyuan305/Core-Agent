# Policy/MCP Gateway v1 acceptance evidence

Date: 2026-08-25

| Gate | Required evidence | Result |
| --- | --- | --- |
| Contracts and generated compatibility | Contracts `0.9.0`, historical snapshots, no drift | `npm run check`: PASS |
| Unit and type/build | Runtime policy, Gateway HTTP, Worker lifecycle, Supervisor, Python plugin | `npm test`: PASS |
| PostgreSQL 17 | schema 16 plus exact session/proof/call concurrency | PASS under a dedicated SCRAM role: runtime-core 445, Policy/MCP 7, Identity 3, API 15 |
| Root integration | existing slices plus real Policy/MCP PostgreSQL, HTTP, and Python hook | PASS: 112 assertions |
| Deterministic HTTP/plugin E2E | two consecutive command invocations, each with two clean attempts, genuine synthetic read, adversarial denials | PASS: 7/7 in all four attempts |
| Runtime topology | private Gateway plus narrow ingress, least privilege, no host port | PASS in runtime/Compose checks |
| Managed locked-image tool call | explicit `PASS`, `FAIL`, or `NOT_RUN` | `NOT_RUN`: `DOCKER_DAEMON_UNAVAILABLE` on 2026-08-25 |
| Secret and formatting gates | audit, source lock, no-secret scan, `git diff --check` | PASS; production audit found 0 vulnerabilities |

The managed locked-image result is intentionally not counted as a pass. The required
deterministic acceptance is complete; a future Docker-capable environment must rerun
`npm run accept:policy-mcp-runtime` before claiming live managed-Runtime evidence.

Only synthetic fixture identifiers and pass/fail metadata may be recorded here.
Do not add database credentials, tokens, proofs, paths, customer/student content,
provider output, raw arguments, or general logs.
