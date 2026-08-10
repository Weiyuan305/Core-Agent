# Runtime v1 local real-smoke guide

This runbook is for anonymous, synthetic acceptance only. Do not use a customer
name, student data, copied conversation, production fixture, or reusable
credential. The script fixes the prompt identifier to
`synthetic-runtime-v1-smoke`, generates `synthetic-` resource identifiers, and
refuses to run unless `CORE_AGENT_REAL_HERMES_SMOKE=1` is exact.

The smoke starts PostgreSQL, migration, API, fixed API ingress, Worker, and
Supervisor under the exact Compose project `core-agent-runtime-v1-smoke`.
Before Supervisor starts, Compose runs one fixed Supervisor-image Docker-socket
preflight and one bounded initializer for the private Supervisor UDS volume.
Generated Hermes runtime resources are owned by the Supervisor.

## Product-image prerequisite

The accepted product-image lock remains runtime authority during the source
vendoring equivalence phase. Do not edit
`infra/hermes/product-images.lock.json` to point at a local candidate.

Build the source candidate from the verified vendored tree with two isolated
Buildx contexts:

```bash
npm run hermes:source:verify
npm run hermes:source:build -- --tag core-agent/hermes-runtime:source-candidate
docker image inspect core-agent/hermes-runtime:source-candidate
```

The selected local image must report the expected host Linux architecture,
runtime user `hermes`, entrypoint
`/opt/core-agent/gateway-entrypoint.sh`, and no credential-bearing environment
variable. The source stage receives only `third_party/hermes-agent`; the product
stage receives the root context filtered by `.dockerignore`. Neither stage may
receive local secrets, runtime state, Git metadata, dependency directories,
screenshots, or dumps.

The earlier official-image development path remains available for baseline and
rollback comparison: `npm run hermes:build` creates
`core-agent/hermes-runtime:dev`. That mutable local tag is not AC10 evidence.

### Managed terminal error projection

The source candidate carries the accepted projection directly in the reviewed
vendored source. Its build must not copy or execute
`install_error_projection.py`; source verification and the downstream Python
contract test are authoritative for this candidate.

ADR 0007 and the historical installer/patch remain unchanged as evidence for
the accepted official-image baseline. That baseline product Dockerfile installs
the narrow error projection described by
[ADR 0007](../architecture/0007-managed-hermes-error-projection.md). For the
locked `v2026.7.30` base, the historical target is
`/opt/hermes/gateway/platforms/api_server.py` with SHA-256
`2d5526cd830e6aebcaecc0d9083cfd3aa63bdcfacc2389b7beec6ca32ae99dd8`.
The baseline build must still stop with a fixed `HERMES_PATCH_*` code if the
target, hash, or exact context differs.

Do not bypass either gate, apply the historical patch fuzzily, or copy code from
an unrelated local Hermes checkout.

Before publishing, run the deterministic runtime tests and build a disposable
baseline image when comparison requires it:

```bash
npm run test:runtime
npm run hermes:build -- --tag core-agent-hermes-runtime:conversation-reliability-local
```

Inspect a synthetic failed stream. It must end with one closed terminal record
containing only `choices` and `hermes`, followed by `[DONE]`. No provider
message, response body, URL, provider/model name, credential, or traceback may
appear. A local mutable tag and a synthetic fixture are development evidence,
not release or AC10 evidence.

For Conversation Reliability v1, record deterministic and real-path outcomes in
[`docs/testing/conversation-reliability-v1.md`](../testing/conversation-reliability-v1.md).
Record only UTC time, pass/fail, fixed failure code, final Run state, and immutable or
local image digest. Do not record prompt text, assistant text, provider response,
credential material, internal URL, or traceback. A deterministic synthetic success
does not satisfy the mandatory real-provider happy path.

For rollback, select the previous reviewed immutable product-image digest from
version control and use the normal Runtime lifecycle path so the generation is
incremented. Do not retag or rebuild the previous image. The additive Agent Run
failure-code migration remains deployed; application consumers retain their
legacy unknown/invalid fallbacks.

