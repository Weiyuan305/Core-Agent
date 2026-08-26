import type { Kysely, Transaction } from "kysely";

import type { RuntimeDatabase } from "../../db/database.js";
import type { ReviewedMcpBinding, ReviewedServerVersion } from "../../services/policy/catalog-validation.js";
import { validateReviewedMcpBinding, validateReviewedServerVersion } from "../../services/policy/catalog-validation.js";

type Database = Kysely<RuntimeDatabase> | Transaction<RuntimeDatabase>;

function safeVersion(value: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error("Policy MCP catalog is unavailable");
  return number;
}

export async function loadReviewedToolBinding(db: Database, publicToolName: string): Promise<ReviewedMcpBinding | undefined> {
  const row = await db.selectFrom("mcp_tool_bindings")
    .innerJoin("capability_versions", "capability_versions.capability_version_id", "mcp_tool_bindings.capability_version_id")
    .innerJoin("mcp_server_versions", "mcp_server_versions.mcp_server_version_id", "mcp_tool_bindings.mcp_server_version_id")
    .select([
      "mcp_tool_bindings.mcp_tool_binding_id", "mcp_tool_bindings.capability_version_id",
      "mcp_tool_bindings.capability_id", "mcp_tool_bindings.capability_version", "mcp_tool_bindings.public_tool_name",
      "mcp_tool_bindings.downstream_tool_name", "mcp_tool_bindings.title", "mcp_tool_bindings.description",
      "mcp_tool_bindings.input_schema_json", "mcp_tool_bindings.output_contract_ref", "mcp_tool_bindings.status",
      "capability_versions.kind", "capability_versions.risk_class", "capability_versions.approval_requirement",
      "capability_versions.status as capability_status", "capability_versions.version as current_capability_version",
      "mcp_server_versions.mcp_server_version_id", "mcp_server_versions.mcp_server_id", "mcp_server_versions.version as server_version",
      "mcp_server_versions.adapter_kind", "mcp_server_versions.origin", "mcp_server_versions.protocol_version",
      "mcp_server_versions.credential_reference_id", "mcp_server_versions.connect_timeout_ms",
      "mcp_server_versions.request_timeout_ms", "mcp_server_versions.maximum_response_bytes",
      "mcp_server_versions.status as server_status",
    ])
    .where("mcp_tool_bindings.public_tool_name", "=", publicToolName)
    .where("mcp_tool_bindings.status", "=", "reviewed")
    .where("capability_versions.status", "=", "reviewed")
    .where("mcp_server_versions.status", "=", "reviewed")
    .executeTakeFirst();
  if (row === undefined) return undefined;
  const server = validateReviewedServerVersion({
    mcp_server_version_id: row.mcp_server_version_id, mcp_server_id: row.mcp_server_id, version: row.server_version,
    adapter_kind: row.adapter_kind, origin: row.origin, protocol_version: row.protocol_version,
    credential_reference_id: row.credential_reference_id, connect_timeout_ms: row.connect_timeout_ms,
    request_timeout_ms: row.request_timeout_ms, maximum_response_bytes: row.maximum_response_bytes, status: row.server_status,
  });
  return validateReviewedMcpBinding({
    mcp_tool_binding_id: row.mcp_tool_binding_id, capability_version_id: row.capability_version_id,
    capability_id: row.capability_id, capability_version: row.capability_version, public_tool_name: row.public_tool_name,
    downstream_tool_name: row.downstream_tool_name, title: row.title, description: row.description,
    input_schema_json: row.input_schema_json, output_contract_ref: row.output_contract_ref, status: row.status,
  }, {
    capability_version_id: row.capability_version_id, capability_id: row.capability_id, version: row.current_capability_version,
    kind: row.kind, risk_class: row.risk_class, approval_requirement: row.approval_requirement, status: row.capability_status,
  }, server);
}

export async function listReviewedToolBindings(
  db: Database, capabilityVersionIds: readonly string[],
): Promise<readonly ReviewedMcpBinding[]> {
  const names = await db.selectFrom("mcp_tool_bindings").select("public_tool_name")
    .where("capability_version_id", "in", capabilityVersionIds.length === 0 ? ["__none__"] : [...capabilityVersionIds])
    .where("status", "=", "reviewed").orderBy("public_tool_name", "asc").execute();
  const bindings = await Promise.all(names.map((row) => loadReviewedToolBinding(db, row.public_tool_name)));
  return Object.freeze(bindings.filter((binding): binding is ReviewedMcpBinding => binding !== undefined));
}

