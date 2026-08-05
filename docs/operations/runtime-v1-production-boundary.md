# Runtime v1 production boundary

Runtime v1 targets one controlled Linux host. It is an internal platform slice,
not a public product surface. Real customer or student use is prohibited until
the separate Identity, Consent, Retention, and Data Governance phases are
accepted and implemented.

## Host and service boundary

- Run API, Worker, and Supervisor as separate unprivileged service identities.
  Supervisor alone receives Docker socket access; Docker authority is
  effectively root-equivalent and must never reach API, Worker, a Hermes
  runtime, or a general operator shell.
- Bind API only to a private interface behind the internal service boundary.
  Runtime v1 has no public gateway or human login. Restrict host firewall and
  service discovery to the intended internal caller.
- Place the Worker/Supervisor UDS in a dedicated `0700` parent. Give the socket
  an explicit owner/group and `0660` or stricter mode. Only Worker joins that
  group. Do not reuse the development shared UID arrangement in production.
- Keep Hermes containers on exactly the labeled internal backplane and the
  dedicated non-internal egress bridge, with no host port bindings. Worker
  reaches only the backplane address. Provision egress as the exact local
  `172.31.240.0/24` bridge with gateway `172.31.240.1`, default IPAM, IPv4
  masquerading enabled, and IPv6 and swarm ingress disabled; a collision or
  drift is a deployment failure. Treat egress as a trusted single-host boundary,
  restrict host forwarding/firewall policy, and attach no unrelated container.
  Supervisor adoption must validate the complete prior label set,
  request hash, tenant/runtime identity, generation, volume, network, and image
  digest before it acts.

## PostgreSQL and release roles

Use Supabase PostgreSQL over TLS with certificate and hostname verification.
Create dedicated least-privilege credentials for migration and application
traffic; the application role is not a superuser and cannot create databases
or roles. Keep bootstrap/owner credentials out of long-lived API and Worker
configuration. Restrict Supabase network policy to the production host and
monitor failed authentication separately from application errors.

Run reviewed additive migrations as an explicit release step before starting
the new API/Worker revision. Readiness must verify the exact expected schema
version. Record migration checksum, deployed schema version, application
digest, and product-Hermes digest in release evidence.

## Secret projections

Project each purpose separately:

- API receives only the bootstrap-service file;
- Worker receives only the Hermes-ingress root;
- Supervisor receives distinct provider and ingress roots and never the
  bootstrap key;
- Hermes receives provider material only in its isolated tenant volume and an
  ingress file mount, never a secret value in Docker configuration environment.

Each root is canonical, owner-controlled, exact `0700`, protected through all
ancestors, and non-overlapping with every other purpose. Secret leaves are
current-owner regular, exact `0600`, single-link files. Use an ownership-aware
projection mechanism; do not assume Compose file-secret UID/GID semantics are
portable. Rotate by atomically replacing the approved projection. Never pass
secret bytes through process environment, command line, Docker labels, logs,
events, traces, errors, or PostgreSQL rows.

Supervisor receives paired local and Docker-host roots for staging and managed
ingress. On Linux they are namespace views of the same canonical host
directories. Never pass a container-private `/run/...` path to the host Docker
daemon. Pre-create state-root `staging` and `ingress` children as Supervisor's
uid/gid with `0700`. Initializer, verifier, and gateway use that same explicit
numeric identity; never compensate for mismatch by making provider or ingress
files group/world-readable.

## Product-image rollout

The official Hermes base lock is only a build input. Publish the Core-Agent
product image for each supported platform, capture registry RepoDigests, review
them, and publish one immutable product-image lock. Mount that same lock
read-only into API and Supervisor; do not use a local tag or let the two
processes load different files.

Before rollout, verify the product digest contains the fixed initializer and
gateway entrypoints, run migrations, validate service configuration, and run
deterministic gates. Select the accepted platform digest and increment Runtime
generation for an image change. Canary with synthetic data before any
authorized tenant rollout.

## Backup, restore, and evidence

Back up PostgreSQL authority and tenant Docker volumes on independent schedules
with encryption and access audit. A release is not recoverable merely because
a backup command succeeded: restore PostgreSQL and a representative synthetic
tenant volume on an isolated host, verify schema version, labels, manifest
hash, Profile presence, and a synthetic read path, then record timestamp,
backup identifiers, checksums, duration, and allowlisted final states. Never
put restored content or credentials in the evidence record.

Preserve PostgreSQL truth and tenant volumes when a rollout fails. Quarantine
unmatched Docker resources for investigation; do not relabel, adopt, or delete
them with broad filters.

## Logging and redaction

Use structured allowlisted fields. Error and dependency bodies are reduced to
fixed bounded summaries before persistence. Never log request/response content,
authorization headers, provider errors, Docker raw JSON, SQL row values,
secret paths that reveal tenant identity, or environment values. Apply the
sentinel scanner to application tables and inspect Docker configuration during
every release exercise. Restrict log access and retention even after redaction.

## Rollback

- Roll back application code only when that revision's expected schema version
  exactly equals the deployed schema version.
- Treat additive SQL migrations as roll-forward. Do not automatically
  down-migrate production data.
- Roll back a runtime image by selecting a previously accepted product digest
  and incrementing Runtime generation; never retag a mutable name in place.
- A failed rollout preserves PostgreSQL truth and tenant volumes.
- Supervisor adoption validates prior labels and canonical request hash before
  starting, stopping, replacing, or deleting any resource.

These rules do not implement image draining, secret rotation orchestration, or
multi-node scheduling. Those remain later Runtime phases and cannot be inferred
from a successful Runtime v1 smoke.