Do not roll the API or Worker back to a build older than database schema version 9.
Such a Worker does not write `agent_runs.failure_code` and is incompatible with the
forward-only state constraint. Image rollback is independent: keep a schema-v9-aware
application deployment and select the previous reviewed Hermes digest for the target
platform from `infra/hermes/product-images.lock.json`.

### Publish and review the private Hermes Runtime

The only release path is the manual **Publish Hermes Runtime** workflow at
`.github/workflows/publish-hermes-runtime.yml`. Merge the workflow and image
source to `main` before dispatch. Select `v0.1.4` and one full lowercase source
commit that is already reachable from `origin/main`; the workflow independently
checks that ancestry before authenticating to GHCR or building.

The workflow publishes exactly these private tags, without `latest`:

```text
ghcr.io/weiyuan305/core-agent-hermes-runtime:v0.1.4
ghcr.io/weiyuan305/core-agent-hermes-runtime:sha-<first-12-source-commit-characters>
```

Review the successful Actions run and confirm its source commit, both build
jobs, package visibility `private`, and artifact name
`hermes-product-image-lock-v0.1.4`. Download the artifact into a fresh private
temporary directory. Compare both GHCR platform digests against the candidate:

```bash
docker buildx imagetools inspect --raw ghcr.io/weiyuan305/core-agent-hermes-runtime:v0.1.4
```

The candidate must contain only the approved repository, tag, and two immutable
references beginning with
`ghcr.io/weiyuan305/core-agent-hermes-runtime:v0.1.4@sha256:`. Stop on any
source, visibility, repository, tag, amd64 digest, or arm64 digest mismatch.
After checking both GHCR platform digests, commit the candidate lock unchanged
as `infra/hermes/product-images.lock.json`; do not regenerate or hand-edit it.

For a local pull, create a classic token limited to `read:packages`. Enter it
only in a private shell, never in this repository, `.env.runtime`, a command
argument, a transcript, or a shared terminal. Docker stores the credential in
the selected local credential store:

```bash
printf '%s' "$GHCR_READ_TOKEN" | docker login ghcr.io --username Weiyuan305 --password-stdin
unset GHCR_READ_TOKEN
docker pull "$(node scripts/resolve-hermes-image.mjs --lock infra/hermes/product-images.lock.json --platform linux/arm64)"
```

Use `linux/amd64` instead on an amd64 daemon. Confirm `unset GHCR_READ_TOKEN`
ran immediately even when login or pull failed. Do not continue unless the
resolved reference equals the corresponding reviewed lock entry and the pull
reports that immutable digest.

A release operator must publish both supported platform images, obtain the
registry RepoDigests, review them, and create a ManagedImageLock-shaped JSON
file whose repository identifies the Core-Agent Hermes runtime product and
whose `linux/amd64` and `linux/arm64` references both have the form
`repository:tag@sha256:<64 lowercase hex characters>`. The same absolute lock
file is supplied to the smoke through `CORE_AGENT_HERMES_IMAGE_LOCK_FILE`.
After the Task17 path preflight, the smoke reads that source with stable
pre/read/post metadata checks. For a generated tenant
`synthetic-runtime-v1-<16-hex-suffix>`, it exclusively creates the exact `0700`
directory
`$CORE_AGENT_SUPERVISOR_STATE_ROOT/.core-agent-product-lock-<16-hex-suffix>`
and the exact `0444` file `reviewed-product-images.lock.json` beneath it. A
collision fails closed. The smoke verifies the copied bytes and overrides the
child-only Compose environment so API and Supervisor mount that same snapshot
read-only. The caller's source path is never mounted by the smoke, and the
snapshot path is never printed. The smoke rejects the current
`nousresearch/hermes-agent` base lock and rejects an installed image whose
RepoDigest or `/opt/core-agent/gateway-entrypoint.sh` configuration does not
match the reviewed product lock. Source mutation during snapshot creation fails
closed. Default and pre-topology failure paths unlink the staged file; a
`--keep-runtime` invocation that owns a partial or started topology retains it
until the exact manual shutdown procedure below.

