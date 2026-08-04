# Control Plane Runtime v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the first complete backend slice that provisions one isolated company Hermes runtime, selects a persisted Profile, executes a durable Agent Run, and resumes ordered conversation events after process restart.

**Architecture:** Build one TypeScript monorepo with a shared `@core-agent/runtime-core` package and three separately deployable processes: Fastify API, PostgreSQL Worker, and Docker-authorized Runtime Supervisor. PostgreSQL is the only resource/job/event authority; API and Worker communicate with the Supervisor over a narrow Unix socket protocol, and Hermes output is persisted before SSE exposes it.

**Tech Stack:** Node.js 22+, TypeScript 7.0.2, Fastify 5.11.2, Kysely 0.29.4, `pg` 8.22.0, Dockerode 5.0.1, Pino 10.3.1, TypeBox 1.3.10, PostgreSQL 17, Docker Compose, Node test runner.

## Global Constraints

- This plan implements decisions D01 through D14 in `docs/superpowers/specs/2026-08-03-control-plane-runtime-v1-design.md` and ADRs 0001 through 0005.
- Runtime v1 is single-node only: Mac plus Colima for development and one Linux host for production; Kubernetes, multi-node scheduling, and a remote Runtime Agent are excluded.
- API, Worker, and Runtime Supervisor remain separate processes; API and Worker must never mount the Docker socket.
- Only Runtime Supervisor may reach Docker, and its protocol must reject arbitrary commands, host paths, environment names, networks, images, ports, mounts, and Docker options.
- PostgreSQL is authoritative for resources, desired state, jobs, idempotency, ProductEvents, AuditEvents, stream sequences, and Outbox rows.
- Production PostgreSQL remains standard TLS PostgreSQL targeting Supabase; no Supabase-specific client API enters the domain layer.
- Dependencies and container images are exact-version or digest pinned; a reviewed lock file is authoritative for Hermes and PostgreSQL images.
- Database migrations are reviewed SQL files. Startup never auto-migrates; readiness fails when the schema version is behind or ahead.
- Every tenant-owned primary key, unique key, read, write, join, job, event, and audit query includes `tenant_id`; cross-tenant existence is never disclosed.
- Secrets are opaque references in PostgreSQL. Secret bytes must not enter Docker configuration environment, protocol payloads, SQL rows, errors, events, audit, logs, traces, fixtures, or smoke output.
- Development secret files resolve beneath one configured root and must be regular files owned by the current uid with mode `0600`; clients never submit raw paths.
- The product Hermes image uses a fixed no-network initializer and a fixed gateway entrypoint; Runtime Supervisor exposes no generic container exec operation.
- The API is internal-only, bound to loopback or private networking, and authenticated by one out-of-band bootstrap service key mapped to a service Actor and Membership.
- Bootstrap-key verification compares fixed-length SHA-256 digests with `timingSafeEqual`; the untrusted candidate is never compared directly.
- Agent execution is asynchronous: Run creation returns `202`, Worker persists ProductEvents, and SSE reads committed rows after a numeric sequence cursor.
- Client disconnect never cancels a Run. Automatic Run replay stops at the unsafe boundary: the first assistant delta or external effect.
- All state changes follow existing contract transition matrices, use positive `resource_version` optimistic concurrency, and refuse terminal-state overwrite.
- Real customer or student data is forbidden until separate Identity, Consent, Retention, and Data Governance designs are accepted.
- Tests use anonymous synthetic identities, prompts, and sentinel secrets only.
- Every task follows red-green-refactor, runs the narrow test first, runs its package checks, executes `git diff --check`, and ends with one reviewable commit.

## Authoritative References

- Design: `docs/superpowers/specs/2026-08-03-control-plane-runtime-v1-design.md`
- Runtime topology: `docs/architecture/0002-control-plane-runtime-topology.md`
- Durable execution: `docs/architecture/0003-control-plane-durable-execution-and-storage.md`
- API/security/streaming: `docs/architecture/0004-control-plane-internal-api-security-and-streaming.md`
- Hermes bootstrap: `docs/architecture/0005-hermes-profile-bootstrap-without-container-exec.md`
- Current contracts: `packages/contracts/src/index.ts` and `packages/contracts/src/registry.ts`
- Existing Hermes distribution: `infra/hermes/Dockerfile`, `infra/hermes/base-images.lock.json`, and `infra/hermes/managed/config.yaml`

## Planned File Structure

```text
apps/
  control-plane-api/
    package.json
    tsconfig.json
    src/{app,auth,errors,server}.ts
    src/routes/{health,provisioning,runtime,conversations,runs,events}.ts
    tests/{auth,health,provisioning,runtime,conversations,runs,events}.test.ts
  control-plane-worker/
    package.json
    tsconfig.json
    src/{main,worker-loop,dispatch-job}.ts
    src/handlers/{provision-runtime,reconcile-runtime,execute-agent-run,dispatch-outbox}.ts
    tests/{worker-loop,provision-runtime,reconcile-runtime,execute-agent-run}.test.ts
  runtime-supervisor/
    package.json
    tsconfig.json
    src/{main,server,protocol,policy,docker-adapter,redact-docker-error}.ts
    tests/{protocol,policy,docker-adapter,server}.test.ts
packages/
  contracts/
    src/runtime/{messages,requests}.ts
    fixtures/v1/{valid,invalid}/...
    compat/v1/releases/0.2.0/...
  runtime-core/
    package.json
    tsconfig.json
    migrations/{001_resources,002_execution,003_events}.sql
    src/config/{environment,provider-catalog}.ts
    src/db/{database,migrate,schema-version,transaction}.ts
    src/domain/{idempotency,jobs,events,redaction,transitions}.ts
    src/repositories/{resources,runtime,conversation,run,events,jobs}.ts
    src/secrets/{secret-store,file-secret-store}.ts
    src/supervisor/{contracts,client,fake-server}.ts
    src/hermes/{client,stream-parser}.ts
    src/index.ts
    tests/{config,migrations,tenant-isolation,idempotency,jobs,events,redaction,secrets,supervisor-client,hermes-client}.test.ts
infra/
  hermes/runtime/{initialize.py,gateway-entrypoint.sh}
  runtime/{base-images.lock.json,compose.dev.yaml}
  postgres/init/00-create-test-database.sql
scripts/
  migrate-runtime.mjs
  smoke-control-plane.mjs
  verify-no-secret.mjs
tests/
  integration/{fixtures,fakes,provisioning,agent-run,recovery,security}.test.ts
```

The shared package owns database and domain ports. The API owns HTTP parsing/authentication/SSE only. The Worker owns leased execution. The Supervisor owns Docker policy and Docker calls only. Hermes image scripts remain under `infra/hermes` because they are part of the pinned product distribution.

---

### Task 1: Publish the additive Contracts 0.2.0 Message and Run-input release

**Files:**
- Create: `packages/contracts/src/runtime/messages.ts`
- Create: `packages/contracts/src/runtime/requests.ts`
- Modify: `packages/contracts/src/events/product-event.ts`
- Modify: `packages/contracts/src/errors/error-envelope.ts`
- Modify: `packages/contracts/src/registry.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/package.json`
- Modify: `packages/contracts/CHANGELOG.md`
- Modify: `packages/contracts/compatibility-change.json`
- Create: `packages/contracts/fixtures/v1/valid/message.json`
- Create: `packages/contracts/fixtures/v1/valid/create-agent-run-request.json`
- Create: `packages/contracts/fixtures/v1/invalid/message-secret-field.json`
- Create: `packages/contracts/fixtures/v1/invalid/create-agent-run-forged-scope.json`
- Create: generated `packages/contracts/schemas/v1/message.schema.json` and `create-agent-run-request.schema.json`
- Create: immutable `packages/contracts/compat/v1/releases/0.2.0/*.schema.json`
- Modify: `packages/contracts/tests/runtime.test.ts`
- Modify: `packages/contracts/tests/product-event.test.ts`
- Modify: `packages/contracts/tests/security.test.ts`
- Modify: `packages/contracts/tests/compatibility-history.test.ts`

**Interfaces:**
- Consumes: `ResourceMetadataFields`, `OpaqueIdSchema`, `SchemaVersionSchema`, `UtcTimestampSchema`, and existing ProductEvent base fields.
- Produces: `MessageSchema`, `Message`, `CreateAgentRunRequestSchema`, `CreateAgentRunRequest`, and a `message.created` ProductEvent branch; `CONTRACT_PACKAGE_VERSION` becomes `"0.2.0"`.

- [ ] **Step 1: Write failing contract tests**

Add tests that compile against the exact public interface and reject client-forged scope:

```ts
import Schema from "typebox/schema";
import {
  CreateAgentRunRequestSchema,
  MessageSchema,
  ProductEventSchema,
} from "../src/index.js";

const now = "2026-08-03T12:00:00.000Z";
const message = {
  schema_version: 1,
  resource_version: 1,
  created_at: now,
  updated_at: now,
  message_id: "msg_01",
  tenant_id: "tenant_01",
  conversation_id: "conversation_01",
  run_id: "run_01",
  role: "user",
  status: "completed",
  content: "Synthetic hello",
};

assert.equal(Schema.IsValid(MessageSchema, message), true);
assert.equal(Schema.IsValid(MessageSchema, { ...message, api_key: "sentinel" }), false);
assert.equal(Schema.IsValid(CreateAgentRunRequestSchema, {
  schema_version: 1,
  idempotency_key: "idem_01",
  payload_hash: "sha256:" + "a".repeat(64),
  client_request_id: "client_01",
  input_message: {
    client_message_id: "client_message_01",
    content: "Synthetic hello",
  },
}), true);
assert.equal(Schema.IsValid(CreateAgentRunRequestSchema, {
  schema_version: 1,
  idempotency_key: "idem_01",
  payload_hash: "sha256:" + "a".repeat(64),
  client_request_id: "client_01",
  tenant_id: "tenant_forged",
  input_message: {
    client_message_id: "client_message_01",
    content: "Synthetic hello",
  },
}), false);
assert.equal(Schema.IsValid(ProductEventSchema, {
  schema_version: 1,
  event_id: "event_01",
  occurred_at: now,
  sequence: 1,
  tenant_id: "tenant_01",
  request_id: "request_01",
  trace_id: "trace_01",
  correlation_id: "conversation_01",
  causation_id: "request_01",
  conversation_id: "conversation_01",
  run_id: "run_01",
  event_type: "message.created",
  payload: { message_id: "msg_01", role: "user", status: "completed" },
}), true);
```

- [ ] **Step 2: Run the narrow tests and confirm failure**

Run:

```bash
npm test -w @core-agent/contracts -- --test-name-pattern="Message|Create Agent Run|message.created"
```

Expected: FAIL because `MessageSchema` and `CreateAgentRunRequestSchema` are not exported and `message.created` is absent.

- [ ] **Step 3: Implement the schemas and exports**

Create `messages.ts`:

```ts
import Type, { type Static } from "typebox";
import { OpaqueIdSchema, ResourceMetadataFields } from "../common/primitives.js";

export const MessageRoleSchema = Type.Union(
  [Type.Literal("user"), Type.Literal("assistant")],
  { "x-extensible-union": true },
);
export const MessageStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("streaming"),
  Type.Literal("completed"),
  Type.Literal("failed"),
]);
export const MessageContentSchema = Type.String({ minLength: 1, maxLength: 64_000 });
export const MessageSchema = Type.Object({
  ...ResourceMetadataFields,
  message_id: OpaqueIdSchema,
  tenant_id: OpaqueIdSchema,
  conversation_id: OpaqueIdSchema,
  run_id: OpaqueIdSchema,
  role: MessageRoleSchema,
  status: MessageStatusSchema,
  content: MessageContentSchema,
}, { additionalProperties: false, $id: "core-agent://v1/message" });

export type Message = Static<typeof MessageSchema>;
```

Create `requests.ts`:

```ts
import Type, { type Static } from "typebox";
import { OpaqueIdSchema, SchemaVersionSchema } from "../common/primitives.js";
import { PayloadHashSchema } from "./idempotency.js";
import { MessageContentSchema } from "./messages.js";

export const CreateAgentRunRequestSchema = Type.Object({
  schema_version: SchemaVersionSchema,
  idempotency_key: OpaqueIdSchema,
  payload_hash: PayloadHashSchema,
  client_request_id: OpaqueIdSchema,
  input_message: Type.Object({
    client_message_id: OpaqueIdSchema,
    content: MessageContentSchema,
  }, { additionalProperties: false }),
  parent_run_id: Type.Optional(OpaqueIdSchema),
}, { additionalProperties: false, $id: "core-agent://v1/create-agent-run-request" });

export type CreateAgentRunRequest = Static<typeof CreateAgentRunRequestSchema>;
```

Add the ProductEvent branch:

```ts
const MessageCreatedEventBranchSchema = createEventBranch("message.created", {
  message_id: OpaqueIdSchema,
  role: Type.Literal("user"),
  status: Type.Literal("completed"),
});

export const MessageCreatedEventSchema = Type.Union(
  [MessageCreatedEventBranchSchema],
  { $id: "core-agent://v1/message-created-event", "x-extensible-union": true },
);
```

Add `MessageCreatedEventBranchSchema` to `ProductEventBranchSchemas` and
`MessageCreatedEventSchema` to `ProductEventFamilySchemas`, while leaving the
existing delta/completed families unchanged. Register `message`,
`create-agent-run-request`, and `message-created-event`, export both runtime
modules, append the stable error codes accepted in section 12 of the design,
and set all version authorities to `0.2.0`.

- [ ] **Step 4: Generate schemas, fixtures, and immutable compatibility snapshot**

Run:

```bash
npm run schemas -w @core-agent/contracts
mkdir -p packages/contracts/compat/v1/releases/0.2.0
cp packages/contracts/schemas/v1/*.schema.json packages/contracts/compat/v1/releases/0.2.0/
```

Write anonymous fixtures whose only content is the synthetic data from Step 1. The invalid Run fixture adds `tenant_id` and must fail because `additionalProperties` is false; the invalid Message fixture adds `api_key` and must fail for the same reason. Update `compatibility-change.json` to:

```json
{
  "package_version": "0.2.0",
  "wire_schema_version": 1,
  "change_level": "minor",
  "reason": "Add bounded Message, CreateAgentRunRequest, and message.created contracts"
}
```

- [ ] **Step 5: Run all contract gates**

Run:

```bash
npm run check -w @core-agent/contracts
npm run compat:history -w @core-agent/contracts -- --base be1ff88
git diff --check
```

