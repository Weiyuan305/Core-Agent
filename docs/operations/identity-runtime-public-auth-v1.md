# Identity Runtime and Public Auth v1 operations

This runbook operates the shared public Identity Gateway without publishing the
Control Plane. It applies to Identity schema `12`, Contracts `0.6.0`, Identity
Gateway `0.1.0`, Supabase JS/Auth JS `2.112.2`, Fastify `5.11.2`, and
`@fastify/cookie` `11.1.2`.

Public auth is not permission to process real student data, take payments, run
MCP or Skills, grant Human Approval, or perform irreversible external writes.
Those capabilities remain disabled until their own plans are accepted.

## Release preflight and migration

1. Keep the private Control Plane API, Worker, Supervisor, PostgreSQL, UDS, and
   Hermes networks on private addresses. Only the Identity Gateway ingress may
   be Internet-facing. Confirm that **Control Plane ports remain private** in
   the firewall, load balancer, container-port, and service-discovery diff.
2. Take a restorable PostgreSQL backup and record the current Gateway image,
   schema version, migration checksums, provider configuration revision, and
   Trusted Context public-key registry revision. Database rollback is by
   restoring a backup into a separate environment; migrations are forward-only.
3. Project the migrator password as one owner-controlled regular file. The
   parent is `0700`; the leaf is single-link and exactly `0600`. Never put its
   bytes in an environment variable or command argument.
4. From the reviewed checkout, run:

   ```bash
   CONTROL_PLANE_DATABASE_URL='postgresql://core_agent_migrator@db.example.internal:5432/core_agent_runtime?sslmode=verify-full' \
   CONTROL_PLANE_DATABASE_PASSWORD_FILE=/run/core-agent-secrets/postgres-migrator \
   npm run db:migrate
   ```

5. The command must finish at exact schema version `12`. Stop if migration
   `012_email_verification_transactions.sql`, its manifest checksum, ownership,
   grants, or expected version diverges. Do not edit an applied migration.

## Secret files and process configuration

Project each of the following as a distinct owner-controlled, single-link
regular leaf with mode `0600` below a `0700` root:

- Supabase publishable key;
- Supabase service-role key;
- Core Session HMAC material;
- PII HMAC/encryption material;
- Identity signing/OAuth-transaction material;
- PostgreSQL application password.

Set the corresponding `IDENTITY_*_REF` variables to absolute file paths, not
secret values. Refuse symlinks, permissive modes, mutable shared directories,
and overlapping purposes. Start the Gateway with `IDENTITY_PUBLIC_AUTH_ENABLED=0`.
The required public configuration is closed by
`apps/identity-gateway/src/config.ts`; unknown `IDENTITY_` variables are fatal.

## Supabase and Apple configuration

The **Supabase redirect allowlist** must contain only reviewed exact URLs:

- the production email-verification callback
  `https://<identity-host>/auth/v1/email/verification`;
- the production password-reset callback;
- each approved Web Apple callback;
- the acceptance callback
  `http://127.0.0.1:54329/identity-provider-acceptance/callback` only while an
  operator runs Task 12 acceptance.

Configure the Apple Services ID with the Supabase callback
`https://<project-ref>.supabase.co/auth/v1/callback`. Put the Web Services ID
first in Supabase's Apple client-ID list; native bundle IDs follow. Enable
manual identity linking. Do not wildcard production origins or callbacks.

Apple Web client secrets expire and must be rotated at least every **six months**:

1. create a new Apple signing key/client secret without revoking the current key;
2. update the disposable Supabase project and run the opt-in acceptance below;
3. update production Supabase, canary Apple sign-in and manual linking, and
   observe stable error/latency counters without recording provider bodies;
4. revoke the old Apple key only after the canary passes;
5. if the canary fails, restore the previous Supabase secret while it remains
   valid, disable public Apple routes with the global public-auth flag, and do
   not weaken callback, nonce, state, or PKCE checks.

## Trusted Context signing-key rotation

The order is **publish → activate → retire**:

1. generate a new Ed25519 PKCS#8 private key inside the approved secret system;
2. publish its public SPKI and unique `key_id` in every verifier's
   `CONTROL_PLANE_TRUSTED_CONTEXT_KEYS_FILE` while the old key remains active;
3. restart/reload verifiers and prove both public keys are accepted and unknown
   keys are rejected;
4. atomically project the new private key to the Gateway and activate signing;
5. wait longer than the 300-second maximum context TTL plus the measured clock
   and deployment skew;
6. mark the old public key retired, then remove it in a later release.

A compromised key skips overlap: disable its `key_id`, set
`IDENTITY_PUBLIC_AUTH_ENABLED=0`, revoke affected Core Sessions, and require
fresh authentication after a replacement key is active. Never publish a
private key or reuse signing material for Session HMAC or PII protection.

## Health and staged rollout

Build and start the reviewed Gateway revision before routing public traffic:

```bash
npm run build -w @core-agent/identity-gateway
npm run start -w @core-agent/identity-gateway
```