Build and publish the product images through the approved registry workflow,
outside this host-acceptance procedure, and record their RepoDigests in the
reviewed product-image lock. Do not run a local product build or pull yet: this
guide first selects and validates the exact local Docker context, then installs
the selected product digest into that daemon.

## Create isolated local projections

Use four canonical host paths that do not equal, contain, or sit beneath one
another: bootstrap file, provider root, ingress root, and Supervisor state
root. No configured path or protected ancestor may be a symlink or group/other
writable. Provider and ingress roots must already exist; the state leaf may be
absent and is created by the preflight. The Supervisor UDS is not a host path:
Compose owns the `supervisor-socket` named volume and initializes its root to
the final runtime UID/GID with exact mode `0700` before Supervisor starts.

The required secret leaves are:

- bootstrap: the exact file configured by `CORE_AGENT_BOOTSTRAP_KEY_FILE`;
- provider: `provider_tokenhub_main.v1` below the provider root;
- ingress: `hermes_ingress.v1` below the ingress root.

Each secret must be a current-owner regular file, have exactly one hard link,
and have mode `0600`. Its bytes must be non-empty valid UTF-8 with no NUL,
carriage return, or line feed; in particular, do not leave a terminal newline.
Provider/ingress roots and the state root are exact `0700` directories. Put
secret bytes into those files using the approved local secret-provisioning
procedure, then set metadata without printing them:

```bash
chmod 0700 .local-secrets/provider .local-secrets/ingress
chmod 0600 .local-secrets/bootstrap/key .local-secrets/provider/provider_tokenhub_main.v1 .local-secrets/ingress/hermes_ingress.v1
```

## Select a local Unix Docker context

Runtime v1 accepts only a local Docker context whose endpoint is `unix://`.
TCP, SSH, named-pipe, and remote contexts are outside the v1 trust boundary.
Unset `DOCKER_HOST`; the smoke rejects the variable whenever it is present so
it cannot override the inspected context. Choose the exact local context for
this run and select it before any Buildx, pull, run, or network command:

```bash
unset DOCKER_HOST
CORE_AGENT_DOCKER_CONTEXT='desktop-linux' # or the exact local Linux/Colima context
docker context use "$CORE_AGENT_DOCKER_CONTEXT"
docker context inspect --format '{{json .Endpoints.docker.Host}}'
```

The inspected value must be one canonical absolute `unix://` endpoint. Stop on
any TCP, SSH, named-pipe, empty, malformed, or unexpected value.
The smoke reads the active context with `docker context inspect` and fails
before Compose if it is not a local Unix endpoint. Select exactly one of the
following platform procedures; the daemon-side bind source is not always the
same path as the Docker CLI endpoint.

### Resolve and install locked base images

After selecting and inspecting the local context, verify Buildx, resolve the
current registry indexes, and review the exact lock-file change before copying
any selected platform reference into the shell. `runtime:images` writes
`infra/runtime/base-images.lock.json`; it does not install an image in the
selected daemon. Replace all illustrative assignments below with the exact
product reference from the reviewed product lock and the exact Node/PostgreSQL
references for one selected platform from the reviewed base lock. Pull all
three immutable references into the already-selected daemon before any
image-backed socket probe.

```bash
docker buildx version
npm run runtime:images
git diff -- infra/runtime/base-images.lock.json
CORE_AGENT_HERMES_IMAGE='registry.example/core-agent/hermes-runtime:v2026.8.5@sha256:<selected-platform-digest>'
CORE_AGENT_NODE_IMAGE='node:22-bookworm-slim@sha256:<selected-platform-digest>'
CORE_AGENT_POSTGRES_IMAGE='postgres:17-bookworm@sha256:<selected-platform-digest>'
docker pull "$CORE_AGENT_HERMES_IMAGE"
docker pull "$CORE_AGENT_NODE_IMAGE"
docker pull "$CORE_AGENT_POSTGRES_IMAGE"
docker image inspect "$CORE_AGENT_HERMES_IMAGE"
```