Expected: build, all contract tests, schema drift, fixtures, compatibility, append-only history, and whitespace checks pass.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts
git commit -m "feat(contracts): add message and run input contracts"
```

### Task 2: Establish the typed Runtime workspace and managed configuration boundary

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `tsconfig.base.json`
- Create: `packages/runtime-core/package.json`
- Create: `packages/runtime-core/tsconfig.json`
- Create: `packages/runtime-core/src/config/environment.ts`
- Create: `packages/runtime-core/src/config/provider-catalog.ts`
- Create: `packages/runtime-core/src/index.ts`
- Create: `packages/runtime-core/tests/config.test.ts`
- Create: `apps/control-plane-api/package.json` and `tsconfig.json`
- Create: `apps/control-plane-worker/package.json` and `tsconfig.json`
- Create: `apps/runtime-supervisor/package.json` and `tsconfig.json`

**Interfaces:**
- Consumes: Node process environment and server-managed JSON provider catalog.
- Produces: `RuntimeEnvironment`, `loadRuntimeEnvironment(env)`, `ProviderConfig`, `loadProviderCatalog(value)`, and buildable package boundaries for API, Worker, and Supervisor.

- [ ] **Step 1: Write failing managed-configuration tests**

```ts
test("environment refuses public API binding and unpinned images", () => {
  assert.throws(() => loadRuntimeEnvironment({
    CONTROL_PLANE_DATABASE_URL: "postgres://runtime:runtime@127.0.0.1/runtime",
    CONTROL_PLANE_BOOTSTRAP_KEY_FILE: "/run/secrets/bootstrap-key",
    CONTROL_PLANE_API_HOST: "0.0.0.0",
    CONTROL_PLANE_SECRET_ROOT: "/run/core-agent/secrets",
    CONTROL_PLANE_SUPERVISOR_SOCKET: "/run/core-agent/supervisor.sock",
  }), /loopback or private/);
});

