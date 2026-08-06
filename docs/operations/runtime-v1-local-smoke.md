# Runtime v1 local real-smoke guide

This runbook is for anonymous, synthetic acceptance only. Do not use a customer
name, student data, copied conversation, production fixture, or reusable
credential. The script fixes the prompt identifier to
`synthetic-runtime-v1-smoke`, generates `synthetic-` resource identifiers, and
refuses to run unless `CORE_AGENT_REAL_HERMES_SMOKE=1` is exact.

The smoke starts PostgreSQL, migration, API, Worker, and Supervisor under the
exact Compose project `core-agent-runtime-v1-smoke`. Before Supervisor starts,
Compose runs one fixed Supervisor-image Docker-socket preflight. Generated
Hermes runtime resources are owned by the Supervisor.

## Product-image prerequisite

`npm run hermes:build` checks the product Dockerfile and creates the local tag
`core-agent/hermes-runtime:dev`. That tag is mutable and has no accepted
RepoDigest, so it does **not** satisfy AC10 by itself.

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

The release flow is therefore:

```bash
npm run hermes:build
# Publish both platform product images through the approved registry workflow.
# Record their registry RepoDigests in a reviewed product-image lock.
docker pull 'registry.example/core-agent/hermes-runtime:v2026.8.5@sha256:<platform-digest>'
docker image inspect registry.example/core-agent/hermes-runtime:v2026.8.5@sha256:<platform-digest>
```

The illustrative registry name and digest above are not accepted values. Do
not proceed until the reviewed lock exists and its selected platform reference
is installed locally.

## Create isolated local projections

Use five canonical paths that do not equal, contain, or sit beneath one
another: bootstrap file, provider root, ingress root, Supervisor socket root,
and Supervisor state root. No configured path or protected ancestor may be a
symlink or group/other writable. Provider and ingress roots must already exist;
socket and state leaves may be absent and are created by the preflight.

The required secret leaves are:

- bootstrap: the exact file configured by `CORE_AGENT_BOOTSTRAP_KEY_FILE`;
- provider: `provider_tokenhub_main.v1` below the provider root;
- ingress: `hermes_ingress.v1` below the ingress root.

Each secret must be a current-owner regular file, have exactly one hard link,
and have mode `0600`. Provider/ingress roots and created socket/state roots are
exact `0700` directories. Put secret bytes into those files using the approved
local secret-provisioning procedure, then set metadata without printing them:

```bash
chmod 0700 .local-secrets/provider .local-secrets/ingress
chmod 0600 .local-secrets/bootstrap/key .local-secrets/provider/provider_tokenhub_main.v1 .local-secrets/ingress/hermes_ingress.v1
```

## Select a local Unix Docker context

Runtime v1 accepts only a local Docker context whose endpoint is `unix://`.
TCP, SSH, named-pipe, and remote contexts are outside the v1 trust boundary.
Unset `DOCKER_HOST`; the smoke rejects the variable whenever it is present so
it cannot override the inspected context. Select the endpoint with
`docker context use <name>` instead.
The smoke reads the active context with `docker context inspect` and fails
before Compose if it is not a local Unix endpoint. Select exactly one of the
following platform procedures; the daemon-side bind source is not always the
same path as the Docker CLI endpoint.

### Resolve and install locked base images

After selecting the local context, verify Buildx, resolve the current registry
indexes, and review the exact lock-file change before copying either selected
platform reference into the shell. `runtime:images` writes
`infra/runtime/base-images.lock.json`; it does not install an image in the
selected daemon. Replace both illustrative assignments below with the exact
Node and PostgreSQL references for one selected platform from the reviewed
lock, then pull those immutable references before any image-backed socket probe.

```bash
docker buildx version
npm run runtime:images
git diff -- infra/runtime/base-images.lock.json
CORE_AGENT_NODE_IMAGE='node:22-bookworm-slim@sha256:<selected-platform-digest>'
CORE_AGENT_POSTGRES_IMAGE='postgres:17-bookworm@sha256:<selected-platform-digest>'
docker pull "$CORE_AGENT_NODE_IMAGE"
docker pull "$CORE_AGENT_POSTGRES_IMAGE"
```

Do not continue if the registry result or lock diff is unexpected. Keep these
two non-secret shell values and copy them byte-for-byte into `.env.runtime`
after the platform-specific socket metadata below is known.

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
docker context use desktop-linux
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
docker context use colima
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
`runtime:paths` enforces all five canonical path, owner, mode,
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
starts `postgres migrate api worker supervisor`; Compose first runs the
one-shot `supervisor-socket-preflight` dependency. It validates the local Unix
Docker context, exact mounted-socket metadata and bounded `_ping`, Compose,
locked Node/PostgreSQL/product-Hermes references, runtime paths and network, all
three secret files, and the product image before startup. It also
precomputes the deterministic synthetic tenant/runtime cleanup identity before
the provisioning POST, so a committed request whose response is lost or invalid
can still be queried and deleted without a broad Docker label deletion.

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