Do not continue if the registry result, lock diff, pull digest, or product image
inspection is unexpected. Keep the two base-image shell values and copy them
byte-for-byte into `.env.runtime` after the platform-specific socket metadata
below is known. `CORE_AGENT_HERMES_IMAGE` must equal the selected entry in the
reviewed product lock; the smoke reads that lock rather than accepting this
shell variable as authority.

### Linux Docker Engine

Confirm the active context reports a local Unix endpoint. On a native Linux
Engine, its absolute endpoint path is also the daemon-side bind source. Inspect
that exact socket and copy the path/GID into the private environment file:

```bash
docker context inspect --format '{{json .Endpoints.docker.Host}}'
id -u
id -g
stat -c '%g %a %F' /var/run/docker.sock
```

For the standard Engine socket, set
`CORE_AGENT_DOCKER_SOCKET_SOURCE=/var/run/docker.sock`. If the Unix endpoint is
different, use its canonical absolute path instead. It must be a socket with
exact mode `660`; `CORE_AGENT_DOCKER_GID` is the reported group.

### Docker Desktop for macOS

Select the `desktop-linux` context and confirm that it reports a Unix endpoint.
For a container running inside Docker Desktop's Linux VM, mount the VM-side raw
socket rather than the optional macOS `/var/run/docker.sock` symlink:

```bash
docker context inspect --format '{{json .Endpoints.docker.Host}}'
id -u
id -g
docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
  --entrypoint stat \
  --mount type=bind,source=/var/run/docker.sock.raw,target=/var/run/docker.sock,readonly \
  "$CORE_AGENT_NODE_IMAGE" -c '%g %a %F' /var/run/docker.sock
```

Set `CORE_AGENT_DOCKER_SOCKET_SOURCE=/var/run/docker.sock.raw` and take
`CORE_AGENT_DOCKER_GID` from that bounded metadata probe. This v1 Docker Desktop
procedure uses the raw VM socket for the container backend; the host symlink is only a client
convenience.

### Colima

Select the intended Colima profile and its Docker context explicitly. Derive
the daemon-side source and metadata inside that selected VM:

```bash
docker context inspect --format '{{json .Endpoints.docker.Host}}'
colima ssh --profile default -- stat -c '%g %a %F' /var/run/docker.sock
id -u
id -g
```

Set `CORE_AGENT_DOCKER_SOCKET_SOURCE=/var/run/docker.sock` and use the GID
reported inside the selected Colima VM. For a non-default profile, replace both
the Docker context and `--profile` value consistently. Do not derive the
daemon-side source or GID from the macOS `/var/run/docker.sock` symlink or from
`$HOME/.colima/<profile>/docker.sock`; those are client-side paths. The
Supervisor-image preflight remains authoritative and startup stops if the exact
final UID/GID cannot inspect and ping the mounted socket.

Copy `.env.runtime.example` to a private local file and fill every path,
identity, platform, and immutable reference. Do not put secret bytes in it.
`CORE_AGENT_NODE_IMAGE` and `CORE_AGENT_POSTGRES_IMAGE` must equal the selected
platform entries generated in `infra/runtime/base-images.lock.json`.

## Validate and run

### Strict acceptance smoke

Load the completed non-secret environment, then execute the remaining Task17
prerequisites in this order. The earlier `runtime:images` step resolved and
reviewed the Node/PostgreSQL lock, and the exact selected references are already
installed in the local daemon. `runtime:network` creates or validates the
labeled internal backplane and dedicated non-internal egress
bridge. The egress bridge is fixed to `172.31.240.0/24` with gateway
`172.31.240.1`, default IPAM, IPv4 masquerading enabled, and IPv6 disabled;
the command detects Docker IPAM overlap and fails closed on Docker-network
configuration drift. It does not portably inspect every host, VPN, and VM route.
Before creation, the operator must inspect host, VPN, and VM route tables and
stop if `172.31.240.0/24` is present or overlaps; on Colima, include
`colima ssh --profile <selected-profile> -- ip route` in that review.
Run `runtime:network` only against the explicitly selected local Docker context.
`DOCKER_HOST` must be absent, including an explicitly empty value; the command
checks this before every Docker operation, then requires the selected context
endpoint to be a canonical local `unix://` socket before it issues a network
subcommand. It fails closed instead of creating or inspecting a network through
an ambient endpoint or context override.
`runtime:paths` enforces all four canonical host-path owner, mode,
link-count, and non-overlap rules and creates private state-root `staging` and
`ingress` children. On macOS/Colima, keep state below a canonical Docker-shared
host path such as `/Users/...`; Supervisor passes those host child paths to the
daemon rather than a private `/run` path.

