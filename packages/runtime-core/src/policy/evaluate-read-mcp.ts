import type { PolicyDecisionReason } from "@core-agent/contracts";

import { argumentsMatchReviewedSchema, type ReviewedInputSchema } from "./argument-validation.js";

type Decision = Readonly<{ decision: "allow"; reason: "POLICY_ALLOWED" } | { decision: "deny"; reason: Exclude<PolicyDecisionReason, "POLICY_ALLOWED"> }>;

export interface ReadMcpEvaluationInput {
  readonly session: { readonly active: boolean; readonly snapshotMatches: boolean };
  readonly authority: { readonly current: boolean; readonly capabilityVersionIds: readonly string[] };
  readonly capability: null | { readonly capabilityVersionId: string; readonly kind: string; readonly riskClass: string; readonly approvalRequirement: string; readonly status: string };
  readonly binding: null | { readonly present: boolean; readonly capabilityVersionId: string; readonly status: string; readonly inputSchema: ReviewedInputSchema };
  readonly arguments: unknown;
}

const deny = (reason: Exclude<PolicyDecisionReason, "POLICY_ALLOWED">): Decision => Object.freeze({ decision: "deny", reason });

export function evaluateReadMcp(input: ReadMcpEvaluationInput): Decision {
  if (!input.session.active) return deny("SESSION_NOT_ACTIVE");
  if (!input.session.snapshotMatches || !input.authority.current) return deny("CURRENT_AUTHORITY_CHANGED");
  if (input.capability === null || !input.authority.capabilityVersionIds.includes(input.capability.capabilityVersionId)) return deny("CAPABILITY_NOT_EFFECTIVE");
  if (input.capability.kind !== "mcp" || input.capability.riskClass !== "read" || input.capability.approvalRequirement !== "none" || input.capability.status !== "reviewed") return deny("POLICY_NOT_PERMITTED");
  if (input.binding === null || !input.binding.present || input.binding.status !== "reviewed" || input.binding.capabilityVersionId !== input.capability.capabilityVersionId) return deny("TOOL_NOT_BOUND");
  if (!argumentsMatchReviewedSchema(input.arguments, input.binding.inputSchema)) return deny("ARGUMENTS_INVALID");
  return Object.freeze({ decision: "allow", reason: "POLICY_ALLOWED" });
}
