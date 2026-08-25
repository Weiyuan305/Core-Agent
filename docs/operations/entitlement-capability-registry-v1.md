# Entitlement and Capability Registry v1 operations

This runbook applies to Contracts `0.8.0`, database schema `15`, Runtime protocol
`2` for Capability projection, and the Identity Gateway `/app/v1` management
surface. It does not enable a real MCP server, managed tool, Skill, payment
provider, checkout, receipt processor, or irreversible external write.

## Release gates

Run from the reviewed checkout against a disposable PostgreSQL 17 database:

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
npm run test:postgres
npm run test:integration
npm run test:browser -w @core-agent/control-plane-web
```

A missing prerequisite, skipped required suite, non-zero exit, teardown residue,
or private-canary match is a release failure. Conditional browser skips are
acceptable only when their documented prerequisite is absent and every scheduled
project completes with zero failures.

The public authenticated Conversation gateway is a separate design and go/no-go
decision. Do not expose the private Control Plane API or represent the disabled
student chat entry as available merely because an Entitlement is `available`.

## Migration and configuration

1. Back up PostgreSQL and record the current application commit, schema version,
   migration checksums, Contracts version, current Pack Releases, Runtime
   generations, and manifest digests.
2. Apply migrations with the protected migrator credential. Schema must finish at
   exactly `15`; migration `014` aligns immutable artifact grammar and migration
   `015` permits a later monotonic Snapshot when a historical Capability set recurs.
   Every already-applied migration remains immutable.
3. Configure `IDENTITY_CATALOG_AUTHORITY_TENANT_ID` to the one active,
   server-managed platform authority Tenant. A platform administrator needs one
   active platform-origin Membership in that exact Tenant.
4. Keep the Identity Gateway, Worker, Supervisor UDS, PostgreSQL, Control Plane,
   and Hermes backplane private except for the already-reviewed public Identity
   ingress. There is no payment ingress in v1.
5. Keep catalog and Entitlement management routes restricted to synthetic
   operators until this runbook's gates pass. The current release has no separate
   entitlement feature-flag variable; rollout is controlled by deployment/ingress,
   platform Membership, and whether any Pack Release or Entitlement is created.

## Catalog review and initial data

Use the authenticated platform `/app/v1/platform/catalog` action versions shown
by the Web client. Every command carries its exact `payload_hash` and idempotency
key. Create only a non-executing immutable manifest reference with an exact semantic
version, known contract reference, supported compatibility, and risk class `read`.
Review the Capability Version, create a Pack Version containing exact reviewed
members, review it, then publish it. Never use `latest`, a version range, a mutable
URL/tag, a nested Pack, `external_write`, or `privileged`.

Stop if ProductEvents or public responses contain artifact/contract references,
compatibility internals, raw tool schema, price, receipt, provider secret,
external-order identity, or customer content.

## Grant, assign, and observe

1. Select one reviewed Pack Version as the Tenant's current release through the
   platform Entitlement action. A release change is preparing until the projection
   becomes available.
2. Grant with `source=platform_manual` and one opaque external order reference.
   Do not store payment payload, price, card data, receipt, customer note, or tool
   name in the command.
3. For B2B, an authenticated same-Tenant company administrator assigns one Pack
   seat to one eligible consultant Profile. For B2C, the grant resolves only to the
   single default student Profile automatically.
4. Observe `preparing -> available` in the public service summary. Internally,
   verify one immutable snapshot ref, one projection generation, the exact
   `sha256:` manifest digest, Runtime `ready/healthy`, and an available Assignment.
5. Inspect the staged Hermes configuration and manifest. Managed MCP servers,
   managed tools, and managed Skills must each be zero. A non-empty tool surface is
   a stop condition, not a warning.

Worker retries remain bounded and idempotent. Diagnose a retry from the durable job,
projection status, Supervisor outcome, manifest digest, and safe failure category.
Never replay an `unsafe_to_replay` effect or repair authority by editing snapshots,
releases, jobs, or Runtime rows manually.

## Suspension, idle lifecycle, conflict, and rollback

- Suspension/revocation/expiry must deny every new Conversation, Run, Trusted
  Context, and future pre-effect authorization immediately. A model-only response
  dispatched before the change may finish against its historical snapshot.
- A B2C Runtime becomes idle-stop eligible only after 30 minutes with zero active
  Conversations and Runs. Stop and wake use idempotent durable Runtime intents and
  preserve the same Volume. A duplicate wake must not enqueue a second start.
- An incompatible Pack upgrade returns `CAPABILITY_CONFLICT` and preserves the
  current release, snapshot pointer, Runtime generation, digest, and Volume.
- Roll back by selecting the previous reviewed Pack Version. This creates a new
  Tenant Pack Release and a strictly newer Runtime generation; it never rewrites a
  historical snapshot or down-migrates the database.

For an application rollback, disable management mutations at ingress, restore the
  previous reviewed application images, retain schema `15`, and leave existing
authority facts unchanged. Re-enable mutations only after the previous binary has
passed schema/Contracts checks and can read every current state.

## Opt-in local Runtime acceptance

The runner is deliberately outside default CI. First complete every protected-file,
immutable-image, local-Docker-context, network, path, UID/GID, and provider prerequisite
in [Runtime v1 local real-smoke guide](runtime-v1-local-smoke.md). Confirm that
`docker info` reaches the selected local daemon; a Docker CLI without a reachable daemon
is not a valid prerequisite. Then add the acceptance-specific variables:

```bash
CORE_AGENT_CAPABILITY_ACCEPTANCE=1 \
CORE_AGENT_CAPABILITY_ACCEPTANCE_TENANT=synthetic-capability-acceptance-<nonce> \
CORE_AGENT_CAPABILITY_ACCEPTANCE_CLEANUP_MODE=preserve-volume \
npm run accept:capability-runtime
```

`remove-volume` is the only alternative cleanup mode. The operational environment
uses the built-in reviewed driver and the profile-only `capability-acceptance` Compose
companion. The companion calls the production catalog, Entitlement, assignment,
Snapshot, idle-lifecycle, and Runtime command implementations through isolated
application and identity database roles; the normal Worker, Supervisor, and Hermes
containers perform the Runtime effects. No external driver injection is required.
Missing or invalid prerequisites fail closed as `CAPABILITY_ACCEPTANCE_FAILED`.

Retain only a passing redacted JSON report. It contains a Tenant hash, states,
generations, manifest digests, zero tool-surface counts, duration, cleanup mode, and
status—never raw IDs, credentials, customer content, paths, URLs, commands, or
provider output.

Do not call the local Runtime acceptance passed unless it proves the exact manifest,
availability, new-admission denial, 30-minute B2C stop/wake with Volume retention,
new-generation rollback, selected cleanup mode, and zero managed MCP/tools/Skills in
one approved disposable run.