```bash
set -a
source .env.runtime
set +a
npm run runtime:network
npm run runtime:paths
docker compose --project-name core-agent-runtime-v1-smoke -f infra/runtime/compose.dev.yaml config --quiet
CORE_AGENT_REAL_HERMES_SMOKE=1 npm run smoke:control-plane
```

Do not manually run `compose up` first. The smoke owns its exact project and
starts `postgres migrate api api-ingress worker supervisor`; Compose first runs
the one-shot `supervisor-socket-preflight` and
`supervisor-socket-volume-init` dependencies. The API container has no host
port; only the credential-free fixed TCP `api-ingress` publishes
`127.0.0.1:8787`. The smoke validates the local Unix Docker context, exact
mounted-socket metadata and bounded `_ping`, Compose,
locked Node/PostgreSQL/product-Hermes references, runtime paths and network, all
three secret files, and the product image before startup. It also
precomputes the deterministic synthetic tenant/runtime cleanup identity before
the provisioning POST, so a committed request whose response is lost or invalid
can still be queried and deleted without a broad Docker label deletion.

The product initializer writes each Hermes Profile's private `.env` plus a
`config.yaml` containing the named custom provider `core-agent-managed`, the
selected model, `key_env`, and `transport: chat_completions`. A catalog endpoint
ending in `/chat/completions` is normalized once to its Hermes OpenAI-compatible
base (for example `/v1`); query strings are rejected. Runtime behavior does not
depend on the legacy `LLM_MODEL` or `OPENAI_BASE_URL` environment variables.

On success stdout contains exactly one JSON object with these keys and no
others: `assistant_message_count`, `conversation_id`, `event_types`,
`profile_id`, `run_id`, `run_status`, `runtime_id`, `runtime_state`, and
`tenant_id`. Stderr contains only fixed stage or error codes. Do not record an
AC10 success unless `runtime_state` is `ready`, `run_status` is `succeeded`, the
event list ends in `run.completed`, and `assistant_message_count` is positive.

Default cleanup attempts runtime `delete`, the exact managed-container removal
check, and Compose `down` without `-v` independently. A failure in one step does
not skip the later bounded steps, the first cleanup failure is retained, secret
buffers are always zeroized, and the product-lock snapshot is released. The
container-removal check confirms the exact labeled tenant volume remains. The
PostgreSQL Compose volume also remains because the command never uses
`--volumes`.

`--keep-runtime` skips runtime deletion and Compose shutdown for inspection,
keeps the immutable snapshot that the running containers require, zeroizes the
secret buffers, and does not add output fields:

```bash
CORE_AGENT_REAL_HERMES_SMOKE=1 npm run smoke:control-plane -- --keep-runtime
```

### Interactive anonymous synthetic chat

The interactive command uses the same validated topology, provisioning path,
Control Plane API, Worker, Supervisor, private Hermes Runtime, and default
cleanup as the strict smoke. It differs only at the terminal boundary: it
accepts multiple anonymous synthetic prompt lines and displays assistant deltas
on stdout. It does not write a user or assistant transcript to files, logs,
evidence, environment variables, or command arguments. Do not paste customer,
student, application, housing, teaching, or other personal data.

After completing the same environment, network, path, context, and immutable
image prerequisites above, start the client with:

```bash
CORE_AGENT_REAL_HERMES_SMOKE=1 npm run chat:control-plane
```

The client waits for each Run to terminate before accepting the next line. Its
exact terminal commands are:

