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