test("provider catalog rejects client-controlled protocols and models", () => {
  assert.throws(() => loadProviderCatalog([{
    provider_config_id: "tokenhub",
    base_url: "http://169.254.169.254/latest",
    model_ids: ["cywx/gpt-5.6-sol"],
    credential_secret_ref: "provider_tokenhub",
    timeout_ms: 30_000,
    max_safe_retries: 1,
  }]), /HTTPS/);
});
```

- [ ] **Step 2: Run the narrow test and confirm failure**

Run: `npm test -w @core-agent/runtime-core -- --test-name-pattern="environment|provider catalog"`

Expected: FAIL because the package and loaders do not exist.

- [ ] **Step 3: Pin dependencies and create package boundaries**

Run these exact installs so `package-lock.json` becomes the dependency authority:

```bash
npm pkg set 'workspaces[0]=apps/*' 'workspaces[1]=packages/*'
npm install --save-exact -w @core-agent/runtime-core kysely@0.29.4 pg@8.22.0 pino@10.3.1
npm install --save-dev --save-exact -w @core-agent/runtime-core @types/pg@8.20.3
npm install --save-exact -w @core-agent/control-plane-api fastify@5.11.2
npm install --save-exact -w @core-agent/runtime-supervisor dockerode@5.0.1
npm install --save-dev --save-exact -w @core-agent/runtime-supervisor @types/dockerode@4.0.1
```

Each application depends on exact workspace versions `@core-agent/contracts: 0.2.0` and `@core-agent/runtime-core: 0.1.0`. Each package uses `node --import tsx --test tests/*.test.ts`, `tsc -p tsconfig.json`, and a combined `check` script. The root adds `build`, `check`, `test:unit`, `test:postgres`, and `test:integration` scripts without removing existing Hermes or contract commands.

- [ ] **Step 4: Implement strict environment and provider parsing**

Use a closed interface; do not pass `process.env` farther into domain code:

```ts
export interface RuntimeEnvironment {
  databaseUrl: string;
  bootstrapKeyFile: string;
  apiHost: string;
  apiPort: number;
  secretRoot: string;
  supervisorSocket: string;
  providerCatalogFile: string;
  workerId: string;
}

export function loadRuntimeEnvironment(env: NodeJS.ProcessEnv): RuntimeEnvironment {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (value === undefined || value.length === 0) throw new Error(name + " is required");
    return value;
  };
  const apiHost = env.CONTROL_PLANE_API_HOST?.trim() || "127.0.0.1";
  if (apiHost !== "127.0.0.1" && apiHost !== "::1") {
    throw new Error("CONTROL_PLANE_API_HOST must be loopback or private deployment wiring");
  }
  const apiPort = Number(env.CONTROL_PLANE_API_PORT || "8787");
  if (!Number.isInteger(apiPort) || apiPort < 1024 || apiPort > 65_535) {
    throw new Error("CONTROL_PLANE_API_PORT must be an integer from 1024 through 65535");
  }
  return {
    databaseUrl: required("CONTROL_PLANE_DATABASE_URL"),
    bootstrapKeyFile: required("CONTROL_PLANE_BOOTSTRAP_KEY_FILE"),
    apiHost,
    apiPort,
    secretRoot: required("CONTROL_PLANE_SECRET_ROOT"),
    supervisorSocket: required("CONTROL_PLANE_SUPERVISOR_SOCKET"),
    providerCatalogFile: required("CONTROL_PLANE_PROVIDER_CATALOG_FILE"),
    workerId: required("CONTROL_PLANE_WORKER_ID"),
  };
}
```

`ProviderConfig` is a readonly record with `provider_config_id`, an HTTPS `base_url`, non-empty allowlisted `model_ids`, `credential_secret_ref`, `timeout_ms` from 1,000 through 120,000, and `max_safe_retries` from 0 through 3. Reject duplicate IDs, URL credentials, fragments, localhost, link-local IPs, and empty model IDs.

- [ ] **Step 5: Run checks and commit**

```bash
npm run check -w @core-agent/runtime-core
npm run build
npm test
git diff --check
git add package.json package-lock.json tsconfig.base.json packages/runtime-core apps
git commit -m "build: establish control plane service workspaces"
```

### Task 3: Add reviewed PostgreSQL migrations and schema-version enforcement

**Files:**
- Create: `packages/runtime-core/migrations/001_resources.sql`
- Create: `packages/runtime-core/migrations/002_execution.sql`
- Create: `packages/runtime-core/migrations/003_events.sql`
- Create: `packages/runtime-core/src/db/database.ts`
- Create: `packages/runtime-core/src/db/migrate.ts`
- Create: `packages/runtime-core/src/db/schema-version.ts`
- Create: `packages/runtime-core/tests/migrations.test.ts`
- Create: `scripts/migrate-runtime.mjs`

**Interfaces:**
- Consumes: `pg.Pool` and an empty PostgreSQL 17 database.
- Produces: `RuntimeDatabase` Kysely table types, `applyMigrations(pool, directory)`, `readSchemaVersion(db)`, `assertSchemaVersion(db, 3)`, and CLI `npm run db:migrate`.

- [ ] **Step 1: Write failing real-PostgreSQL migration tests**

```ts
test("empty database migrates exactly to schema version 3", async () => {
  await applyMigrations(pool, migrationsDirectory);
  assert.equal(await readSchemaVersion(db), 3);
  await assert.doesNotReject(assertSchemaVersion(db, 3));
  await assert.rejects(assertSchemaVersion(db, 2), /ahead/);
  await assert.rejects(assertSchemaVersion(db, 4), /behind/);
});

test("tenant composite foreign keys fail closed", async () => {
  await seedTenant(db, "tenant_a");
  await seedTenant(db, "tenant_b");
  await seedProfile(db, "tenant_a", "profile_a");
  await assert.rejects(
    db.insertInto("conversations").values(syntheticConversation({
      tenant_id: "tenant_b",
      profile_id: "profile_a",
    })).execute(),
    /foreign key/i,
  );
});
```

- [ ] **Step 2: Connect to the disposable PostgreSQL database and confirm failure**

Run:

```bash
CONTROL_PLANE_TEST_DATABASE_URL=postgresql://core_agent_test:core_agent_test@127.0.0.1:5432/core_agent_runtime_v1_task3 \
  npm run test:postgres -w @core-agent/runtime-core -- --test-name-pattern="migrates|composite"
```

Expected: FAIL because the migration runner does not exist. Use a disposable
PostgreSQL 17 database named `core_agent_runtime_v1_task3` supplied through
`CONTROL_PLANE_TEST_DATABASE_URL`. Task 17 supplies the canonical private
Compose topology. Task 3 deliberately does not create or depend on that later
Compose file; until Task 17, the engineer supplies an already running local
PostgreSQL 17 instance. Tests must refuse any database name that does not start
with `core_agent_`.

- [ ] **Step 3: Create the resource migration with typed tenant constraints**

`001_resources.sql` must create `core_agent_schema_migrations` plus `tenants`, `actors`, `memberships`, `profiles`, `runtime_containers`, `conversations`, `sessions`, `agent_runs`, `messages`, and `secret_references`. Use `text` opaque IDs, `timestamptz` timestamps, `bigint` resource versions, closed `check` constraints, and composite keys. The recurring pattern is:

```sql
create table tenants (
  tenant_id text primary key,
  schema_version integer not null check (schema_version = 1),
  resource_version bigint not null check (resource_version > 0),
  tenant_mode text not null check (tenant_mode in ('b2b', 'b2c')),
  status text not null check (status in ('provisioning', 'active', 'suspended', 'closing', 'closed')),
  display_name text not null check (char_length(display_name) between 1 and 200),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (tenant_id, resource_version)
);

create table profiles (
  tenant_id text not null,
  profile_id text not null,
  schema_version integer not null check (schema_version = 1),
  resource_version bigint not null check (resource_version > 0),
  hermes_profile_ref text not null check (hermes_profile_ref ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
  description text not null check (char_length(description) between 1 and 2000),
  status text not null check (status in ('provisioning', 'active', 'suspended', 'archived')),
  provider_config_id text not null,
  model_id text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (tenant_id, profile_id),
  unique (tenant_id, hermes_profile_ref),
  foreign key (tenant_id) references tenants (tenant_id)
);

create table conversations (
  tenant_id text not null,
  conversation_id text not null,
  profile_id text not null,
  created_by_actor_id text not null,
  status text not null check (status in ('active', 'archived', 'closed')),
  schema_version integer not null check (schema_version = 1),
  resource_version bigint not null check (resource_version > 0),
  student_ref jsonb,
  case_ref jsonb,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (tenant_id, conversation_id),
  foreign key (tenant_id, profile_id) references profiles (tenant_id, profile_id),
  foreign key (tenant_id, created_by_actor_id) references actors (tenant_id, actor_id)
);
```

Apply the same explicit composite-key pattern to every association. `messages` references both `(tenant_id, conversation_id)` and `(tenant_id, run_id)`. `secret_references` stores only `reference_id`, `tenant_id`, `purpose`, `version`, `status`, `created_at`, and `updated_at`; it has no value, ciphertext, URI, path, payload, token, key, or credential column.

- [ ] **Step 4: Create execution and event migrations**

`002_execution.sql` creates `worker_jobs`, `idempotency_records`, and `outbox`.
`worker_jobs` includes a closed `job_kind`, `status`, `attempt_count`,
`max_attempts`, `lease_owner`, `lease_expires_at`, `next_attempt_at`,
`payload_ref`, `effect_state` constrained to `pre_effect | unsafe_to_replay`,
and bounded redacted `last_error_summary`. Add an eligible-job index on
`(status, next_attempt_at, created_at)`.

`003_events.sql` creates `product_events`, `audit_events`, and `stream_cursors` with:

```sql
create table product_events (
  tenant_id text not null,
  event_id text not null,
  stream_id text not null,
  sequence bigint not null check (sequence > 0),
  event_type text not null,
  occurred_at timestamptz not null,
  request_id text not null,
  trace_id text not null,
  correlation_id text not null,
  causation_id text not null,
  conversation_id text,
  run_id text,
  payload jsonb not null,
  primary key (tenant_id, event_id),
  unique (tenant_id, stream_id, sequence),
  foreign key (tenant_id) references tenants (tenant_id)
);

create table stream_sequences (
  tenant_id text not null,
  stream_id text not null,
  last_sequence bigint not null check (last_sequence >= 0),
  primary key (tenant_id, stream_id),
  foreign key (tenant_id) references tenants (tenant_id)
);
```

Store AuditEvent fields in typed columns plus one validated `event_json` copy for faithful contract retrieval. Add a SQL guard test that scans `information_schema.columns` and fails if `secret_references` or any event/audit table contains a column matching `(secret|token|password|credential|api_key).*(value|bytes|cipher|payload)`.

- [ ] **Step 5: Implement the migration runner and schema check**

The runner:

1. opens one dedicated connection;
2. obtains `pg_advisory_lock(hashtext('core-agent-schema-migrations'))`;
3. calculates SHA-256 for each sorted `NNN_name.sql` file;
4. rejects a modified applied migration;
5. applies each unapplied file and records version, name, checksum, and timestamp in one transaction;
6. releases the advisory lock in `finally`.

Application readiness calls only:

```ts
export const EXPECTED_SCHEMA_VERSION = 3;

export async function assertSchemaVersion(
  db: Kysely<RuntimeDatabase>,
  expected = EXPECTED_SCHEMA_VERSION,
): Promise<void> {
  const row = await db.selectFrom("core_agent_schema_migrations")
    .select(({ fn }) => fn.max<number>("version").as("version"))
    .executeTakeFirst();
  const actual = row?.version ?? 0;
  if (actual < expected) throw new Error("database schema is behind: " + actual);
  if (actual > expected) throw new Error("database schema is ahead: " + actual);
}
```

- [ ] **Step 6: Run database gates and commit**

```bash
npm run db:migrate
npm run test:postgres -w @core-agent/runtime-core
npm run check -w @core-agent/runtime-core
git diff --check
git add packages/runtime-core/migrations packages/runtime-core/src/db packages/runtime-core/tests/migrations.test.ts scripts/migrate-runtime.mjs
git commit -m "feat(runtime): add PostgreSQL runtime schema"
```

### Task 4: Add tenant-scoped transactions and resource repositories

**Files:**
- Create: `packages/runtime-core/src/db/transaction.ts`
- Create: `packages/runtime-core/src/repositories/resources.ts`
- Create: `packages/runtime-core/src/repositories/runtime.ts`
- Create: `packages/runtime-core/src/repositories/conversation.ts`
- Create: `packages/runtime-core/src/repositories/run.ts`
- Create: `packages/runtime-core/tests/tenant-isolation.test.ts`
- Create: `packages/runtime-core/tests/optimistic-concurrency.test.ts`
- Modify: `packages/runtime-core/src/index.ts`

**Interfaces:**
- Consumes: `Kysely<RuntimeDatabase>` and contract resource types.
- Produces: `TenantDatabaseContext`, `TenantTransaction`,
  `withTenantTransaction(db, tenantId, work)`, `ResourceRepositories`,
  tenant-scoped getters, and expected-version updates that return
  discriminated results.

- [ ] **Step 1: Write failing isolation and concurrency tests**

```ts
test("repository cannot fetch a resource through another tenant", async () => {
  const tenantA = repositories.forTenant("tenant_a");
  const tenantB = repositories.forTenant("tenant_b");
  await tenantA.runtimes.insert(syntheticRuntime({ runtime_id: "runtime_a" }));
  assert.equal(await tenantB.runtimes.find("runtime_a"), undefined);
});

test("expected resource version prevents a lost runtime update", async () => {
  const repo = repositories.forTenant("tenant_a").runtimes;
  await repo.insert(syntheticRuntime({ runtime_id: "runtime_a", resource_version: 1 }));
  assert.deepEqual(
    await repo.updateDesiredState("runtime_a", "stopped", 1),
    { kind: "updated", resource_version: 2 },
  );
  assert.deepEqual(
    await repo.updateDesiredState("runtime_a", "running", 1),
    { kind: "version_conflict", current_resource_version: 2 },
  );
});
```

- [ ] **Step 2: Run the tests and confirm failure**

Run:

```bash
npm run test:postgres -w @core-agent/runtime-core -- --test-name-pattern="another tenant|lost runtime"
```

Expected: FAIL because `ResourceRepositories` is not defined.

- [ ] **Step 3: Implement tenant transactions that cannot lose scope**

```ts
export interface TenantTransaction {
  readonly tenantId: string;
  readonly trx: Transaction<RuntimeDatabase>;
}

export interface TenantDatabaseContext {
  readonly tenantId: string;
  readonly db: Kysely<RuntimeDatabase>;
}

export async function withTenantTransaction<T>(
  db: Kysely<RuntimeDatabase>,
  tenantId: string,
  work: (context: TenantTransaction) => Promise<T>,
): Promise<T> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(tenantId)) {
    throw new Error("Invalid tenant ID");
  }
  return db.transaction().execute(async (trx) => work({ tenantId, trx }));
}
```

Repository constructors accept `TenantTransaction` or a closed `{ db, tenantId }` context. No public repository method accepts `tenantId` as a second optional argument, and no unscoped `findById` is exported.

- [ ] **Step 4: Implement typed resource mapping and optimistic writes**

Use explicit column lists and contract-schema validation at the repository boundary. Runtime updates follow this shape:

```ts
export type VersionedWriteResult =
  | { kind: "updated"; resource_version: number }
  | { kind: "not_found" }
  | { kind: "version_conflict"; current_resource_version: number };

export async function updateDesiredState(
  context: TenantTransaction,
  runtimeId: string,
  desiredState: RuntimeContainer["desired_state"],
  expectedVersion: number,
): Promise<VersionedWriteResult> {
  const updated = await context.trx.updateTable("runtime_containers")
    .set({
      desired_state: desiredState,
      resource_version: sql`resource_version + 1`,
      updated_at: new Date(),
    })
    .where("tenant_id", "=", context.tenantId)
    .where("runtime_id", "=", runtimeId)
    .where("resource_version", "=", expectedVersion)
    .returning("resource_version")
    .executeTakeFirst();
  if (updated !== undefined) {
    return { kind: "updated", resource_version: Number(updated.resource_version) };
  }
  const current = await context.trx.selectFrom("runtime_containers")
    .select("resource_version")
    .where("tenant_id", "=", context.tenantId)
    .where("runtime_id", "=", runtimeId)
    .executeTakeFirst();
  return current === undefined
    ? { kind: "not_found" }
    : { kind: "version_conflict", current_resource_version: Number(current.resource_version) };
}
```

Create focused repositories for Tenant/Actor/Membership/Profile, RuntimeContainer, Conversation/Session, and AgentRun/Message. Every join repeats `tenant_id` on both sides even when another foreign key appears globally unique.

- [ ] **Step 5: Add an unsafe-query static gate**

Add a test that scans `src/repositories` and fails when a Kysely query touching a tenant-owned table lacks a same-chain `where("tenant_id"` or an explicit composite join. The real PostgreSQL tests remain authoritative; this scan catches accidental omission during review.

- [ ] **Step 6: Run gates and commit**

```bash
npm run test:postgres -w @core-agent/runtime-core
npm run check -w @core-agent/runtime-core
git diff --check
git add packages/runtime-core/src/db/transaction.ts packages/runtime-core/src/repositories packages/runtime-core/tests
git commit -m "feat(runtime): add tenant scoped repositories"
```

### Task 5: Implement durable idempotency, job leases, event sequencing, Outbox, and redaction

**Files:**
- Create: `packages/runtime-core/src/domain/idempotency.ts`
- Create: `packages/runtime-core/src/domain/jobs.ts`
- Create: `packages/runtime-core/src/domain/events.ts`
- Create: `packages/runtime-core/src/domain/redaction.ts`
- Create: `packages/runtime-core/src/domain/transitions.ts`
- Create: `packages/runtime-core/src/repositories/jobs.ts`
- Create: `packages/runtime-core/src/repositories/events.ts`
- Create: `packages/runtime-core/tests/idempotency.test.ts`
- Create: `packages/runtime-core/tests/jobs.test.ts`
- Create: `packages/runtime-core/tests/events.test.ts`
- Create: `packages/runtime-core/tests/redaction.test.ts`
- Modify: `packages/runtime-core/src/index.ts`

**Interfaces:**
- Consumes: tenant transactions, contract transition functions, ProductEvent and AuditEvent schemas.
- Produces: `canonicalPayloadHash`, `beginIdempotentCommand`, `claimJobs`, `heartbeatJob`, `completeJob`, `rescheduleJob`, `failJob`, `appendProductEvents`, `enqueueOutbox`, `redactSummary`, and `classifyDependencyFailure`.

- [ ] **Step 1: Write failing concurrency and secrecy tests**

```ts
test("same key and hash replay one result while a different hash conflicts", async () => {
  const first = await createSyntheticCommand("idem_1", "sha256:" + "a".repeat(64));
  const replay = await createSyntheticCommand("idem_1", "sha256:" + "a".repeat(64));
  assert.deepEqual(replay, { kind: "replay", response: first.response });
  await assert.rejects(
    createSyntheticCommand("idem_1", "sha256:" + "b".repeat(64)),
    /IDEMPOTENCY_CONFLICT/,
  );
});

test("concurrent workers claim a job once and reclaim only after lease expiry", async () => {
  await insertJob({ job_id: "job_1", next_attempt_at: new Date(0) });
  const [left, right] = await Promise.all([
    claimJobs(db, { workerId: "worker_a", limit: 1, leaseMs: 30_000 }),
    claimJobs(db, { workerId: "worker_b", limit: 1, leaseMs: 30_000 }),
  ]);
  assert.equal(left.length + right.length, 1);
  await advanceDatabaseClockPastLease("job_1");
  assert.equal((await claimJobs(db, {
    workerId: "worker_c",
    limit: 1,
    leaseMs: 30_000,
  })).length, 1);
});

test("redaction removes registered material and credential-shaped fields", () => {
  const redactor = createRedactor(["sentinel-secret-0123456789"]);
  const result = redactor.redact({
    message: "provider rejected sentinel-secret-0123456789",
    authorization: "Bearer abc",
    safe_code: "DEPENDENCY_UNAVAILABLE",
  });
  assert.deepEqual(result, {
    message: "provider rejected [REDACTED]",
    authorization: "[REDACTED]",
    safe_code: "DEPENDENCY_UNAVAILABLE",
  });
});
```

- [ ] **Step 2: Confirm red state**

Run:

```bash
npm run test:postgres -w @core-agent/runtime-core -- --test-name-pattern="replay one result|claim a job"
npm test -w @core-agent/runtime-core -- --test-name-pattern="redaction"
```

Expected: FAIL because the durable primitives do not exist.

- [ ] **Step 3: Implement canonical hashing and idempotent command admission**

Canonical JSON sorts object keys recursively, preserves array order, rejects
`undefined`, non-finite numbers, prototypes other than `Object.prototype` or
`null`, and secret-shaped keys. Hash UTF-8 bytes with SHA-256 and return the
literal prefix `sha256:` followed by exactly 64 lowercase hexadecimal
characters.

Define the shared failure types before repository logic:

```ts
export type StableDomainErrorCode =
  | "INVALID_REQUEST"
  | "UNAUTHENTICATED"
  | "RESOURCE_NOT_FOUND"
  | "IDEMPOTENCY_CONFLICT"
  | "RESOURCE_VERSION_CONFLICT"
  | "INVALID_STATE_TRANSITION"
  | "RUNTIME_NOT_READY"
  | "SUPERVISOR_REJECTED"
  | "DEPENDENCY_UNAVAILABLE"
  | "DEPENDENCY_TIMEOUT"
  | "INTERNAL_ERROR";

export class DomainError extends Error {
  constructor(
    readonly code: StableDomainErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export interface DependencyFailure {
  code: "DEPENDENCY_UNAVAILABLE" | "DEPENDENCY_TIMEOUT" | "SUPERVISOR_REJECTED";
  retryable: boolean;
  summary: string;
}
```

```ts
export type IdempotencyAdmission<T> =
  | { kind: "acquired"; recordId: string }
  | { kind: "replay"; response: T }
  | { kind: "in_progress" };

export async function beginIdempotentCommand<T>(
  context: TenantTransaction,
  input: {
    key: string;
    payloadHash: string;
    operation: string;
    expiresAt: Date;
  },
): Promise<IdempotencyAdmission<T>> {
  const inserted = await context.trx.insertInto("idempotency_records")
    .values({
      tenant_id: context.tenantId,
      idempotency_key: input.key,
      payload_hash: input.payloadHash,
      operation: input.operation,
      status: "in_progress",
      response_json: null,
      expires_at: input.expiresAt,
      created_at: new Date(),
      updated_at: new Date(),
    })
    .onConflict((conflict) => conflict.columns(["tenant_id", "idempotency_key"]).doNothing())
    .returning("idempotency_key")
    .executeTakeFirst();
  if (inserted !== undefined) return { kind: "acquired", recordId: input.key };
  const existing = await context.trx.selectFrom("idempotency_records")
    .select(["payload_hash", "status", "response_json"])
    .where("tenant_id", "=", context.tenantId)
    .where("idempotency_key", "=", input.key)
    .forUpdate()
    .executeTakeFirstOrThrow();
  if (existing.payload_hash !== input.payloadHash) {
    throw new DomainError("IDEMPOTENCY_CONFLICT", "Idempotency key payload mismatch");
  }
  if (existing.status === "completed") {
    return { kind: "replay", response: existing.response_json as T };
  }
  return { kind: "in_progress" };
}
```

- [ ] **Step 4: Implement leased claims and bounded retry**

Claim in one short transaction using `FOR UPDATE SKIP LOCKED`. The update must set `status='running'`, increment `attempt_count`, and set lease owner/expiry before returning jobs. External work occurs after commit.

```ts
export interface RetryDecision {
  disposition: "retry" | "permanent";
  nextAttemptAt?: Date;
  summary: string;
}

export function retryDecision(
  failure: DependencyFailure,
  attemptCount: number,
  maxAttempts: number,
  now: Date,
  random: () => number,
): RetryDecision {
  const summary = redactSummary(failure.summary, 1000);
  if (!failure.retryable || attemptCount >= maxAttempts) {
    return { disposition: "permanent", summary };
  }
  const ceilingMs = Math.min(60_000, 500 * 2 ** Math.max(0, attemptCount - 1));
  const jitterMs = Math.floor(ceilingMs * 0.25 * random());
  return {
    disposition: "retry",
    nextAttemptAt: new Date(now.getTime() + ceilingMs + jitterMs),
    summary,
  };
}
```

Heartbeat and terminal updates require matching `job_id`, `tenant_id`, `lease_owner`, and non-expired lease. A stale worker receives `{ kind: "lease_lost" }` and cannot complete the job.

- [ ] **Step 5: Implement transactional event sequences and Outbox**

Allocate sequence with one upsert returning the new value:

```sql
insert into stream_sequences (tenant_id, stream_id, last_sequence)
values ($1, $2, 1)
on conflict (tenant_id, stream_id)
do update set last_sequence = stream_sequences.last_sequence + 1
returning last_sequence;
```

`appendProductEvents` validates every complete event with `ProductEventSchema`, inserts it with the allocated sequence, and inserts one Outbox row in the same `TenantTransaction`. `appendAuditEvent` validates `AuditEventSchema` and never accepts an arbitrary dependency payload. Event append failure rolls back the resource mutation.

- [ ] **Step 6: Wrap contract transitions**

Create domain methods that call existing
`canTransitionContainerObservedState` and `canTransitionAgentRun` before any
update. Terminal Run states `succeeded`, `failed`, and `cancelled` reject
further writes. Failure summaries pass through
`redactSummary(value, 1000)` before persistence.

- [ ] **Step 7: Run all reliability tests and commit**

```bash
npm run test:postgres -w @core-agent/runtime-core
npm run check -w @core-agent/runtime-core
git diff --check
git add packages/runtime-core/src/domain packages/runtime-core/src/repositories packages/runtime-core/tests
git commit -m "feat(runtime): add durable execution primitives"
```

### Task 6: Implement SecretStore and the server-managed provider catalog

**Files:**
- Create: `packages/runtime-core/src/secrets/secret-store.ts`
- Create: `packages/runtime-core/src/secrets/file-secret-store.ts`
- Create: `packages/runtime-core/src/repositories/secret-references.ts`
- Create: `packages/runtime-core/tests/secrets.test.ts`
- Create: `infra/runtime/providers.dev.json`
- Create: `scripts/verify-no-secret.mjs`
- Modify: `packages/runtime-core/src/config/provider-catalog.ts`
- Modify: `packages/runtime-core/src/index.ts`

**Interfaces:**
- Consumes: opaque `SecretReference` metadata and a configured secret root.
- Produces: `SecretStore.get(reference)`, `FileSecretStore`, `SecretMaterial`, `ProviderCatalog.require(id, modelId)`, and no method that enumerates or logs secret bytes.

- [ ] **Step 1: Write failing file-boundary tests**

```ts
test("file secret store accepts one owner-only file beneath its root", async () => {
  await writeFile(join(root, "provider_tokenhub.v1"), "synthetic-secret");
  await chmod(join(root, "provider_tokenhub.v1"), 0o600);
  const material = await store.get({
    reference_id: "provider_tokenhub",
    version: 1,
    purpose: "model_provider",
  });
  assert.equal(material.text(), "synthetic-secret");
  material.release();
  assert.throws(() => material.text(), /released/);
});

test("file secret store rejects traversal, symlink, and group-readable files", async () => {
  await assert.rejects(store.get({
    reference_id: "../escape",
    version: 1,
    purpose: "model_provider",
  }), /reference/);
  await symlink(outsideFile, join(root, "linked.v1"));
  await assert.rejects(store.get({
    reference_id: "linked",
    version: 1,
    purpose: "model_provider",
  }), /regular file/);
  await writeFile(join(root, "wide.v1"), "synthetic-secret", { mode: 0o640 });
  await assert.rejects(store.get({
    reference_id: "wide",
    version: 1,
    purpose: "model_provider",
  }), /0600/);
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm test -w @core-agent/runtime-core -- --test-name-pattern="secret store"`

Expected: FAIL because `FileSecretStore` does not exist.

- [ ] **Step 3: Implement the secret port and releasable material**

```ts
export interface SecretReference {
  reference_id: string;
  version: number;
  purpose: "model_provider" | "hermes_ingress" | "bootstrap_service";
}

export interface SecretMaterial {
  readonly reference: SecretReference;
  text(): string;
  release(): void;
}

export interface SecretStore {
  get(reference: SecretReference): Promise<SecretMaterial>;
}
```

`FileSecretStore.get` validates `reference_id` with
`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`, derives the filename with
`reference.reference_id + ".v" + reference.version`, resolves and checks the
real parent root, opens with `O_RDONLY | O_NOFOLLOW`, calls `fstat`, requires a
regular file, current uid, exact permission bits `0600`, and maximum 64 KiB.
It copies into a private buffer. `release` fills that buffer with zero and
prevents later reads, while documentation explicitly avoids claiming physical
JavaScript zeroization.

- [ ] **Step 4: Persist references and add the development catalog**

The repository writes metadata only after verifying the declared purpose and positive version. Create `providers.dev.json` with one non-secret managed entry:

```json
[
  {
    "provider_config_id": "tokenhub-main",
    "base_url": "https://tokenhub.infplacex.com/v1/chat/completions",
    "model_ids": ["cywx/gpt-5.6-sol"],
    "credential_secret_ref": "provider_tokenhub_main",
    "timeout_ms": 90000,
    "max_safe_retries": 1
  }
]
```

The catalog parser freezes entries and indexes by ID. `require(id, modelId)` rejects unknown IDs/models without reflecting the untrusted URL or secret reference in the error.

- [ ] **Step 5: Add a sentinel scan and commit**

Run:

```bash
npm test -w @core-agent/runtime-core
npm run test:postgres -w @core-agent/runtime-core -- --test-name-pattern="secret"
node scripts/verify-no-secret.mjs synthetic-secret
git diff --check
git add packages/runtime-core/src/secrets packages/runtime-core/src/repositories/secret-references.ts packages/runtime-core/tests/secrets.test.ts infra/runtime/providers.dev.json
git commit -m "feat(runtime): add file backed secret store"
```

The sentinel scanner checks tracked fixtures, generated logs, PostgreSQL query output, and Docker inspection JSON paths supplied on the command line. It prints file/table identifiers only, never the matching bytes.

### Task 7: Define and fake the versioned Runtime Supervisor protocol

**Files:**
- Create: `packages/runtime-core/src/supervisor/contracts.ts`
- Create: `packages/runtime-core/src/supervisor/client.ts`
- Create: `packages/runtime-core/src/supervisor/fake-server.ts`
- Create: `packages/runtime-core/tests/supervisor-client.test.ts`
- Create: `apps/runtime-supervisor/src/protocol.ts`
- Create: `apps/runtime-supervisor/src/policy.ts`
- Create: `apps/runtime-supervisor/tests/protocol.test.ts`
- Create: `apps/runtime-supervisor/tests/policy.test.ts`
- Modify: `packages/runtime-core/src/index.ts`

**Interfaces:**
- Consumes: server-derived RuntimeSpec, opaque secret references, immutable image digest, operation ID, and canonical request hash.
- Produces: `SupervisorRequestV1`, `SupervisorResponseV1`, `RuntimeSupervisorClient`, `validateSupervisorRequest`, `canonicalSupervisorRequestHash`, and a deterministic Unix-socket fake.

- [ ] **Step 1: Write an unsafe-operation rejection matrix**

```ts
const forbidden = [
  { command: "exec", args: ["sh"] },
  { kind: "provision", host_path: "/Users/example" },
  { kind: "provision", image_ref: "core-agent/hermes-runtime:latest" },
  { kind: "provision", ports: ["0.0.0.0:8642:8642"] },
  { kind: "provision", environment: { API_SERVER_KEY: "sentinel" } },
  { kind: "provision", docker_options: { Privileged: true } },
  { kind: "provision", network_ref: "client-selected" },
  { kind: "delete", destroy_volume: true },
];

for (const value of forbidden) {
  assert.throws(() => validateSupervisorRequest(value), /SUPERVISOR_REJECTED/);
}
```

Add round-trip tests for partial reads, messages over 256 KiB, invalid JSON, duplicate operation with same hash, and duplicate operation with a different hash.

- [ ] **Step 2: Run and confirm failure**

```bash
npm test -w @core-agent/runtime-core -- --test-name-pattern="Supervisor"
npm test -w @core-agent/runtime-supervisor -- --test-name-pattern="unsafe|duplicate"
```

Expected: FAIL because neither protocol package exists.

- [ ] **Step 3: Define the closed request union**

```ts
export interface SupervisorEnvelopeV1 {
  protocol_version: 1;
  operation_id: string;
  request_hash: string;
}

export interface ProvisionRuntimeCommandV1 extends SupervisorEnvelopeV1 {
  kind: "provision";
  runtime: {
    tenant_id: string;
    runtime_id: string;
    generation: number;
    image_ref: string;
    platform: "linux/amd64" | "linux/arm64";
    volume_ref: string;
    ingress_secret_ref: SecretReference;
    profiles: readonly {
      profile_id: string;
      hermes_profile_ref: string;
      description: string;
      provider_config_id: string;
      provider_base_url: string;
      model_id: string;
      provider_secret_ref: SecretReference;
    }[];
  };
}

export interface RuntimeObservation {
  tenant_id: string;
  runtime_id: string;
  generation: number;
  exists: boolean;
  lifecycle: "created" | "running" | "stopped" | "removed";
  health: "unknown" | "healthy" | "degraded" | "unhealthy";
  image_ref: string;
  private_origin?: string;
}

export type SupervisorRequestV1 =
  | ProvisionRuntimeCommandV1
  | (SupervisorEnvelopeV1 & {
      kind: "inspect" | "start" | "stop" | "restart" | "delete";
      tenant_id: string;
      runtime_id: string;
      generation: number;
    });

export type SupervisorResponseV1 =
  | {
      protocol_version: 1;
      operation_id: string;
      outcome: "accepted";
      observation: RuntimeObservation;
    }
  | {
      protocol_version: 1;
      operation_id: string;
      outcome: "rejected" | "failed";
      code: "SUPERVISOR_REJECTED" | "DEPENDENCY_UNAVAILABLE" | "DEPENDENCY_TIMEOUT";
      retryable: boolean;
      summary: string;
    };
```

No index signature or `unknown` extension bag is allowed. The lifecycle union has no `exec`, `destroy_volume`, `pull`, `build`, or `run` command.

- [ ] **Step 4: Implement framing, hashing, and the fake server**

Use unsigned 32-bit big-endian length-prefixed UTF-8 JSON. Reject zero length, more than 262,144 bytes, trailing bytes, timeout over 10 seconds, protocol version other than 1, and unknown properties. Hash canonical request data excluding `request_hash` and require exact equality before dispatch.

`RuntimeSupervisorClient.execute(request, signal)` opens one Unix socket per request, writes one frame, half-closes, reads one frame, redacts transport errors, and closes in `finally`. The fake server accepts scripted outcomes and records validated request objects without secret values.

- [ ] **Step 5: Implement strict server policy**

Derive Docker names internally:

```ts
export function deriveRuntimeNames(input: {
  tenant_id: string;
  runtime_id: string;
  generation: number;
}) {
  const suffix = createHash("sha256")
    .update(input.tenant_id + "\0" + input.runtime_id)
    .digest("hex")
    .slice(0, 16);
  return {
    container: "core-agent-runtime-" + suffix + "-g" + input.generation,
    volume: "core-agent-data-" + suffix,
    network: "core-agent-backplane",
  } as const;
}
```

Policy validates managed image digest against `infra/hermes/base-images.lock.json`, exact provider URL/model against the catalog, unique Profile refs, bounded descriptions, generation, label values, and secret-reference purposes. It rejects user-derived Docker names even if they resemble the derived result.

- [ ] **Step 6: Run and commit**

```bash
npm run check -w @core-agent/runtime-core
npm run check -w @core-agent/runtime-supervisor
git diff --check
git add packages/runtime-core/src/supervisor packages/runtime-core/tests/supervisor-client.test.ts apps/runtime-supervisor
git commit -m "feat(supervisor): define narrow runtime protocol"
```

### Task 8: Replace development container exec with the fixed Hermes initializer and gateway entrypoint

**Files:**
- Create: `infra/hermes/runtime/initialize.py`
- Create: `infra/hermes/runtime/gateway-entrypoint.sh`
- Modify: `infra/hermes/Dockerfile`
- Modify: `scripts/bootstrap-demo-company.mjs`
- Modify: `tests/runtime/bootstrap-company.test.mjs`
- Modify: `tests/runtime/runtime-contract.test.mjs`
- Create: `tests/runtime/hermes-initializer.test.mjs`

**Interfaces:**
- Consumes: a version-1 RuntimeBootstrapBundle at fixed path `/run/core-agent/bootstrap/bundle.json`, read-only staged secret files, and target volume `/opt/data`.
- Produces: declared Hermes Profiles, atomic `0600` Profile `.env` files, non-secret `/opt/data/.core-agent/manifest.json`, and gateway startup that reads ingress key from `/run/secrets/hermes_ingress`.

- [ ] **Step 1: Write failing static and executable initializer tests**

```js
test("product image has fixed initialize and gateway entrypoints", () => {
  assert.match(dockerfile, /COPY infra\/hermes\/runtime\/initialize\.py \/opt\/core-agent\/initialize\.py/);
  assert.match(dockerfile, /COPY infra\/hermes\/runtime\/gateway-entrypoint\.sh \/opt\/core-agent\/gateway-entrypoint\.sh/);
  assert.match(dockerfile, /ENTRYPOINT \["\/opt\/core-agent\/gateway-entrypoint\.sh"\]/);
  assert.doesNotMatch(dockerfile, /API_SERVER_KEY=/);
});

test("legacy bootstrap never invokes docker compose exec", () => {
  assert.doesNotMatch(bootstrapSource, /compose[\s\S]*exec/);
  assert.doesNotMatch(bootstrapSource, /python[\s\S]*-c/);
});
```

Execute `initialize.py` in a temporary fake Hermes home with a fake `hermes` executable. Assert exact subprocess argument arrays, no shell, no network action, idempotent manifest hash, atomic file replacement, `0600` mode, and output that contains no sentinel secret.

- [ ] **Step 2: Run and confirm failure**

Run: `npm run test:runtime -- --test-name-pattern="initializer|entrypoint|never invokes"`

Expected: FAIL because the image still relies on `docker compose exec` and environment-configured gateway key.

- [ ] **Step 3: Implement strict bundle validation**

The initializer accepts exactly this JSON shape:

```json
{
  "bundle_version": 1,
  "tenant_id": "tenant_synthetic",
  "runtime_id": "runtime_synthetic",
  "generation": 1,
  "image_ref": "core-agent/hermes-runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "profiles": [
    {
      "profile_id": "profile_consultant",
      "hermes_profile_ref": "consultant",
      "description": "Synthetic consultant profile",
      "provider_base_url": "https://tokenhub.infplacex.com/v1/chat/completions",
      "model_id": "cywx/gpt-5.6-sol",
      "provider_secret_file": "/run/core-agent/secrets/profile_consultant_provider"
    }
  ]
}
```

Reject unknown keys, duplicate Profile IDs/refs, more than 64 Profiles, invalid IDs, descriptions over 2,000 characters, non-HTTPS base URL, unapproved model, secret paths outside `/run/core-agent/secrets`, symlinks, non-regular files, and secret files not mode `0400` or `0600`.

- [ ] **Step 4: Implement fixed Profile creation and atomic projection**

For each sorted Profile, call without `shell=True`:

```python
show = subprocess.run(
    ["hermes", "profile", "show", profile_ref],
    check=False,
    stdin=subprocess.DEVNULL,
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
)
if show.returncode == 0:
    subprocess.run(
        ["hermes", "profile", "describe", profile_ref, "--text", description],
        check=True,
        stdin=subprocess.DEVNULL,
    )
else:
    subprocess.run(
        [
            "hermes", "profile", "create", profile_ref,
            "--no-skills", "--no-alias", "--description", description,
        ],
        check=True,
        stdin=subprocess.DEVNULL,
    )
```

Write only the server-managed keys `OPENAI_API_KEY`, `OPENAI_BASE_URL`, and `LLM_MODEL` to each Profile `.env`. Create a temporary file in the same directory with `O_CREAT | O_EXCL` and `0600`, fsync it, rename atomically, fsync the directory, and unlink it on failure. Never print subprocess environment or secret content.

The manifest contains only bundle version, tenant/runtime IDs, generation, image ref, sorted Profile IDs/refs, and SHA-256 of canonical non-secret fields. Re-running an identical bundle returns the existing manifest; a differing manifest for the same generation fails closed.

- [ ] **Step 5: Implement gateway secret-file startup**

`gateway-entrypoint.sh` accepts no arguments and performs:

```sh
#!/bin/sh
set -eu
key_file=/run/secrets/hermes_ingress
if [ ! -f "$key_file" ]; then
  echo "Hermes ingress secret file is unavailable" >&2
  exit 78
fi
API_SERVER_KEY=$(tr -d '\r\n' < "$key_file")
if [ "${#API_SERVER_KEY}" -lt 16 ]; then
  echo "Hermes ingress secret is unusable" >&2
  exit 78
fi
export API_SERVER_KEY
exec hermes gateway run
```

The Dockerfile sets non-secret API host/port/multiplex variables, copies both fixed scripts, marks them root-owned and non-writable, declares the gateway entrypoint, and keeps the image digest build flow unchanged.

- [ ] **Step 6: Remove the legacy exec path, run tests, and commit**

`bootstrap-demo-company.mjs` becomes a compatibility wrapper that calls the new internal provisioning API with the anonymous demo fixture. It never reads a provider key and never calls Docker.

```bash
npm run test:runtime
npm test
git diff --check
git add infra/hermes scripts/bootstrap-demo-company.mjs tests/runtime
git commit -m "feat(hermes): add fixed profile initializer"
```

### Task 9: Implement the Docker adapter and Runtime Supervisor Unix service

**Files:**
- Create: `apps/runtime-supervisor/src/docker-adapter.ts`
- Create: `apps/runtime-supervisor/src/operation-journal.ts`
- Create: `apps/runtime-supervisor/src/redact-docker-error.ts`
- Create: `apps/runtime-supervisor/src/server.ts`
- Create: `apps/runtime-supervisor/src/main.ts`
- Create: `apps/runtime-supervisor/tests/docker-adapter.test.ts`
- Create: `apps/runtime-supervisor/tests/operation-journal.test.ts`
- Create: `apps/runtime-supervisor/tests/server.test.ts`
- Modify: `apps/runtime-supervisor/src/policy.ts`
- Modify: `apps/runtime-supervisor/package.json`

**Interfaces:**
- Consumes: validated `SupervisorRequestV1`, managed image lock, provider catalog, Supervisor-owned SecretStore, and Docker Engine socket.
- Produces: idempotent `DockerRuntimeAdapter.execute(request)` and one length-framed Unix socket service at a configured fixed path.

- [ ] **Step 1: Write failing Docker option and adoption tests with a fake Dockerode client**

```ts
test("initializer has no network, capabilities, socket, or secret environment", async () => {
  await adapter.provision(validProvisionRequest);
  assert.deepEqual(fakeDocker.createdInitializer.HostConfig.NetworkMode, "none");
  assert.deepEqual(fakeDocker.createdInitializer.HostConfig.CapDrop, ["ALL"]);
  assert.equal(fakeDocker.createdInitializer.HostConfig.ReadonlyRootfs, true);
  assert.equal(fakeDocker.createdInitializer.HostConfig.Binds.some(
    (bind: string) => bind.includes("docker.sock"),
  ), false);
  assert.equal(JSON.stringify(fakeDocker.createdInitializer).includes(sentinelSecret), false);
});

test("adoption refuses one mismatched Core-Agent label", async () => {
  fakeDocker.existingContainerLabels["core-agent.request-hash"] = "sha256:" + "f".repeat(64);
  await assert.rejects(adapter.provision(validProvisionRequest), /SUPERVISOR_REJECTED/);
  assert.equal(fakeDocker.removeCalls.length, 0);
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm test -w @core-agent/runtime-supervisor -- --test-name-pattern="initializer|adoption"`

Expected: FAIL because `DockerRuntimeAdapter` does not exist.

- [ ] **Step 3: Implement exact initializer Docker configuration**

Supervisor creates a restricted temporary directory with `0700`, resolves SecretStore material itself, writes staged files with `0600`, and deletes the directory in `finally`. Docker receives only read-only file mounts:

```ts
const initializerOptions: Dockerode.ContainerCreateOptions = {
  name: names.container + "-initializer-" + createHash("sha256")
    .update(request.operation_id)
    .digest("hex")
    .slice(0, 12),
  Image: request.runtime.image_ref,
  Entrypoint: ["/opt/hermes/.venv/bin/python", "/opt/core-agent/initialize.py"],
  Cmd: [
    "--bundle", "/run/core-agent/bootstrap/bundle.json",
    "--data-root", "/opt/data",
    "--manifest", "/opt/data/.core-agent/manifest.json",
  ],
  Env: [],
  Labels: managedLabels(request),
  HostConfig: {
    AutoRemove: false,
    NetworkMode: "none",
    ReadonlyRootfs: true,
    CapDrop: ["ALL"],
    SecurityOpt: ["no-new-privileges:true"],
    Binds: [
      names.volume + ":/opt/data",
      bundlePath + ":/run/core-agent/bootstrap/bundle.json:ro",
      secretDirectory + ":/run/core-agent/secrets:ro",
    ],
    Tmpfs: {
      "/tmp": "rw,noexec,nosuid,nodev,size=64m,mode=1777",
      "/run/core-agent/output": "rw,noexec,nosuid,nodev,size=16m,mode=0700",
    },
    Memory: 1_073_741_824,
    NanoCpus: 1_000_000_000,
    PidsLimit: 256,
  },
};
```

Wait for exit with a bounded timeout, accept only code 0, read the non-secret manifest through a fixed output mount or a second fixed read-only verifier container, and reduce Docker stderr to a bounded allowlisted summary. Never read a Docker-managed volume host path.

- [ ] **Step 4: Implement exact gateway configuration**

Gateway uses the shared private `core-agent-backplane` network and no published ports:

```ts
const gatewayOptions: Dockerode.ContainerCreateOptions = {
  name: names.container,
  Image: request.runtime.image_ref,
  Entrypoint: ["/opt/core-agent/gateway-entrypoint.sh"],
  Cmd: [],
  Env: [
    "API_SERVER_ENABLED=true",
    "API_SERVER_HOST=0.0.0.0",
    "API_SERVER_PORT=8642",
    "GATEWAY_MULTIPLEX_PROFILES=true",
  ],
  Labels: managedLabels(request),
  ExposedPorts: { "8642/tcp": {} },
  HostConfig: {
    NetworkMode: names.network,
    PortBindings: {},
    ReadonlyRootfs: true,
    CapDrop: ["ALL"],
    SecurityOpt: ["no-new-privileges:true"],
    Binds: [
      names.volume + ":/opt/data",
      ingressSecretPath + ":/run/secrets/hermes_ingress:ro",
    ],
    Tmpfs: {
      "/run": "rw,nosuid,nodev,size=64m,mode=0755,exec",
      "/tmp": "rw,nosuid,nodev,size=256m,mode=1777",
      "/var/tmp": "rw,nosuid,nodev,size=64m,mode=1777",
    },
    Memory: 4_294_967_296,
    NanoCpus: 2_000_000_000,
    PidsLimit: 512,
    RestartPolicy: { Name: "unless-stopped" },
  },
  Healthcheck: {
    Test: ["CMD-SHELL", "curl --fail --silent http://127.0.0.1:8642/health >/dev/null || exit 1"],
    Interval: 10_000_000_000,
    Timeout: 5_000_000_000,
    Retries: 12,
    StartPeriod: 30_000_000_000,
  },
};
```

The ingress secret path is Supervisor-derived within its restricted root; it is never part of a request. Docker inspection must contain the path but not the secret bytes.

- [ ] **Step 5: Implement idempotent adoption and lifecycle operations**

Before create/adopt, inspect exact derived resource names. Adoption requires every label, tenant/runtime ID, image digest, generation, volume, network, and canonical request hash to match. Unknown or partially matching resources yield permanent `SUPERVISOR_REJECTED` and are never renamed, stopped, or removed.

`delete` removes only the exact managed container after label validation and preserves the named volume. `start`, `stop`, and `restart` act only on the validated managed container. `inspect` returns bounded state, health, image digest, generation, and private network address without raw Docker JSON.

- [ ] **Step 6: Persist idempotent Supervisor operation outcomes**

Create a Supervisor-owned operation journal directory with mode `0700`. One
validated operation ID maps to a filename derived from its SHA-256 digest, not
the raw ID. Each atomically replaced `0600` JSON record contains only protocol
version, operation ID, canonical request hash, completion timestamp, and the
bounded redacted `SupervisorResponseV1`.

Before Docker access, the service reads the journal:

- same operation ID and same request hash returns the stored response;
- same operation ID and different hash returns permanent
  `SUPERVISOR_REJECTED`;
- missing record executes once, then fsyncs the atomic record before replying.

On restart, completed provision/start/stop/restart/delete operations replay
without a second Docker mutation. A crash before journal commit is resolved by
Docker inspection and the same strict Core-Agent labels/request hash; the
adapter either adopts the exact effect or fails closed.

- [ ] **Step 7: Implement the Unix service boundary**

At startup, remove an existing socket only when `lstat` proves it is a socket owned by the current uid. Bind, `chmod 0660`, and refuse a world-writable parent directory. Handle one framed request per connection, validate before Docker access, cap concurrent operations at four, apply a 120-second operation deadline, and redact every response.

Terminate on SIGTERM by closing the listener, refusing new work, waiting up to 30 seconds for active operations, and leaving Docker resources unchanged.

- [ ] **Step 8: Run Supervisor gates and commit**

```bash
npm run check -w @core-agent/runtime-supervisor
npm test -w @core-agent/runtime-core -- --test-name-pattern="Supervisor"
node scripts/verify-no-secret.mjs synthetic-supervisor-secret
git diff --check
git add apps/runtime-supervisor
git commit -m "feat(supervisor): manage isolated Hermes runtimes"
```

### Task 10: Build the internal Fastify API foundation, authentication, errors, and health

**Files:**
- Create: `apps/control-plane-api/src/app.ts`
- Create: `apps/control-plane-api/src/auth.ts`
- Create: `apps/control-plane-api/src/errors.ts`
- Create: `apps/control-plane-api/src/server.ts`
- Create: `apps/control-plane-api/src/routes/health.ts`
- Create: `apps/control-plane-api/tests/auth.test.ts`
- Create: `apps/control-plane-api/tests/health.test.ts`
- Modify: `apps/control-plane-api/package.json`

**Interfaces:**
- Consumes: `RuntimeEnvironment`, `Kysely<RuntimeDatabase>`, ProviderCatalog, bootstrap key file, and Pino logger.
- Produces: `buildControlPlaneApp(dependencies)`, `authenticateBootstrapRequest`, `ApiRequestContext`, ErrorEnvelope mapping, `GET /health/live`, and `GET /health/ready`.

- [ ] **Step 1: Write failing API injection tests**

```ts
test("live is dependency-free while ready checks exact schema", async () => {
  const app = await buildTestApp({ schemaVersion: 3 });
  assert.equal((await app.inject({ method: "GET", url: "/health/live" })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/health/ready" })).statusCode, 200);
  const drifted = await buildTestApp({ schemaVersion: 2 });
  assert.equal((await drifted.inject({ method: "GET", url: "/health/ready" })).statusCode, 503);
});

test("bootstrap authentication rejects missing and invalid keys", async () => {
  const app = await buildTestApp({ bootstrapKey: "synthetic-bootstrap-key-00000001" });
  assert.equal((await app.inject({
    method: "POST",
    url: "/internal/v1/test-auth",
  })).statusCode, 401);
  const response = await app.inject({
    method: "POST",
    url: "/internal/v1/test-auth",
    headers: { authorization: "Bearer wrong-key-of-equal-safe-length" },
  });
  assert.equal(response.statusCode, 401);
  assert.equal(response.body.includes("synthetic-bootstrap-key"), false);
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm test -w @core-agent/control-plane-api -- --test-name-pattern="live|bootstrap"`

Expected: FAIL because the application factory does not exist.

- [ ] **Step 3: Implement constant-time bootstrap authentication**

Read the key once at startup from the configured file, require a regular owner-only `0600` file, trim one trailing newline, require 32 through 512 UTF-8 bytes, hash with SHA-256, release the source buffer, and retain only the 32-byte digest.

```ts
export function verifyBootstrapKey(
  configuredDigest: Buffer,
  authorization: string | undefined,
): boolean {
  const prefix = "Bearer ";
  const candidate = authorization?.startsWith(prefix)
    ? authorization.slice(prefix.length)
    : "";
  const candidateDigest = createHash("sha256").update(candidate, "utf8").digest();
  return configuredDigest.length === candidateDigest.length
    && timingSafeEqual(configuredDigest, candidateDigest);
}
```

Every protected request receives server-generated `request_id` and `trace_id`, a `tenant_id` from the validated `X-Core-Agent-Tenant-Id` header when the route is tenant-scoped, and the deterministic provisioner service identity. Never trust caller-supplied Actor, Membership, role, request ID, trace ID, or tenant fields when a path/header supplies authority.

- [ ] **Step 4: Map errors to the existing ErrorEnvelope**

Create one typed `DomainError` mapper:

```ts
const HTTP_BY_CODE: Readonly<Record<StableApiErrorCode, number>> = {
  INVALID_REQUEST: 400,
  UNAUTHENTICATED: 401,
  RESOURCE_NOT_FOUND: 404,
  IDEMPOTENCY_CONFLICT: 409,
  RESOURCE_VERSION_CONFLICT: 409,
  INVALID_STATE_TRANSITION: 409,
  RUNTIME_NOT_READY: 409,
  SUPERVISOR_REJECTED: 409,
  DEPENDENCY_UNAVAILABLE: 503,
  DEPENDENCY_TIMEOUT: 504,
  INTERNAL_ERROR: 500,
};
```

`StableApiErrorCode` is an alias of the `StableDomainErrorCode` exported by
Runtime Core. Fastify validation failures are normalized to
`INVALID_REQUEST` before entering this map.

The response contains stable code/category, a bounded public message, request/trace IDs, retryability, and no stack/dependency body. Log the same redacted fields; only `INTERNAL_ERROR` logs an internal error object, passed through the redactor.

- [ ] **Step 5: Implement liveness and readiness**

`/health/live` returns process status without database access. `/health/ready` executes `select 1`, `assertSchemaVersion(db, 3)`, and managed provider/image-lock validation. Supervisor and Hermes observations appear only as redacted dependency detail and do not make the API unready.

- [ ] **Step 6: Run API checks and commit**

```bash
npm run check -w @core-agent/control-plane-api
npm test
git diff --check
git add apps/control-plane-api
git commit -m "feat(api): add internal API foundation"
```

### Task 11: Implement idempotent tenant provisioning and runtime command endpoints

**Files:**
- Create: `apps/control-plane-api/src/routes/provisioning.ts`
- Create: `apps/control-plane-api/src/routes/runtime.ts`
- Create: `apps/control-plane-api/tests/provisioning.test.ts`
- Create: `apps/control-plane-api/tests/runtime.test.ts`
- Create: `packages/runtime-core/src/services/provision-tenant.ts`
- Create: `packages/runtime-core/src/services/command-runtime.ts`
- Create: `packages/runtime-core/tests/provision-tenant.test.ts`
- Modify: `apps/control-plane-api/src/app.ts`
- Modify: `packages/runtime-core/src/index.ts`

**Interfaces:**
- Consumes: contract-valid IdentityGraph, managed provider ID/model, opaque secret references, pinned runtime image, idempotency fields, and expected resource version.
- Produces: `POST /internal/v1/tenant-provisioning`, `GET /internal/v1/tenants/:tenant_id/runtime`, `POST /internal/v1/tenants/:tenant_id/runtime-commands`, `provisionTenant`, and `commandRuntime`.

- [ ] **Step 1: Write failing HTTP transaction tests**

```ts
test("provisioning returns one accepted runtime and replays the same response", async () => {
  const request = syntheticProvisioningRequest();
  const first = await app.inject(authenticated({
    method: "POST",
    url: "/internal/v1/tenant-provisioning",
    payload: request,
  }));
  const replay = await app.inject(authenticated({
    method: "POST",
    url: "/internal/v1/tenant-provisioning",
    payload: request,
  }));
  assert.equal(first.statusCode, 202);
  assert.deepEqual(replay.json(), first.json());
  assert.equal(await countRows("runtime_containers"), 1);
  assert.equal(await countRows("worker_jobs"), 1);
});

test("same provisioning key with a different hash conflicts", async () => {
  const request = syntheticProvisioningRequest();
  await provision(request);
  const response = await provision({
    ...request,
    payload_hash: "sha256:" + "b".repeat(64),
  });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error.code, "IDEMPOTENCY_CONFLICT");
});
```

- [ ] **Step 2: Run and confirm failure**

Run:

```bash
npm test -w @core-agent/control-plane-api -- --test-name-pattern="provisioning|different hash"
```

Expected: FAIL with route not found.

- [ ] **Step 3: Define the closed provisioning request**

The Fastify schema accepts:

```ts
interface TenantProvisioningRequest {
  schema_version: 1;
  idempotency_key: string;
  payload_hash: string;
  client_request_id: string;
  identity_graph: IdentityGraph;
  provider_config_id: string;
  model_id: string;
  runtime: {
    image_ref: string;
    platform: "linux/amd64" | "linux/arm64";
    ingress_secret_ref: string;
  };
  profile_runtime_config: readonly {
    profile_id: string;
    description: string;
  }[];
}
```

Require exactly one runtime config for every Profile and no extras. Validate `payload_hash === canonicalPayloadHash` of the request excluding `payload_hash`. Enforce B2B consultant Profiles and B2C exactly one default student Profile through `validateIdentityGraph`. Require initial Tenant/Profile status `provisioning`. Reject client-supplied service Actor/Membership IDs reserved with prefix `core_agent_`.

Resolve the top-level provider/model against `ProviderCatalog`. Derive the
provider credential SecretStore reference from that managed catalog entry;
the request cannot select or override the provider secret reference.

- [ ] **Step 4: Implement one provisioning transaction**

Inside one serializable tenant transaction:

1. admit the idempotency key;
2. return stored response on replay;
3. insert Tenant, human Actors/Memberships, and Profiles;
4. derive and insert service Actor `core_agent_provisioner` and admin Membership `core_agent_provisioner_admin`;
5. insert validated secret-reference metadata;
6. derive RuntimeContainer ID, volume reference, generation 1, desired `running`, observed `requested`, health `unknown`;
7. insert one `provision_runtime` job whose payload reference is the RuntimeContainer ID;
8. append `runtime.status_changed` and pending AuditEvent plus Outbox;
9. complete the idempotency record with only Tenant/Runtime resource references.

Do not call Supervisor or SecretStore inside the transaction.

- [ ] **Step 5: Implement runtime query and versioned commands**

`GET` requires matching path and tenant authority header and returns 404 for absent or cross-tenant runtime. The command body is:

```ts
interface RuntimeCommandRequest {
  schema_version: 1;
  idempotency_key: string;
  payload_hash: string;
  expected_resource_version: number;
  command: "start" | "stop" | "restart" | "delete";
}
```

Map start/restart to desired `running`, stop to `stopped`, and delete to `deleted`. Preserve the volume. In one transaction perform expected-version update, append an AuditEvent, enqueue `reconcile_runtime`, persist Outbox, and complete idempotency. Return `202`. A stale version returns `RESOURCE_VERSION_CONFLICT` with no mutation.

- [ ] **Step 6: Run API and PostgreSQL gates, then commit**

```bash
npm run test:postgres -w @core-agent/runtime-core -- --test-name-pattern="provision|runtime command"
npm run check -w @core-agent/control-plane-api
npm run check -w @core-agent/runtime-core
git diff --check
git add apps/control-plane-api/src/routes apps/control-plane-api/tests packages/runtime-core/src/services packages/runtime-core/tests
git commit -m "feat(api): add runtime provisioning commands"
```

### Task 12: Execute provisioning and desired-state reconciliation in the Worker

**Files:**
- Create: `apps/control-plane-worker/src/main.ts`
- Create: `apps/control-plane-worker/src/worker-loop.ts`
- Create: `apps/control-plane-worker/src/dispatch-job.ts`
- Create: `apps/control-plane-worker/src/handlers/provision-runtime.ts`
- Create: `apps/control-plane-worker/src/handlers/reconcile-runtime.ts`
- Create: `apps/control-plane-worker/src/handlers/dispatch-outbox.ts`
- Create: `apps/control-plane-worker/tests/worker-loop.test.ts`
- Create: `apps/control-plane-worker/tests/provision-runtime.test.ts`
- Create: `apps/control-plane-worker/tests/reconcile-runtime.test.ts`
- Create: `apps/control-plane-worker/tests/dispatch-outbox.test.ts`
- Modify: `apps/control-plane-worker/package.json`

**Interfaces:**
- Consumes: leased `provision_runtime` and `reconcile_runtime` jobs, repositories, ProviderCatalog, Runtime Supervisor client, ingress-only SecretStore access, and a Hermes probe port.
- Produces: `runWorkerLoop`, `dispatchJob`, `handleProvisionRuntime`, `handleReconcileRuntime`, correct Runtime transitions/events/audit, heartbeat, retry, and terminal failure behavior.

- [ ] **Step 1: Write failing deterministic Worker tests**

```ts
test("provisioning reaches ready only after Supervisor and all Profile probes", async () => {
  fakeSupervisor.reply({ outcome: "accepted", observation: healthyObservation });
  fakeHermes.probe("consultant_a", { ok: true });
  fakeHermes.probe("consultant_b", { ok: true });
  await dispatchNextJob();
  const runtime = await runtimeRepository.find("runtime_1");
  assert.equal(runtime?.observed_state, "ready");
  assert.equal(runtime?.health_status, "healthy");
  assert.deepEqual(await eventTypes("runtime_1"), [
    "runtime.status_changed",
    "runtime.status_changed",
    "runtime.status_changed",
  ]);
});

test("retryable Supervisor outage preserves requested truth and reschedules", async () => {
  fakeSupervisor.reply({
    outcome: "failed",
    code: "DEPENDENCY_UNAVAILABLE",
    retryable: true,
    summary: "Supervisor unavailable",
  });
  await dispatchNextJob();
  assert.equal((await runtimeRepository.find("runtime_1"))?.observed_state, "provisioning");
  assert.equal((await jobRepository.find("job_1"))?.status, "retry_scheduled");
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm test -w @core-agent/control-plane-worker -- --test-name-pattern="provisioning|Supervisor outage"`

Expected: FAIL because the Worker has no dispatch loop.

- [ ] **Step 3: Implement the lease-aware Worker loop**

```ts
export async function runWorkerLoop(
  dependencies: WorkerDependencies,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    const jobs = await claimJobs(dependencies.db, {
      workerId: dependencies.workerId,
      limit: 8,
      leaseMs: 30_000,
    });
    if (jobs.length === 0) {
      await dependencies.clock.wait(250, signal);
      continue;
    }
    await Promise.allSettled(jobs.map((job) => dispatchJob(dependencies, job, signal)));
  }
}
```

Define `WorkerDependencies` as one closed interface containing only `db`,
`workerId`, `clock`, `logger`, `repositories`, `providerCatalog`,
`supervisorClient`, `ingressSecretStore`, and `hermesClient`. It has no Docker
client, Docker socket path, provider SecretStore, or unfiltered environment
object.

Each dispatch installs a heartbeat every 10 seconds, clears it in `finally`, and checks lease ownership before every terminal transaction. Per-process concurrency is eight; provisioning/reconciliation additionally use a runtime-level PostgreSQL advisory lock so two jobs never mutate one runtime concurrently.

- [ ] **Step 4: Implement provision handling**

Within a short transaction, transition `requested -> provisioning` and append `runtime.status_changed`. Outside the transaction:

1. load tenant/profile/runtime facts by tenant scope;
2. resolve ProviderCatalog data but no provider secret bytes;
3. construct `ProvisionRuntimeCommandV1` with secret references;
4. call Supervisor;
5. on accepted observation, resolve only the Hermes ingress secret;
6. call every sorted Profile using
   `new URL("/p/" + encodeURIComponent(profile.hermes_profile_ref) + "/v1/chat/completions", "http://" + derivedNames.container + ":8642")`
   with a fixed synthetic readiness request and the Session header value
   `"readiness-" + runtime.runtime_id + "-" + runtime.generation`;
7. release ingress material immediately after probes.

On complete success, one transaction transitions `provisioning -> starting -> ready` as permitted, sets health `healthy`, activates Tenant/Profiles, appends ordered events/audit/Outbox, and completes the job. Permanent failure transitions to `failed` with redacted summary. Retryable failure leaves the last truthful observed state and reschedules.

- [ ] **Step 5: Implement desired/observed reconciliation**

`reconcile_runtime` calls `inspect` first. For desired `running`, issue `start` or `provision` only from compatible observations. For desired `stopped`, issue `stop`. For desired `deleted`, issue `delete` while preserving volume. Every Supervisor request uses a deterministic operation ID derived from job ID and attempt-safe operation kind, plus canonical hash.

Adopt only Supervisor observations that match tenant, runtime, generation, digest, and labels. Advance through contract transition functions; never assign observed state directly from Docker state text.

- [ ] **Step 6: Dispatch Outbox rows without making notifications authoritative**

Claim undelivered Outbox rows with `FOR UPDATE SKIP LOCKED` and a short lease.
For the Runtime v1 `postgres_event_wakeup` target, call
`select pg_notify('core_agent_events', payload)` where payload contains only
tenant ID, stream ID, and last committed sequence. Mark the row delivered only
after PostgreSQL accepts the notification. On failure, apply the bounded
Outbox retry schedule and redacted summary.

The API SSE loop always queries `product_events` before and after waiting, so a
lost notification or Outbox retry never hides an event. Add a test that stops
the dispatcher, reads the committed event successfully, restarts the
dispatcher, and marks the pending row delivered without duplicating the event.

- [ ] **Step 7: Run Worker checks and commit**

```bash
npm run check -w @core-agent/control-plane-worker
npm run check -w @core-agent/runtime-core
git diff --check
git add apps/control-plane-worker
git commit -m "feat(worker): reconcile Hermes runtime state"
```

### Task 13: Implement Conversation, Session, Message, and Agent Run admission

**Files:**
- Create: `apps/control-plane-api/src/routes/conversations.ts`
- Create: `apps/control-plane-api/src/routes/runs.ts`
- Create: `apps/control-plane-api/tests/conversations.test.ts`
- Create: `apps/control-plane-api/tests/runs.test.ts`
- Create: `packages/runtime-core/src/services/create-conversation.ts`
- Create: `packages/runtime-core/src/services/create-agent-run.ts`
- Create: `packages/runtime-core/tests/create-conversation.test.ts`
- Create: `packages/runtime-core/tests/create-agent-run.test.ts`
- Modify: `apps/control-plane-api/src/app.ts`
- Modify: `packages/runtime-core/src/index.ts`

**Interfaces:**
- Consumes: active tenant/Profile/runtime facts, bootstrap service context, optional Student/Case refs, contract `CreateAgentRunRequest`, and immutable Conversation binding.
- Produces: `POST /internal/v1/conversations`, `POST /internal/v1/conversations/:conversation_id/runs`, `GET /internal/v1/runs/:run_id`, and durable user Message/Run/job/events in one transaction.

- [ ] **Step 1: Write failing admission tests**

```ts
test("conversation binds one active Profile and creates one Hermes Session", async () => {
  const response = await createConversation({
    tenant_id: "tenant_a",
    profile_id: "profile_a",
  });
  assert.equal(response.statusCode, 201);
  const session = await sessionRepository.findByConversation(response.json().conversation_id);
  assert.equal(session?.status, "active");
  assert.match(session?.hermes_session_ref ?? "", /^hermes_session_/);
});

test("run admission atomically creates user Message, queued Run, job, and events", async () => {
  const response = await createRun(validCreateAgentRunRequest);
  assert.equal(response.statusCode, 202);
  const run = response.json();
  assert.equal((await runRepository.find(run.run_id))?.status, "queued");
  assert.equal((await messageRepository.listForRun(run.run_id))[0]?.role, "user");
  assert.deepEqual(await eventTypes(run.conversation_id), [
    "conversation.created",
    "message.created",
    "run.queued",
  ]);
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm test -w @core-agent/control-plane-api -- --test-name-pattern="conversation binds|run admission"`

Expected: FAIL with route not found.

- [ ] **Step 3: Implement Conversation creation**

The request contains `schema_version`, idempotency fields, `tenant_id`, `profile_id`, optional `student_ref` and `case_ref`. Require tenant authority header to match body. Validate Case/Student scope with `validateCaseScope`. Load Profile, Tenant, and Runtime within the same tenant; require all active/ready/healthy.

One transaction creates:

- Conversation with immutable tenant/Profile/creator service Actor binding;
- one active Session with a server-generated `hermes_session_ref`, `last_active_at=now`, and `expires_at=now+30 days`;
- `conversation.created`, AuditEvent, Outbox, and completed idempotency response.

- [ ] **Step 4: Implement Run admission**

Tenant comes only from validated `X-Core-Agent-Tenant-Id`. Conversation comes from the path and cannot be rebound. Validate `CreateAgentRunRequestSchema` and recompute the payload hash. Require Conversation/Session active, Profile active, Runtime ready/healthy, and a valid parent Run in the same Conversation when `parent_run_id` is present.

One transaction:

1. admits idempotency;
2. derives Message ID and Run ID;
3. inserts completed user Message with contract-bounded content;
4. inserts queued AgentRun with server request/trace IDs;
5. inserts `execute_agent_run` job referring only to Run ID;
6. appends `message.created` then `run.queued` to the Conversation stream;
7. appends AuditEvent/Outbox;
8. completes idempotency with the AgentRun response.

Return `202`. Duplicate identical input returns the original Run. Same key/different payload returns `409`. A cross-tenant Profile, Conversation, Session, or parent Run returns the same generic `404 RESOURCE_NOT_FOUND`.

- [ ] **Step 5: Implement Run query**

`GET /internal/v1/runs/:run_id` requires tenant authority, performs a tenant-scoped lookup, validates the returned row with `AgentRunSchema`, and never exposes worker job, provider response, internal error, or secret reference.

- [ ] **Step 6: Run and commit**

```bash
npm run check -w @core-agent/control-plane-api
npm run test:postgres -w @core-agent/runtime-core -- --test-name-pattern="Conversation|Agent Run"
git diff --check
git add apps/control-plane-api/src/routes apps/control-plane-api/tests packages/runtime-core/src/services packages/runtime-core/tests
git commit -m "feat(api): add durable conversation runs"
```

### Task 14: Stream Hermes execution into durable Run and Message events

Until this task implements atomic AgentRun and Worker-job handling, the
production Worker claim allowlist explicitly excludes `execute_agent_run`.
Repository claim tests may opt into that kind to verify storage and recovery
contracts, but Task 14 is the only milestone allowed to add it to the process
allowlist.

**Files:**
- Create: `packages/runtime-core/src/hermes/stream-parser.ts`
- Create: `packages/runtime-core/src/hermes/client.ts`
- Create: `packages/runtime-core/tests/hermes-client.test.ts`
- Create: `apps/control-plane-worker/src/handlers/execute-agent-run.ts`
- Create: `apps/control-plane-worker/tests/execute-agent-run.test.ts`
- Modify: `apps/control-plane-worker/src/dispatch-job.ts`
- Modify: `packages/runtime-core/src/index.ts`

**Interfaces:**
- Consumes: queued Run, immutable Conversation/Profile/Session, completed user Message, ready Runtime, Hermes ingress SecretStore reference, and a streaming fetch implementation.
- Produces: `HermesClient.streamChat` yielding bounded text deltas, `handleExecuteAgentRun`, assistant Message, ordered `run.started`/`message.delta`/`message.completed`/`run.completed`, and safe terminal failure.

- [ ] **Step 1: Write failing stream and unsafe-boundary tests**

```ts
test("Hermes client sends selected Profile and server Session headers", async () => {
  const deltas = await collect(client.streamChat({
    origin: "http://core-agent-runtime-example:8642",
    profileRef: "consultant_a",
    sessionRef: "hermes_session_1",
    ingressKey: "synthetic-ingress-key-00000001",
    modelId: "cywx/gpt-5.6-sol",
    timeoutMs: 90_000,
    content: "Synthetic hello",
  }));
  assert.deepEqual(deltas, ["Hello", " there"]);
  assert.equal(fakeFetch.request.url.endsWith(
    "/p/consultant_a/v1/chat/completions",
  ), true);
  assert.equal(fakeFetch.request.headers["x-hermes-session-id"], "hermes_session_1");
});

test("disconnect after first delta fails terminally without automatic replay", async () => {
  fakeHermes.script(["partial", new Error("socket closed")]);
  await dispatchRunJob();
  assert.equal((await runRepository.find("run_1"))?.status, "failed");
  assert.equal((await jobRepository.find("job_1"))?.status, "failed");
  assert.equal(fakeHermes.callCount, 1);
  assert.deepEqual(await eventTypes("conversation_1"), [
    "run.started",
    "message.delta",
    "run.failed",
  ]);
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
npm test -w @core-agent/runtime-core -- --test-name-pattern="Hermes client"
npm test -w @core-agent/control-plane-worker -- --test-name-pattern="first delta"
```

Expected: FAIL because the Hermes streaming port and handler do not exist.

- [ ] **Step 3: Implement a bounded OpenAI-compatible SSE parser**

`streamChat`:

- requires `http:` origin only for a managed private container hostname and fixed port 8642;
- percent-encodes one validated Profile ref;
- sends `Authorization` with the released-after-call ingress material as its
  Bearer credential and sends `X-Hermes-Session-Id`;
- sends only `{ model, messages: [{ role: "user", content }], stream: true }` with server-managed model;
- uses ProviderCatalog timeout and an AbortController;
- accepts `text/event-stream` only;
- caps one line at 64 KiB, total assistant content at 4,000 characters for Runtime v1, and rejects invalid UTF-8/JSON;
- yields only string `choices[0].delta.content` values and stops on `data: [DONE]`;
- never yields tool arguments, reasoning fields, headers, usage details, or provider error bodies.

The caller supplies the key through a releasable SecretMaterial and releases it in `finally`.

- [ ] **Step 4: Implement Run start and durable deltas**

Before external work, one transaction transitions `queued -> running`, sets `started_at`, appends `run.started`, and marks a worker execution record `pre_effect`. For every non-empty delta, one transaction appends `message.delta` and flips the execution record to `unsafe_to_replay` before acknowledging the chunk in process memory.

Do not create the assistant Message until completion. On `[DONE]`, one transaction:

1. inserts completed assistant Message with concatenated bounded content;
2. appends `message.completed`;
3. transitions Run `running -> succeeded` and sets `finished_at`;
4. appends `run.completed`;
5. updates Session `last_active_at`;
6. appends AuditEvent/Outbox;
7. completes the job.

- [ ] **Step 5: Implement failure classification around the unsafe boundary**

Before any delta/effect, connection refusal and timeout may reschedule
according to ProviderCatalog retry ceiling. At or after the Worker job's
`effect_state = unsafe_to_replay`, any interruption produces a bounded redacted
`run.failed`, terminal Run/job failure, and no automatic Hermes retry. An
explicit retry must enter through Task 13 and create a child Run with
`parent_run_id`.

Cancellation of the Worker process leaves the lease to expire. It does not write `run.cancelled`. A reclaimed job checks the execution record: `pre_effect` may retry safely; `unsafe_to_replay` converts to terminal failed without calling Hermes.

An expired running job already at `max_attempts` is claimed as
`recoveryOnly` without incrementing the counter. Both `pre_effect` and
`unsafe_to_replay` recovery must terminalize the Run and job atomically and
must not call Hermes; only then may Task 14 add `execute_agent_run` to the
production Worker allowlist.

- [ ] **Step 6: Run Worker and core gates, then commit**

```bash
npm run check -w @core-agent/runtime-core
npm run check -w @core-agent/control-plane-worker
node scripts/verify-no-secret.mjs synthetic-ingress-key-00000001
git diff --check
git add packages/runtime-core/src/hermes packages/runtime-core/tests/hermes-client.test.ts apps/control-plane-worker
git commit -m "feat(worker): execute durable Hermes agent runs"
```

### Task 15: Serve durable Conversation events through resumable SSE

**Files:**
- Create: `apps/control-plane-api/src/routes/events.ts`
- Create: `apps/control-plane-api/src/sse.ts`
- Create: `apps/control-plane-api/tests/events.test.ts`
- Modify: `apps/control-plane-api/src/app.ts`
- Modify: `packages/runtime-core/src/repositories/events.ts`
- Modify: `packages/runtime-core/tests/events.test.ts`

**Interfaces:**
- Consumes: tenant-scoped Conversation stream rows and numeric `Last-Event-ID` or `after_sequence`.
- Produces: `GET /internal/v1/conversations/:conversation_id/events`, `readEventsAfter`, ordered SSE frames, heartbeat comments, database-backed resume, and no coupling between connection lifetime and Run state.

- [ ] **Step 1: Write failing cursor and reconnect tests**

```ts
test("SSE resumes strictly after Last-Event-ID from persisted rows", async () => {
  await appendSyntheticEvents("conversation_1", [1, 2, 3, 4]);
  const response = await openEventStream({
    conversationId: "conversation_1",
    headers: { "last-event-id": "2" },
    closeAfterEvents: 2,
  });
  assert.deepEqual(response.events.map((event) => event.id), ["3", "4"]);
});

test("disconnect does not mutate the active Run", async () => {
  const stream = await openRawEventStream("conversation_1");
  stream.destroy();
  await nextTick();
  assert.equal((await runRepository.find("run_1"))?.status, "running");
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm test -w @core-agent/control-plane-api -- --test-name-pattern="SSE|disconnect"`

Expected: FAIL with route not found.

- [ ] **Step 3: Implement strict cursor parsing**

Accept one source:

- `Last-Event-ID` on reconnect; or
- `after_sequence` on first connection.

If both are present and unequal, return `400 INVALID_REQUEST`. Accept ASCII decimal integers from 0 through `Number.MAX_SAFE_INTEGER` with no sign, whitespace, exponent, or leading zeros except `0`. Default to 0.

- [ ] **Step 4: Implement database-authoritative SSE**

```ts
export async function readEventsAfter(
  context: TenantDatabaseContext,
  conversationId: string,
  afterSequence: number,
  limit = 100,
): Promise<readonly PersistedProductEvent[]> {
  return context.db.selectFrom("product_events")
    .selectAll()
    .where("tenant_id", "=", context.tenantId)
    .where("stream_id", "=", conversationId)
    .where("sequence", ">", afterSequence)
    .orderBy("sequence", "asc")
    .limit(Math.min(limit, 100))
    .execute();
}
```

`PersistedProductEvent` is the repository return type with the complete
validated `ProductEvent` plus typed `stream_id` and numeric `sequence`
columns. The repository validates the reconstructed value before returning it
to the route.

Write each frame exactly as:

```text
id: 42
event: message.delta
data: {"schema_version":1,"event_id":"event_42","occurred_at":"2026-08-03T12:00:00.000Z","sequence":42,"tenant_id":"tenant_1","request_id":"request_1","trace_id":"trace_1","correlation_id":"conversation_1","causation_id":"run_1","conversation_id":"conversation_1","run_id":"run_1","event_type":"message.delta","payload":{"message_id":"message_1","delta":"Synthetic"}}

```

The actual `data` line serializes the complete validated ProductEvent. Escape no data into multiple logical events; JSON serialization removes raw newlines. Set `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache, no-transform`, and `X-Accel-Buffering: no`.

Query immediately, then wait up to 15 seconds using a notifier abstraction. PostgreSQL `LISTEN/NOTIFY` may wake the loop, but every wake and timeout re-queries `product_events`. Send `: heartbeat` after an empty wait. Track only the current connection cursor in memory. Abort query/wait on disconnect and never update Run/Conversation/Session state from the disconnect handler.

- [ ] **Step 5: Verify restart recovery**

Start API A, consume through sequence 2, terminate A, start API B against the same database, reconnect with `Last-Event-ID: 2`, and assert sequences 3 onward arrive once and in order. Also assert cross-tenant Conversation ID yields generic 404 and an invalid cursor yields ErrorEnvelope before streaming headers begin.

- [ ] **Step 6: Run and commit**

```bash
npm run check -w @core-agent/control-plane-api
npm run test:postgres -w @core-agent/runtime-core -- --test-name-pattern="event"
git diff --check
git add apps/control-plane-api/src/routes/events.ts apps/control-plane-api/src/sse.ts apps/control-plane-api/tests/events.test.ts packages/runtime-core/src/repositories/events.ts packages/runtime-core/tests/events.test.ts
git commit -m "feat(api): stream durable conversation events"
```

### Task 16: Prove the complete slice with fake Supervisor and fake streaming Hermes

**Files:**
- Create: `tests/integration/fixtures/synthetic-tenant.ts`
- Create: `tests/integration/fakes/fake-supervisor.ts`
- Create: `tests/integration/fakes/fake-hermes.ts`
- Create: `tests/integration/harness.ts`
- Create: `tests/integration/provisioning.test.ts`
- Create: `tests/integration/agent-run.test.ts`
- Create: `tests/integration/recovery.test.ts`
- Create: `tests/integration/security.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: real PostgreSQL, real API/Worker code, Unix-protocol fake Supervisor, HTTP streaming fake Hermes, and anonymous synthetic data.
- Produces: deterministic vertical-slice, idempotency, restart, lease-reclaim, unsafe-boundary, tenant-isolation, and secret-leak evidence without Docker or a model credential.

- [ ] **Step 1: Write the failing full-slice scenario**

```ts
test("provision, converse, stream, restart, and resume", async () => {
  const provisioned = await harness.provisionSyntheticB2B();
  await harness.worker.untilRuntimeReady(provisioned.runtime_id);
  const conversation = await harness.createConversation({
    tenant_id: provisioned.tenant_id,
    profile_id: provisioned.profile_ids[0],
  });
  const run = await harness.createRun(conversation.conversation_id, "Synthetic hello");
  const firstConnection = await harness.readEvents(conversation.conversation_id, {
    afterSequence: 0,
    stopAfterType: "message.delta",
  });
  await harness.restartApi();
  const resumed = await harness.readEvents(conversation.conversation_id, {
    afterSequence: firstConnection.lastSequence,
    stopAfterType: "run.completed",
  });
  assert.deepEqual(
    [...firstConnection.events, ...resumed.events].map((event) => event.event_type),
    [
      "conversation.created",
      "message.created",
      "run.queued",
      "run.started",
      "message.delta",
      "message.delta",
      "message.completed",
      "run.completed",
    ],
  );
  assert.equal((await harness.getRun(run.run_id)).status, "succeeded");
});
```

- [ ] **Step 2: Run and confirm failure**

Run:

```bash
npm run test:integration -- --test-name-pattern="provision, converse"
```

Expected: FAIL because the integration harness does not exist.

- [ ] **Step 3: Build process-realistic fakes**

`fake-supervisor.ts` uses the real length-framed Unix protocol parser and policy validator, writes scripted observations, persists operation ID/hash pairs across fake restarts, and never accepts secret bytes.

`fake-hermes.ts` binds only to `127.0.0.1` on an ephemeral port, validates exact Profile route, Bearer key, Session header, and closed request body, then emits deterministic OpenAI-compatible SSE chunks:

```text
data: {"choices":[{"delta":{"content":"Synthetic "}}]}

data: {"choices":[{"delta":{"content":"response"}}]}

data: [DONE]

```

It can script connection refusal, pre-delta timeout, post-delta disconnect, invalid JSON, overlong line, and non-event-stream content type.

- [ ] **Step 4: Build the integration harness**

The harness creates one temporary PostgreSQL database per test file, applies migrations, builds API with injection dependencies, starts a real Worker loop, and swaps only the Supervisor/Hermes ports. It exposes bounded polling helpers that query resource status by ID; no fixed sleep exceeds 250 ms.

On teardown it aborts Worker, closes API/fakes/pools, drops only the generated database, and asserts no unhandled lease remains. Test database names match `^core_agent_test_[a-f0-9]{16}$`.

- [ ] **Step 5: Cover provisioning and recovery failures**

Add explicit tests for:

- duplicate provisioning request creates one tenant/runtime/job and one fake Supervisor operation;
- same idempotency key with different payload fails before Supervisor;
- Supervisor permanent rejection marks Runtime failed with redacted summary;
- Worker exit after claim permits lease reclaim;
- API restart does not affect Worker or Run;
- missed fake notification still delivers events from PostgreSQL;
- Outbox dispatcher restart delivers a wake hint without duplicating the
  committed ProductEvent;
- pre-delta Hermes disconnect retries within the configured ceiling;
- post-delta disconnect performs no second Hermes call and ends Run failed;
- a child retry creates a new Run and preserves the failed parent.

- [ ] **Step 6: Cover security failures**

Add tests for cross-tenant runtime/Conversation/Profile/Run access, forged Profile binding, invalid transition, stale resource version, unpinned image, unknown provider/model, secret-like request properties, Supervisor protocol extras, and hidden foreign-tenant existence.

Use sentinel `synthetic-leak-sentinel-4d83f17f`. After every test file, query all `text` and `jsonb` columns in application tables, capture structured logs, capture ErrorEnvelopes/events/audit/fake requests, and assert the sentinel is absent. Assertions print only the location category.

- [ ] **Step 7: Run integration and all local checks, then commit**

```bash
npm run test:integration
npm run check
npm test
node scripts/verify-no-secret.mjs synthetic-leak-sentinel-4d83f17f
git diff --check
git add tests/integration package.json package-lock.json
git commit -m "test(runtime): verify complete backend slice"
```

### Task 17: Package the development topology and enforce it in CI

**Files:**
- Create: `infra/runtime/base-images.lock.json`
- Create: `infra/runtime/Dockerfile`
- Create: `infra/runtime/compose.dev.yaml`
- Create: `infra/runtime/postgres/init/00-create-test-database.sql`
- Create: `scripts/resolve-runtime-images.mjs`
- Create: `tests/runtime/control-plane-compose.test.mjs`
- Modify: `.dockerignore`
- Modify: `.env.runtime.example`
- Modify: `.github/workflows/runtime-contract.yml`
- Modify: `package.json`

**Interfaces:**
- Consumes: digest-pinned Node/PostgreSQL/Hermes image locks and local secret files.
- Produces: `postgres`, one-shot `migrate`, `api`, `worker`, and `supervisor` services; private `core-agent-control` and `core-agent-backplane` networks; API-only loopback port; and deterministic CI gates.

- [ ] **Step 1: Write failing static topology tests**

```js
test("only API publishes a loopback port and only Supervisor mounts Docker", () => {
  const config = parseCompose(composeSource);
  assert.deepEqual(Object.keys(config.services).sort(), [
    "api", "migrate", "postgres", "supervisor", "worker",
  ]);
  assert.deepEqual(config.services.api.ports, ["127.0.0.1:8787:8787"]);
  assert.equal(config.services.postgres.ports, undefined);
  assert.equal(config.services.worker.ports, undefined);
  assert.equal(config.services.supervisor.ports, undefined);
  assert.equal(JSON.stringify(config.services.api).includes("docker.sock"), false);
  assert.equal(JSON.stringify(config.services.worker).includes("docker.sock"), false);
  assert.equal(JSON.stringify(config.services.supervisor).includes("docker.sock"), true);
});
```

Also assert API cannot mount provider secrets, Worker cannot mount provider secrets or Docker, Supervisor does not receive bootstrap key, Hermes network is external/private, service images run as non-root except the minimum Supervisor Docker group mapping, and no service embeds a secret value in `environment`.

- [ ] **Step 2: Run and confirm failure**

Run: `npm run test:runtime -- --test-name-pattern="only API publishes"`

Expected: FAIL because the control-plane Compose file does not exist.

- [ ] **Step 3: Resolve and commit immutable service-image locks**

`resolve-runtime-images.mjs` uses
`docker buildx imagetools inspect --raw` for the approved
`node:22-bookworm-slim` and `postgres:17-bookworm` tags, selects
`linux/amd64` and `linux/arm64` manifests, and writes schema version 1 with an
`images` object keyed by `node` and `postgres`. Each entry contains the source
tag and a `platforms` object containing both platform-specific immutable
references. The script refuses to write unless every reference passes
`^.+@sha256:[a-f0-9]{64}$`; therefore the committed lock contains registry
results rather than an illustrative digest.

Run:

```bash
node scripts/resolve-runtime-images.mjs
npm run test:runtime -- --test-name-pattern="runtime image lock"
```

- [ ] **Step 4: Build one multi-stage service image**

`infra/runtime/Dockerfile` uses the locked Node digest as build and runtime base, runs `npm ci`, builds contracts/core/apps, then defines `api`, `worker`, and `supervisor` targets with exact entry modules. API and Worker use an unprivileged numeric uid/gid and read-only root filesystem. Supervisor uses a dedicated numeric uid plus deployment-provided Docker socket group; it is not privileged and has no host namespace.

- [ ] **Step 5: Define the complete Compose topology**

Use these boundaries:

- `postgres` joins only `core-agent-control`, has a named data volume, healthcheck, and no host port;
- `migrate` joins control, runs once, and must succeed before API/Worker;
- `api` joins control, binds `127.0.0.1:8787`, mounts only bootstrap key and provider catalog read-only;
- `worker` joins control and backplane, mounts only ingress-secret projection and Supervisor socket volume;
- `supervisor` joins no application network, mounts the managed provider
  catalog, provider/ingress secret projections, the Supervisor socket volume,
  a persistent `supervisor-state` operation-journal volume, restricted staging
  tmpfs, and Docker socket;
- dynamically created Hermes containers join only backplane and publish no port;
- API/Worker/Supervisor use read-only roots, `cap_drop: [ALL]`, `no-new-privileges`, bounded memory/CPU/PIDs, and explicit stop grace periods.

The Compose file references only variables for non-secret paths, ports, platform, and locked image refs. It uses Docker secrets/file mounts for secret values. `.env.runtime.example` contains paths and synthetic comments, never key values.

- [ ] **Step 6: Expand CI into four deterministic gates**

Keep the existing Contracts job and add:

1. `unit`: `npm ci`, all TypeScript builds/unit tests/static security scans;
2. `postgres`: digest-pinned PostgreSQL service, migrations, concurrency/isolation tests, database sentinel scan;
3. `integration`: PostgreSQL plus fake Supervisor/Hermes full-slice tests;
4. `compose`: resolve lock consistency, `docker compose config --quiet`, and static assertions.

CI must not build/pull the large Hermes image, start real Hermes, use repository secrets, publish images, or expose Docker socket to test application containers. Pin GitHub Actions to reviewed commit SHAs or record the exact tag-to-SHA mapping in the workflow comment.

- [ ] **Step 7: Validate topology and commit**

```bash
CORE_AGENT_BOOTSTRAP_KEY_FILE=/run/secrets/bootstrap \
CORE_AGENT_PROVIDER_SECRET_ROOT=/run/secrets/provider \
CORE_AGENT_INGRESS_SECRET_ROOT=/run/secrets/ingress \
docker compose -f infra/runtime/compose.dev.yaml config --quiet
npm run test:runtime
npm run check
git diff --check
git add infra/runtime scripts/resolve-runtime-images.mjs tests/runtime/control-plane-compose.test.mjs .dockerignore .env.runtime.example .github/workflows/runtime-contract.yml package.json package-lock.json
git commit -m "build(runtime): package control plane topology"
```

### Task 18: Add the opt-in real Hermes smoke, operating guide, and acceptance evidence

**Files:**
- Create: `scripts/smoke-control-plane.mjs`
- Create: `docs/operations/runtime-v1-local-smoke.md`
- Create: `docs/operations/runtime-v1-production-boundary.md`
- Create: `docs/operations/runtime-v1-acceptance-evidence.md`
- Modify: `README.md`
- Modify: `docs/architecture/README.md`
- Modify: `package.json`
- Modify: `tests/runtime/runtime-contract.test.mjs`

**Interfaces:**
- Consumes: real Docker/Colima, digest-pinned Core-Agent Hermes image, local PostgreSQL topology, user-created `0600` bootstrap/provider/ingress secret files, and anonymous smoke data.
- Produces: `npm run smoke:control-plane` and durable evidence for every Runtime v1 acceptance criterion without printing prompt, response, credential, or raw dependency data.

- [ ] **Step 1: Write failing smoke-safety tests**

```js
test("smoke output is an allowlist of IDs, states, event types, and counts", () => {
  assert.deepEqual(SMOKE_OUTPUT_KEYS.sort(), [
    "assistant_message_count",
    "conversation_id",
    "event_types",
    "profile_id",
    "run_id",
    "run_status",
    "runtime_id",
    "runtime_state",
    "tenant_id",
  ]);
  assert.doesNotMatch(smokeSource, /console\.(?:log|error)\([^)]*(?:prompt|content|key|secret|authorization)/i);
});
```

Assert the script refuses a tenant/display name not prefixed `synthetic-`, refuses missing/non-0600 secret files, never imports real customer fixtures, and requires explicit `CORE_AGENT_REAL_HERMES_SMOKE=1`.

- [ ] **Step 2: Run and confirm failure**

Run: `npm run test:runtime -- --test-name-pattern="smoke output|REAL_HERMES"`

Expected: FAIL because the control-plane smoke script does not exist.

- [ ] **Step 3: Implement the opt-in smoke workflow**

The script:

1. validates opt-in flag, Docker availability, locked platform images, and secret file permissions;
2. starts PostgreSQL/migrate/API/Worker/Supervisor through `infra/runtime/compose.dev.yaml`;
3. sends a synthetic B2B provisioning command with one consultant Profile;
4. polls Runtime query until `ready/healthy` with a five-minute ceiling;
5. creates one Conversation and one Run with fixed prompt identifier `synthetic-runtime-v1-smoke`;
6. consumes SSE until `run.completed` or `run.failed`, retaining event types but not data content;
7. queries final Run and counts assistant Messages through a test-only database evidence query;
8. inspects the managed container and asserts no public port, correct labels/digest/network, no Docker environment value equal to any loaded secret, and no arbitrary initializer command;
9. dumps application tables to a restricted temporary file, scans for sentinel secret bytes, and deletes the file in `finally`;
10. prints only `SMOKE_OUTPUT_KEYS` as JSON.

Default cleanup sends the runtime `delete` command, waits for the managed container to disappear, preserves the tenant volume as required, and stops only the Compose project created by the script. `--keep-runtime` keeps resources for manual inspection and prints only their IDs.

- [ ] **Step 4: Write the local operating guide**

Document exact Mac/Colima and Linux commands:

```bash
chmod 0600 .local-secrets/bootstrap/key .local-secrets/provider/provider_tokenhub_main.v1 .local-secrets/ingress/hermes_ingress.v1
npm run hermes:build
docker compose -f infra/runtime/compose.dev.yaml up -d postgres migrate api worker supervisor
CORE_AGENT_REAL_HERMES_SMOKE=1 npm run smoke:control-plane
```

Explain expected states, safe log locations, how to resume SSE, how to stop the topology, why the volume remains after delete, and how to remove only the named synthetic smoke volume manually after confirming its exact label. Do not include a real key, response, customer name, or student data.

- [ ] **Step 5: Write the production boundary guide**

Record one Linux host, Supabase TLS PostgreSQL with a dedicated role, private API exposure, UDS ownership/mode, Docker socket risk, separate purpose-scoped secret projections, digest rollout, migration release step, backup/restore evidence, log redaction, and the explicit prohibition on real users before Identity/Consent/Retention/Data Governance phases.

Include rollback behavior:

- application rollback is allowed only when its expected schema version equals the deployed schema;
- additive SQL migrations are rolled forward, not automatically down-migrated;
- image rollback selects a previously accepted digest and increments Runtime generation;
- failed rollout preserves PostgreSQL truth and tenant volumes;
- Supervisor adoption validates prior labels/hash before acting.

- [ ] **Step 6: Record acceptance evidence**

Create a checked table with one row per criterion:

```markdown
| Criterion | Automated evidence | Manual evidence | Result |
| --- | --- | --- | --- |
| AC1 migrations/readiness | migration + health tests | smoke readiness | Pass |
| AC2 idempotent provisioning | integration duplicate test | Docker resource counts | Pass |
| AC3 isolated healthy runtime | Supervisor/Compose tests | Docker inspection summary | Pass |
| AC4 accepted Profile Run | API integration test | smoke Run ID/status | Pass |
| AC5 ordered durable SSE | SSE integration test | smoke event-type list | Pass |
| AC6 restart recovery | recovery integration test | API/Worker restart note | Pass |
| AC7 fail-closed boundaries | security matrix | rejected-command summary | Pass |
| AC8 no secret leakage | sentinel scans | Docker/database scan summary | Pass |
| AC9 CI quality gates | workflow job links | Compose validation | Pass |
| AC10 real Hermes response | opt-in smoke structure test | non-empty assistant count | Pass |
```

Do not mark AC10 Pass in a release commit until the real smoke has actually run on the target platform; before that execution its Result is `Pending real smoke`. Commit generated evidence only when it contains allowlisted fields.

- [ ] **Step 7: Run the full release gate**

```bash
npm ci
npm run check
npm test
npm run test:postgres
npm run test:integration
CORE_AGENT_BOOTSTRAP_KEY_FILE=/run/secrets/bootstrap \
CORE_AGENT_PROVIDER_SECRET_ROOT=/run/secrets/provider \
CORE_AGENT_INGRESS_SECRET_ROOT=/run/secrets/ingress \
docker compose -f infra/runtime/compose.dev.yaml config --quiet
git diff --check
```

Expected: every deterministic gate passes. The real Hermes smoke remains opt-in and must be recorded separately with the platform, locked digests, timestamp, resource IDs, final states, event types, and assistant message count only.

- [ ] **Step 8: Commit documentation and smoke tooling**

```bash
git add scripts/smoke-control-plane.mjs docs/operations README.md docs/architecture/README.md package.json tests/runtime/runtime-contract.test.mjs
git commit -m "docs(runtime): add runtime v1 acceptance runbook"
```

## Traceability Matrix

| Decision | Implemented by | Primary proof |
| --- | --- | --- |
| D01 single-node Docker | Tasks 9, 17, 18 | Compose boundary and real local smoke |
| D02 PostgreSQL/Supabase target | Tasks 3–5, 17 | real PostgreSQL migrations/isolation |
| D03 TypeScript/Fastify | Tasks 2, 10 | package builds and Fastify injection tests |
| D04 internal bootstrap API | Tasks 10, 11, 13, 15 | constant-time auth and loopback topology |
| D05 complete vertical slice | Tasks 11–18 | fake full-slice plus real Hermes smoke |
| D06 async Run plus SSE | Tasks 13–16 | `202` admission, durable cursor resume |
| D07 PostgreSQL jobs/Outbox | Tasks 3, 5, 12, 14 | lease/reclaim and atomicity tests |
| D08 SecretStore references | Tasks 6, 8, 9, 17 | file-boundary and sentinel scans |
| D09 Kysely plus reviewed SQL | Tasks 2–4 | SQL checksum and typed repository tests |
| D10 separate Supervisor | Tasks 7–9, 17 | unsafe-operation matrix and socket ownership |
| D11 API/Worker/Supervisor separation | Tasks 2, 10, 12, 17 | process packages and Compose mounts |
| D12 desired/observed reconciliation | Tasks 5, 9, 12, 16 | transition/adoption/retry tests |
| D13 narrow API and contract extension | Tasks 1, 11, 13, 15 | compatibility release and route schemas |
| D14 four-layer quality gate | Tasks 1–18 | unit, PostgreSQL, fake integration, real smoke |

## Required Execution Order

Execute Tasks 1 through 18 in order. The dependency chain is intentional:

1. Runtime code cannot invent an input contract before Contracts 0.2.0.
2. Repositories cannot precede reviewed SQL and typed database definitions.
3. API/Worker flows must reuse tested idempotency, leases, events, and redaction.
4. Real Docker code cannot precede the closed Supervisor protocol and fake.
5. Run execution cannot precede durable Conversation/Message admission.
6. SSE cannot be considered complete before restart recovery.
7. Compose and real smoke are release packaging, not substitutes for lower-layer tests.

## Plan Self-Review Record

### Spec coverage

- Sections 3–5: goals, topology, storage, secrets, provider catalog, and deployment are covered by Global Constraints and Tasks 2–10/17.
- Section 6: Message/Run input compatibility publication is covered by Task 1.
- Section 7: every listed health, provisioning, runtime, Conversation, Run, query, and event endpoint is covered by Tasks 10–15.
- Section 8: every listed resource, execution, event/audit, stream, and secret-reference table is covered by Tasks 3–6.
- Sections 9–11: leases, retry boundary, reconciliation, Outbox, provisioning, Run, Hermes Session, and SSE recovery are covered by Tasks 5, 9, 12–16.
- Sections 12–13: stable error mapping and all release-blocking security invariants are covered by Tasks 4–11 and 13–17.
- Sections 14–15: all four test layers and all ten acceptance criteria are covered by Tasks 1–18 and the evidence table.
- Sections 16–17: delivery order and D01–D14 traceability are preserved by Required Execution Order and the matrix above.

### Placeholder scan

Run:

```bash
rg -n 'T[B]D|T[O]DO|implement[[:space:]]+later|fill[[:space:]]+in[[:space:]]+details|appropriate[[:space:]]+error[[:space:]]+handling|Similar[[:space:]]+to[[:space:]]+Task' docs/superpowers/plans/2026-08-03-control-plane-runtime-v1.md
```

Expected: no output. Registry-derived image values are generated by the exact
resolver command in Task 17 and then validated by the lock test.

### Type and naming consistency

- `RuntimeEnvironment` is created in Task 2 and consumed by Tasks 6, 9, 10, 12, and 17.
- `RuntimeDatabase` and `TenantTransaction` are created in Tasks 3–4 and consumed by every repository/service.
- `SecretReference`/`SecretMaterial`/`SecretStore` are created in Task 6 and consumed by Supervisor and Worker without exposing bytes in protocols.
- `SupervisorRequestV1`/`SupervisorResponseV1` are created in Task 7 and used unchanged by fake, real Supervisor, Worker, and integration tests.
- `CreateAgentRunRequest` is published in Task 1 and used unchanged by Task 13.
- `hermes_session_ref` is created with Session in Task 13 and sent only as `X-Hermes-Session-Id` in Task 14.
- Conversation `stream_id` and ProductEvent `sequence` are persisted in Tasks 3/5, written in Tasks 11–14, and read by Task 15.
- Status names use contract values: Run terminal success is `succeeded` while ProductEvent type remains `run.completed`.