- `/new` creates a new Conversation and therefore a distinct Hermes session;
- `/restart` recreates the API and Worker only, waits for API readiness, and
  preserves PostgreSQL, Supervisor, the managed Hermes Runtime, and the current
  Conversation;
- `/exit` ends input and enters cleanup; EOF has the same effect.

Default exit requests deletion of the exact managed Runtime, proves its exact
container is absent while its tenant data volume remains, stops the fixed
Compose project without `--volumes`, removes the staged product-lock snapshot,
and zeroizes secret buffers. A Run, input, output, transport, `SIGINT`, or
`SIGTERM` failure enters that same bounded cleanup path.

To retain a successfully established synthetic topology for inspection, use:

```bash
CORE_AGENT_REAL_HERMES_SMOKE=1 npm run chat:control-plane -- --keep-runtime
```

This mode first creates one exclusive current-owner `0600` receipt below
`CORE_AGENT_SUPERVISOR_STATE_ROOT`. The receipt contains only the fixed Compose
project and exact synthetic Tenant, Profile, Runtime, and product-lock snapshot
identities. It contains no prompt, response, credential, or caller-supplied
path. If receipt creation fails or a receipt already exists, the client falls
back to default cleanup and does not retain a new unmanageable Runtime.

Clean a successfully retained interactive session only with:

```bash
CORE_AGENT_REAL_HERMES_SMOKE=1 npm run chat:cleanup
```

`chat:cleanup` accepts no tenant, Runtime, Compose project, receipt, or path
argument. It securely reopens the fixed receipt, validates exact ownership and
metadata before and after the bounded read, performs the exact cleanup sequence,
and removes the receipt only after every operation succeeds. If cleanup fails,
the fixed receipt remains for an exact retry. Do not use the later manual
strict-smoke shutdown instructions for a retained interactive chat.

### Local consultant Web demo

The consultant Web command uses the same validated managed Runtime session and
ordered cleanup as the terminal client. It adds a loopback-only Client Gateway
and a browser interface for one synthetic demo student. It is not production
authentication and must never receive a customer name, student record,
application detail, housing detail, teaching record, reusable credential, or
copied conversation.

Complete the same environment, local Docker context, immutable-image, network,
and path prerequisites above. Then start the Web host from the repository root:

```bash
set -a
source .env.runtime
set +a
npm run web:control-plane
```

The command itself is the explicit real-Runtime opt-in. It waits for the managed
Runtime to become ready before binding, then prints only
`WEB_READY http://127.0.0.1:<port>`. Open that exact loopback URL. Do not expose
the port through a reverse proxy, tunnel, LAN bind, or public deployment.

Use only fixed anonymous synthetic text and verify these actions without saving
the prompt or response:

1. A first Run streams one non-empty completion.
2. A follow-up succeeds in the same Conversation.
3. **New Conversation** selects a distinct Conversation and leaves the earlier
   browser-memory transcript intact.
4. **API/Worker restart** completes, preserves the selected Conversation, and a
   post-restart Run succeeds.
5. A 390-by-844 viewport keeps navigation, transcript, and composer usable with
   no horizontal overflow.

Record only status, event-type, and count evidence. Do not capture browser
storage, network bodies, transcripts, raw errors, container output, secret
paths, internal identities, or provider data. End with `Ctrl-C`; normal shutdown
closes the Client Gateway first and then performs exact Runtime deletion,
container-removal verification, Compose shutdown without volumes, snapshot
release, and secret zeroization. This Web command has no retained-runtime mode.

## Inspect, resume SSE, and stop

Safe progress is the script's fixed stderr stage codes. Component logs are
available through the exact project, but treat them as sensitive operational
material: review redaction before copying or attaching them and never paste raw
dependency bodies.

```bash
docker compose --project-name core-agent-runtime-v1-smoke -f infra/runtime/compose.dev.yaml ps
docker compose --project-name core-agent-runtime-v1-smoke -f infra/runtime/compose.dev.yaml logs --no-color api worker supervisor
```

