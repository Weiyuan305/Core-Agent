import type { Kysely } from "kysely";

import type { RuntimeDatabase } from "../../db/database.js";
import { BUILTIN_READ_POLICY, BUILTIN_READ_POLICY_HASH } from "../../policy/builtin-read-policy.js";
import { bootstrapPolicyMcpCatalog } from "../../repositories/policy/catalog.js";
import { validateReviewedMcpBinding, validateReviewedServerVersion } from "./catalog-validation.js";

export interface SyntheticBindingDocument {
  readonly policy: { readonly policy_version_id: string; readonly policy_id: string; readonly catalog_version: string };
  readonly server: Record<string, unknown>;
  readonly capability: Parameters<typeof validateReviewedMcpBinding>[1];
  readonly binding: Record<string, unknown>;
}

export async function bootstrapBuiltinPolicy(
  db: Kysely<RuntimeDatabase>, reviewerActorId: string, document: SyntheticBindingDocument,
): Promise<void> {
  if (document.policy.policy_version_id !== BUILTIN_READ_POLICY.version || document.policy.policy_id !== BUILTIN_READ_POLICY.policy_id) {
    throw new Error("Built-in Policy identity is invalid");
  }
  const server = validateReviewedServerVersion(document.server);
  const binding = validateReviewedMcpBinding(document.binding, document.capability, server);
  await bootstrapPolicyMcpCatalog(db, {
    reviewerActorId,
    policy: {
      policyVersionId: document.policy.policy_version_id, policyId: document.policy.policy_id,
      catalogVersion: document.policy.catalog_version, ruleHash: BUILTIN_READ_POLICY_HASH,
    },
    server, binding,
  });
}
