import { createHash } from "node:crypto";

import type { ApprovalRequirement, CapabilityKind, CapabilityRiskClass, CapabilityVersionStatus } from "../../db/entitlement-tables.js";
import { validateReviewedInputSchema, type ReviewedInputSchema } from "../../policy/argument-validation.js";

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u;
const toolPattern = /^[a-z][a-z0-9_.-]{0,254}$/u;
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;
const contractPattern = /^[a-z0-9][a-z0-9._/-]{0,127}@(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
function invalid(): never { throw new Error("Policy MCP catalog is not permitted"); }
const text = (value: unknown, max = 255, pattern = idPattern): string => {
  if (typeof value !== "string" || value.length < 1 || value.length > max || !pattern.test(value)) invalid();
  return value as string;
};

export interface ReviewedServerVersion {
  readonly mcpServerVersionId: string;
  readonly mcpServerId: string;
  readonly version: string;
  readonly adapterKind: "synthetic";
  readonly protocolVersion: "2025-03-26";
  readonly connectTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly maximumResponseBytes: number;
  readonly status: "reviewed";
}

export function validateReviewedServerVersion(input: Record<string, unknown>): ReviewedServerVersion {
  const exact = ["mcp_server_version_id", "mcp_server_id", "version", "adapter_kind", "origin", "protocol_version", "credential_reference_id", "connect_timeout_ms", "request_timeout_ms", "maximum_response_bytes", "status"];
  if (Reflect.ownKeys(input).some((key) => typeof key !== "string" || !exact.includes(key)) || exact.some((key) => !Object.hasOwn(input, key))) invalid();
  if (input.adapter_kind !== "synthetic" || input.origin !== null || input.credential_reference_id !== null || input.protocol_version !== "2025-03-26" || input.status !== "reviewed") invalid();
  const connect = input.connect_timeout_ms; const request = input.request_timeout_ms; const maximum = input.maximum_response_bytes;
  if (!Number.isSafeInteger(connect) || (connect as number) < 100 || (connect as number) > 30_000
    || !Number.isSafeInteger(request) || (request as number) < 100 || (request as number) > 30_000
    || !Number.isSafeInteger(maximum) || (maximum as number) < 1 || (maximum as number) > 262_144) invalid();
  const version = text(input.version, 128, semverPattern);
  return Object.freeze({
    mcpServerVersionId: text(input.mcp_server_version_id), mcpServerId: text(input.mcp_server_id), version,
    adapterKind: "synthetic", protocolVersion: "2025-03-26", connectTimeoutMs: connect as number,
    requestTimeoutMs: request as number, maximumResponseBytes: maximum as number, status: "reviewed",
  });
}

export interface CapabilityBindingFacts {
  readonly capability_version_id: string; readonly capability_id: string; readonly version: string;
  readonly kind: CapabilityKind; readonly risk_class: CapabilityRiskClass;
  readonly approval_requirement: ApprovalRequirement; readonly status: CapabilityVersionStatus;
}

export interface ReviewedMcpBinding {
  readonly mcpToolBindingId: string; readonly capabilityVersionId: string; readonly capabilityId: string;
  readonly capabilityVersion: string; readonly publicToolName: string; readonly downstreamToolName: string;
  readonly title: string; readonly description: string; readonly inputSchema: ReviewedInputSchema;
  readonly inputSchemaHash: string; readonly outputContractRef: string; readonly status: "reviewed";
  readonly server: ReviewedServerVersion;
}

export function validateReviewedMcpBinding(
  input: Record<string, unknown>, capability: CapabilityBindingFacts, server: ReviewedServerVersion,
): ReviewedMcpBinding {
  const exact = ["mcp_tool_binding_id", "capability_version_id", "capability_id", "capability_version", "public_tool_name", "downstream_tool_name", "title", "description", "input_schema_json", "output_contract_ref", "status"];
  if (Reflect.ownKeys(input).some((key) => typeof key !== "string" || !exact.includes(key)) || exact.some((key) => !Object.hasOwn(input, key))) invalid();
  if (input.status !== "reviewed" || capability.status !== "reviewed" || capability.kind !== "mcp"
    || capability.risk_class !== "read" || capability.approval_requirement !== "none"
    || input.capability_version_id !== capability.capability_version_id
    || input.capability_id !== capability.capability_id || input.capability_version !== capability.version) invalid();
  const inputSchema = validateReviewedInputSchema(input.input_schema_json);
  const canonical = JSON.stringify(inputSchema);
  return Object.freeze({
    mcpToolBindingId: text(input.mcp_tool_binding_id), capabilityVersionId: text(input.capability_version_id),
    capabilityId: text(input.capability_id), capabilityVersion: text(input.capability_version, 128, semverPattern),
    publicToolName: text(input.public_tool_name, 255, toolPattern), downstreamToolName: text(input.downstream_tool_name, 255, toolPattern),
    title: text(input.title, 200, /^.{1,200}$/u), description: text(input.description, 1000, /^[\s\S]{1,1000}$/u),
    inputSchema, inputSchemaHash: `sha256:${createHash("sha256").update("core-agent-mcp-input-schema-v1\0").update(canonical).digest("hex")}`,
    outputContractRef: text(input.output_contract_ref, 256, contractPattern), status: "reviewed", server,
  });
}