To resume SSE, reconnect to
`GET /internal/v1/conversations/{conversation_id}/events`, authenticate from the
bootstrap file in memory, send `X-Core-Agent-Tenant-Id`, and send either
`Last-Event-ID: {last persisted sequence}` or `after_sequence={last persisted
sequence}`. Retain only sequence numbers and event types; do not save `data:`
payloads. Never put the bootstrap value in shell history, command arguments,
an environment variable, or a pasted transcript.

The automated smoke additionally requires the response content type to be
`text/event-stream`, validates each retained item as a ProductEvent envelope,
requires the terminal event's top-level and payload `run_id` to match the
created Run, and fails closed on its event-count or aggregate-byte bounds.

For a successful kept run, copy the allowlisted `tenant_id` value from the one
JSON result and derive the exact snapshot path. Validate the identifier before
using it in a filesystem command:

```bash
SMOKE_TENANT_ID='synthetic-runtime-v1-0123456789abcdef'
[[ "$SMOKE_TENANT_ID" =~ ^synthetic-runtime-v1-[0-9a-f]{16}$ ]] || exit 1
SMOKE_TENANT_SUFFIX=${SMOKE_TENANT_ID#synthetic-runtime-v1-}
SMOKE_SNAPSHOT_DIR="${CORE_AGENT_SUPERVISOR_STATE_ROOT}/.core-agent-product-lock-${SMOKE_TENANT_SUFFIX}"
SMOKE_SNAPSHOT_FILE="${SMOKE_SNAPSHOT_DIR}/reviewed-product-images.lock.json"
test -d "$SMOKE_SNAPSHOT_DIR"
test ! -L "$SMOKE_SNAPSHOT_DIR"
test -f "$SMOKE_SNAPSHOT_FILE"
test ! -L "$SMOKE_SNAPSHOT_FILE"
```

On macOS, inspect owner, mode, link count, and type with:

```bash
stat -f '%u %Lp %l %HT' "$SMOKE_SNAPSHOT_DIR" "$SMOKE_SNAPSHOT_FILE"
id -u
```

On Linux, use:

```bash
stat -c '%u %a %h %F' "$SMOKE_SNAPSHOT_DIR" "$SMOKE_SNAPSHOT_FILE"
id -u
```

The directory must be owned by the current UID with mode `700`. The file must
be owned by the current UID, be a regular file with mode `444`, and have one
hard link. If a kept invocation failed before emitting JSON, inspect only the
exact `core-agent-runtime-v1-smoke` API and Supervisor container mounts and
accept the source only when both show the same absolute path with the exact
directory/file shape above; do not select a path with `find` or a wildcard.

Stop only the smoke-owned Compose project, never a broader project and never
with `-v`. The override is required because the kept project was created from
the immutable snapshot, not the caller's reviewed source path:

```bash
CORE_AGENT_HERMES_IMAGE_LOCK_FILE="$SMOKE_SNAPSHOT_FILE" docker compose --project-name core-agent-runtime-v1-smoke -f infra/runtime/compose.dev.yaml down --remove-orphans --timeout 30
unlink "$SMOKE_SNAPSHOT_FILE"
rmdir "$SMOKE_SNAPSHOT_DIR"
```

Run `unlink` and `rmdir` only after Compose shutdown succeeds and the metadata
checks match. Do not use a wildcard, `find`, a pipeline, recursive removal, or
the original reviewed-lock path for these deletion commands.

Runtime deletion intentionally preserves the tenant volume. To remove one
synthetic volume manually, first use the allowlisted IDs from smoke stdout and
verify that exactly one volume has all four labels:

```bash
docker volume ls --filter label=core-agent.managed=runtime-v1 --filter label=core-agent.resource=runtime-volume --filter label=core-agent.tenant-id=synthetic-runtime-v1-<id> --filter label=core-agent.runtime-id=runtime_<id> --format '{{.Name}}'
docker volume inspect core-agent-data-<exact-derived-suffix>
docker volume rm core-agent-data-<exact-derived-suffix>
```

The inspection must show the exact synthetic tenant/runtime IDs before the
explicit name is removed. Never pipe a label query into `docker volume rm`, use
a wildcard, or delete the Compose PostgreSQL volume as a substitute.