export interface PolicyCatalogBootstrapInput {
  readonly reviewerActorId: string;
  readonly policy: { readonly policyVersionId: string; readonly policyId: string; readonly catalogVersion: string; readonly ruleHash: string };
  readonly server: ReviewedServerVersion;
  readonly binding: ReviewedMcpBinding;
}

function exact(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Policy MCP catalog identity conflicts with reviewed facts");
}

export async function bootstrapPolicyMcpCatalog(db: Kysely<RuntimeDatabase>, input: PolicyCatalogBootstrapInput): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const actor = await trx.selectFrom("actors").select("actor_id").where("actor_id", "=", input.reviewerActorId).executeTakeFirst();
    if (actor === undefined) throw new Error("Policy MCP reviewer authority is unavailable");
    const capability = await trx.selectFrom("capability_versions").selectAll()
      .where("capability_version_id", "=", input.binding.capabilityVersionId).executeTakeFirst();
    if (capability === undefined) throw new Error("Policy MCP Capability authority is unavailable");

    await trx.insertInto("policy_versions").values({
      policy_version_id: input.policy.policyVersionId, policy_id: input.policy.policyId, version: input.policy.catalogVersion,
      rule_hash: input.policy.ruleHash, status: "reviewed", reviewed_by_actor_id: input.reviewerActorId, resource_version: 1,
    }).onConflict((conflict) => conflict.column("policy_version_id").doNothing()).execute();
    const storedPolicy = await trx.selectFrom("policy_versions").select([
      "policy_version_id", "policy_id", "version", "rule_hash", "status", "reviewed_by_actor_id", "resource_version",
    ]).where("policy_version_id", "=", input.policy.policyVersionId).executeTakeFirstOrThrow();
    exact({ ...storedPolicy, resource_version: safeVersion(storedPolicy.resource_version) }, {
      policy_version_id: input.policy.policyVersionId, policy_id: input.policy.policyId, version: input.policy.catalogVersion,
      rule_hash: input.policy.ruleHash, status: "reviewed", reviewed_by_actor_id: input.reviewerActorId, resource_version: 1,
    });

    await trx.insertInto("mcp_server_versions").values({
      mcp_server_version_id: input.server.mcpServerVersionId, mcp_server_id: input.server.mcpServerId,
      version: input.server.version, adapter_kind: input.server.adapterKind, origin: null,
      protocol_version: input.server.protocolVersion, credential_reference_id: null,
      connect_timeout_ms: input.server.connectTimeoutMs, request_timeout_ms: input.server.requestTimeoutMs,
      maximum_response_bytes: input.server.maximumResponseBytes, status: "reviewed",
      reviewed_by_actor_id: input.reviewerActorId, resource_version: 1,
    }).onConflict((conflict) => conflict.column("mcp_server_version_id").doNothing()).execute();
    const storedServer = await trx.selectFrom("mcp_server_versions").selectAll()
      .where("mcp_server_version_id", "=", input.server.mcpServerVersionId).executeTakeFirstOrThrow();
    exact({
      mcpServerVersionId: storedServer.mcp_server_version_id, mcpServerId: storedServer.mcp_server_id,
      version: storedServer.version, adapterKind: storedServer.adapter_kind, protocolVersion: storedServer.protocol_version,
      connectTimeoutMs: storedServer.connect_timeout_ms, requestTimeoutMs: storedServer.request_timeout_ms,
      maximumResponseBytes: storedServer.maximum_response_bytes, status: storedServer.status,
    }, input.server);

    await trx.insertInto("mcp_tool_bindings").values({
      mcp_tool_binding_id: input.binding.mcpToolBindingId, capability_version_id: input.binding.capabilityVersionId,
      capability_id: input.binding.capabilityId, capability_version: input.binding.capabilityVersion,
      mcp_server_version_id: input.server.mcpServerVersionId, public_tool_name: input.binding.publicToolName,
      downstream_tool_name: input.binding.downstreamToolName, title: input.binding.title, description: input.binding.description,
      input_schema_json: input.binding.inputSchema, input_schema_hash: input.binding.inputSchemaHash,
      output_contract_ref: input.binding.outputContractRef, status: "reviewed",
      reviewed_by_actor_id: input.reviewerActorId, resource_version: 1,
    }).onConflict((conflict) => conflict.column("mcp_tool_binding_id").doNothing()).execute();
    const storedBinding = await loadReviewedToolBinding(trx, input.binding.publicToolName);
    if (storedBinding === undefined) throw new Error("Policy MCP binding is unavailable");
    exact(storedBinding, input.binding);
  });
}
