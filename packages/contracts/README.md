# Control Plane Contracts

`@core-agent/contracts` is the versioned wire-contract package for the Core-Agent
Control Plane. It provides TypeScript types and runtime TypeBox schemas plus the
generated JSON Schema artifacts committed under `schemas/v1`.

## TypeScript

Install the workspace dependencies, build the package, and compile validators
from the exported schemas:

```ts
import { TenantSchema, type Tenant } from "@core-agent/contracts";
import Schema from "typebox/schema";

const validator = Schema.Compile(TenantSchema);
export function isTenant(value: unknown): value is Tenant {
  return validator.Check(value);
}
```

## JSON Schema, Python, OpenAPI, and Swift

Consumers outside TypeScript must read the generated artifact exported at
`@core-agent/contracts/schemas/v1/tenant.schema.json`. Python validators,
OpenAPI generators, and Swift generators must derive their models from that
artifact (and the corresponding files for other contract types); do not copy or
hand-write the wire fields in another language.

Each generated schema is a standalone document: compile the one schema needed
by an isolated validator registry. Do not bulk-register all 28 artifacts in one
Ajv instance, because resource identifiers may overlap across those standalone
documents. Strict Ajv consumers must also register `x-extensible-union` as an
annotation keyword before compiling:

```ts
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import tenantSchema from "@core-agent/contracts/schemas/v1/tenant.schema.json" with { type: "json" };

const ajv = new Ajv2020({ strict: true });
addFormats(ajv);
ajv.addKeyword({ keyword: "x-extensible-union", schemaType: "boolean", valid: true });
const validate = ajv.compile(tenantSchema);
```

From the repository root, regenerate and verify the committed artifacts with:

```bash
npm run contracts:schemas
npm run contracts:check
```

## Trusted Context

Validate a trusted-context payload and signed envelope against their schemas
before running semantic checks. Schema validation and
`validateTrustedRequestContext` do not perform cryptographic signature
verification and do not make client input trusted. A server consumer must also
verify the real signature, issuer, audience, validity window, and the latest
membership, profile, and delegation authority before using the context for an
authorization decision.

## Conversation mutation gate

Every conversation update must call `validateConversationMutation` with the
stored and proposed conversation identity. It freezes the complete student and
case references, including additions, removals, source metadata, and capability
scope. `validateConversationScopeChange` is deprecated because its flattened
arguments cannot enforce those invariants.

## ProductEvent producer gate

Producers must validate known events with `ProductEventSchema` and then run
`validateProductEventConsistency` before publishing. The pure consistency gate
rejects contradictory envelope and payload association IDs; consumer-side
unknown-event fallback does not relax this producer requirement.

## Idempotency, versions, and event streams

- Idempotency keys are tenant scoped. Persistence and lookup must use the pair
  `(tenant_id, idempotency_key)`; the same key in another tenant is unrelated.
- `expected_resource_version` applies only to the one resource targeted by the
  versioned write. It is not a tenant-wide or global version.
- Each `EventCursor` belongs to one Conversation/Run stream. Never combine
  events from different streams under one cursor or interpret `sequence` as a
  global order.

## MCP boundary

MCP integration is deferred. New first-party MCP services should default to
TypeScript and consume this package directly. Existing Python services should
read the generated JSON Schema artifacts. This package contains no MCP SDK,
MCP Server, or business Tool implementation.

## Compatibility changes

Every protocol change must update both `CHANGELOG.md` and
`compatibility-change.json` in the same pull request. The declaration records
the package version, wire schema version, and a `change_level` of `patch`,
`minor`, or `major`. The initial wire-schema version 1 baseline is a major
compatibility change.

The files directly under `compat/v1` are the immutable initial v1 baseline.
After regenerating schemas and passing the compatibility check, append one exact
28-file snapshot for every published package version:

```bash
npm run contracts:schemas
npm run contracts:check
npm exec -w @core-agent/contracts -- tsx scripts/check-compatibility.ts --accept-v1-release 0.3.0
```

The accept command refuses to overwrite an existing version and writes to
`compat/v1/releases/<package-version>`. Publication stages and verifies all 28
files, then takes an exclusive sibling claim for cooperating publishers and
rechecks that the target is absent immediately before the final rename. This
prevents interrupted or cooperating concurrent publishers from leaving a
partial or mixed snapshot and refuses a target created before that final check.
Portable Node does not provide a rename-without-replace primitive, so this is a
cooperative guarantee; arbitrary out-of-band mutation between the final check
and rename remains outside the contract. The requested version must exactly
match the package version in `package.json`, `CONTRACT_PACKAGE_VERSION`, and
`compatibility-change.json`. Normal compatibility checks compare the current
schemas with the initial baseline and every accepted release snapshot, in
deterministic version-directory order. The initial baseline command remains
one-time-only and refuses any occupied target:

```bash
npm exec -w @core-agent/contracts -- tsx scripts/check-compatibility.ts --accept-initial-v1
```

CI additionally protects committed compatibility history with an explicit Git
base SHA. It permits only the first exact initial baseline and new exact release
directories whose name matches the same package-version authorities;
modification, deletion, rename, and manual unrelated-version additions fail:

```bash
npm run compat:history -w @core-agent/contracts -- --base <base-sha-or-ref>
```

This history command is intentionally separate from `contracts:check`, so local
checks do not guess an unstable comparison base.

The comparator handles the documented JSON Schema 2020-12 assertion keywords
recursively and fails closed when an unclassified assertion appears or changes.
It ignores standard annotation keywords and the known
`x-extensible-union` metadata keyword. Pattern and `patternProperties` changes
are intentionally conservative: any newly applied or changed pattern is
reported as potentially breaking.

Every published or embedded `$id` must be an absolute URI. Custom absolute
schemes such as `core-agent://` are supported, but relative references such as
`child`, `../child`, and `#fragment` are rejected even when unchanged. The
offline compatibility checker has no authoritative retrieval URI from which to
resolve a relative resource identity, so treating its raw text as stable would
make compatibility dependent on an unavailable parent base.