Startup is healthy only when the process remains ready after its schema-12 and
managed-secret checks. Through the intended TLS ingress, an unauthenticated
`GET /auth/v1/session` must return the stable `401` envelope with `no-store`;
connection failure, `5xx`, provider text, or a schema error is unhealthy.

Keep `IDENTITY_PUBLIC_AUTH_ENABLED=0` for deployment and migration. Then enable
one canary instance with `IDENTITY_PUBLIC_AUTH_ENABLED=1`, route only synthetic
operators, run the deterministic gates and real provider acceptance, and expand
traffic in reviewed steps. At each step watch bounded latency/error codes,
Session issuance/revocation counts, database saturation, and provider outage
signals. Logs must not contain email, provider subject, URL, token, code,
Cookie, password, secret path, or response body.

## Emergency disablement, Session revocation, and rollback

1. Set `IDENTITY_PUBLIC_AUTH_ENABLED=0` and restart every Gateway instance.
   Keep it `0` until the incident owner approves re-entry.
2. Remove Identity Gateway public routes from the edge. Do not expose a Control
   Plane port as a fallback.
3. **Session revocation:** use the reviewed Session-management service for a
   scoped actor/provider incident. For a full emergency, the database owner may
   execute this exact transaction after a backup and change record:

   ```sql
   begin isolation level serializable;
   update core_sessions
      set status = 'revoked',
          revocation_reason = 'admin',
          resource_version = resource_version + 1,
          updated_at = clock_timestamp()
    where status = 'active';
   commit;
   ```

   Record only the affected row count, never Session IDs or digests.
4. Restore the previous reviewed Gateway binary/configuration while leaving
   schema `12` and identity history in place. Do not down-migrate.
5. Provider rollback is allowed only inside the recorded dual-mapping window.
   Keep stable Actor/Tenant/Membership/Profile IDs; never rewrite business
   foreign keys. Revoke Sessions derived from the failed mapping and require
   reauthentication.
6. Re-run health, deterministic security gates, the sentinel scanner, and a
   synthetic canary before restoring any traffic.

## Opt-in real provider acceptance

Use a brand-new empty Supabase project and two dedicated Apple test accounts:
one exact non-relay address in the configured synthetic domain and one Apple
private-relay address. No customer, employee, or student account is allowed.

Create an owner-only directory and six `0600` files (project URL, publishable
key, service-role key, same-email Apple address, relay Apple address, report):

```bash
install -d -m 700 /tmp/core-agent-identity-acceptance
install -m 600 /dev/null /tmp/core-agent-identity-acceptance/supabase-url
install -m 600 /dev/null /tmp/core-agent-identity-acceptance/publishable-key
install -m 600 /dev/null /tmp/core-agent-identity-acceptance/service-role-key
install -m 600 /dev/null /tmp/core-agent-identity-acceptance/apple-same-email
install -m 600 /dev/null /tmp/core-agent-identity-acceptance/apple-relay-email
```

Populate those files through the approved secret manager/editor, never shell
history. The report file may be absent or an existing owner-only `0600` file.
Run from a local graphical session:

```bash
CORE_AGENT_SUPABASE_ACCEPTANCE=1 \
CORE_AGENT_ACCEPTANCE_CONFIRM_DISPOSABLE=1 \
CORE_AGENT_ACCEPTANCE_CONFIRM_SYNTHETIC=1 \
CORE_AGENT_SUPABASE_URL_FILE=/tmp/core-agent-identity-acceptance/supabase-url \
CORE_AGENT_SUPABASE_PUBLISHABLE_KEY_FILE=/tmp/core-agent-identity-acceptance/publishable-key \
CORE_AGENT_SUPABASE_SERVICE_ROLE_KEY_FILE=/tmp/core-agent-identity-acceptance/service-role-key \
CORE_AGENT_APPLE_SAME_EMAIL_FILE=/tmp/core-agent-identity-acceptance/apple-same-email \
CORE_AGENT_APPLE_RELAY_EMAIL_FILE=/tmp/core-agent-identity-acceptance/apple-relay-email \
CORE_AGENT_ACCEPTANCE_SYNTHETIC_DOMAIN=acceptance.example.test \
CORE_AGENT_APPLE_REDIRECT_URI=http://127.0.0.1:54329/identity-provider-acceptance/callback \
CORE_AGENT_ACCEPTANCE_REPORT_PATH=/tmp/core-agent-identity-acceptance/report.json \
node scripts/accept-supabase-auth.mjs

node scripts/verify-no-secret.mjs --identity-acceptance-report \
  /tmp/core-agent-identity-acceptance/report.json
```

The script refuses a non-empty project, opens Apple authorization without
printing the URL, writes only timestamps/stable stage codes/durations, globally
logs out, and deletes the exact created users in `finally`. A failed cleanup is
a failed acceptance. Delete the local secret directory with the approved
secure-workstation procedure after attaching only the redacted report to the
release record.
