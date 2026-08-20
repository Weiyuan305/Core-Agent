# Identity Runtime and Public Auth v1 test evidence

This is the go/no-go record for Identity schema `12`, Contracts `0.6.0`,
Identity Gateway `0.1.0`, and pinned Supabase JS/Auth JS `2.112.2`.

## Release status

- Deterministic release gates: **PASS** on 2026-08-20 from a clean official
  disposable PostgreSQL 17/SCRAM topology.
- Opt-in real provider acceptance: **NOT_RUN — real provider credentials are
  not present in the repository or default CI**.
- Public deployment: **NO-GO** until the redacted real provider report is
  `passed` and its cleanup status is `passed`.
- MFA: not enabled in v1; this is an accepted, documented limitation.
- Rollback readiness: forward-only schema, public-auth kill switch, Session
  revocation, previous Gateway binary, and provider dual-mapping window are
  documented in the operations runbook.
- Implementation commit: `b1454ea63a55adc83b330eb50fc012b16b129a75`.

## Mandatory commands

Run every command from a clean checkout. A missing prerequisite, skipped test,
non-zero exit, secret match, or teardown residue is a failure.

```bash
node scripts/verify-no-secret.mjs identity-auth-private-sentinel
npm run contracts:check
npm run check
npm run test:postgres
npm run test:integration
npm run test:browser -w @core-agent/control-plane-web
```

Only in the approved disposable environment described by the operations guide:

```bash
CORE_AGENT_SUPABASE_ACCEPTANCE=1 node scripts/accept-supabase-auth.mjs
```

The abbreviated opt-in command above assumes the required protected file
variables and confirmations are already present. The script itself refuses to
run without them.

## Evidence rules

The provider report schema is closed. It contains only:

- schema/mode/status and cleanup status;
- UTC start/finish timestamps;
- stable stage codes and integer durations;
- the fixed `MFA_NOT_ENABLED` limitation;
- one stable failure code when unsuccessful.

Run `node scripts/verify-no-secret.mjs --identity-acceptance-report <report>`
before retaining it. Never retain raw output, provider URLs/bodies, project
keys, email addresses, passwords, token hashes, OAuth codes, Session secrets,
Cookies, database rows, or browser storage.

## Acceptance-clause mapping

| Design clause | Deterministic evidence | Real-provider evidence | Gate |
| --- | --- | --- | --- |
| 1 B2C graph only | `register-b2c` and production-composition PostgreSQL | email verification stage | deterministic required |
| 2 invitation-only B2B | invitation PostgreSQL and Gateway composition | none; provider-neutral | deterministic required |
| 3 one-mode/one-Tenant actor | identity invariants PostgreSQL | none | deterministic required |
| 4 visible platform authority | platform membership/projector PostgreSQL | none | deterministic required |
| 5 tenant-bounded company admin | B2B role/invitation PostgreSQL | none | deterministic required |
| 6 consultant/profile separation | B2B authority PostgreSQL | none | deterministic required |
| 7 stable Actor on replacement | provider replacement PostgreSQL | same-email and relay-link stages | both |
| 8 Session/CSRF/Origin/PKCE/reset | Gateway unit + real production composition | sign-in, reauth, reset, Apple stages | both |
| 9 Ed25519 lifecycle | Trusted Context unit/API tests | none | deterministic required |
| 10 concurrent convergence | invitation/Session/role/deletion PostgreSQL | exact cleanup | deterministic required |
| 11 non-enumerating errors | Gateway error/timing tests | report contains stable codes only | both |
| 12 deletion/recovery | account-deletion PostgreSQL | exact user cleanup | deterministic required |
| 13 fake/integration/browser | root unit, integration, browser commands | none | deterministic required |
| 14 real Supabase/Apple | opt-in driver tests only | redacted report must pass | pre-deploy required |
| 15 no leakage | sentinel/database/output scanners | closed report scanner | both |

## Provider-stage assertions

The opt-in script requires an empty project and proves, in order:

1. admin-generated signup token hash and `verifyOtp` email verification;
2. password sign-in and a second password authentication for reauth semantics;
3. recovery-token verification, password update, old-password rejection, and
   new-password sign-in;
4. Apple PKCE sign-in automatically joining the existing identical verified
   email subject;
5. authenticated `linkIdentity` manually joining a different Apple private
   relay address to a separate password user without changing its user ID;
6. global provider-session logout and rejection of the logged-out tokens;
7. exact deletion of every user ID created by that run.

Apple consent is intentionally interactive. The authorization URL is passed as
an argument to the local browser launcher and is never written to stdout,
stderr, the report, or a file. The loopback callback accepts one bounded code,
returns a no-store static page, and closes.

## Final deterministic evidence

- Toolchain: Node `v25.5.0`, npm `11.8.0`, Docker Engine `28.5.2`, pinned
  PostgreSQL `17-bookworm`, Playwright `1.62.1` with its pinned Chromium.
- Unit/package gates: Runtime `200`, Contracts `182` with `87` valid and `11`
  invalid fixtures, Runtime Core `90`, Identity Gateway `129`, Control Plane API
  `20`, Worker `100`, Runtime Supervisor `85`, and Web `153` all passed.
- Browser gate: `40` passed and `2` explicitly configured skips across desktop,
  compact, and iPhone projects.
- Cleanup protocol: `48/48` focused ownership/deadline/late-backend cases passed.
- Official disposable database CI: `3/3` passed in `124660.034583ms`; the main
  scenario accepted Runtime Core PostgreSQL `359`, Identity Gateway PostgreSQL
  `2`, Control Plane API PostgreSQL `15`, and integration `98`. Injected failure
  cleanup and output-leak rejection/cleanup also passed with zero labeled Docker
  resource residue.
- Migration `012_email_verification_transactions.sql` SHA-256:
  `2e7a7d0b8f910ff5253ace5dff1f0cc242224ec432e75621f15f57d93d14af12`.
- Supabase JS/Auth JS are both exactly `2.112.2`.
- Opt-in live Supabase/Apple report: **NOT_RUN**. No real provider credential,
  account, token, or report was used or retained; public deployment therefore
  remains **NO-GO**.

Do not reinterpret deterministic success as a live-provider pass. Attach only
a scanner-approved closed provider report when the interactive acceptance is
eventually run.
