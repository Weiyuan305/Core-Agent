import { createHash } from "node:crypto";

import { BUILTIN_READ_MCP_POLICY_VERSION } from "@core-agent/contracts";

export const BUILTIN_READ_POLICY = Object.freeze({
  policy_id: "core-agent-read-mcp",
  version: BUILTIN_READ_MCP_POLICY_VERSION,
  protocol_version: 1,
  effect: "deny_unless_all_match",
  capability: Object.freeze({ kind: "mcp", risk_class: "read", approval_requirement: "none", status: "reviewed" }),
  binding_status: "reviewed",
  server_status: "reviewed",
  adapters: Object.freeze(["synthetic"]),
} as const);

const canonicalPolicy = JSON.stringify(BUILTIN_READ_POLICY);

export function canonicalPolicyHash(policy: typeof BUILTIN_READ_POLICY): string {
  if (JSON.stringify(policy) !== canonicalPolicy) throw new Error("Built-in Policy facts changed");
  return `sha256:${createHash("sha256").update("core-agent-read-mcp-policy-v1\0").update(canonicalPolicy).digest("hex")}`;
}

export const BUILTIN_READ_POLICY_HASH = canonicalPolicyHash(BUILTIN_READ_POLICY);
