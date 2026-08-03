import { type ContractViolation, violation } from "../common/validation.js";
import { type ProductEventEnvelope } from "../events/product-event.js";

export interface EventCursor {
  last_sequence: number;
  seen_event_ids: string[];
}

export function consumeEventBatch(
  cursor: EventCursor,
  events: ProductEventEnvelope[],
): {
  accepted: ProductEventEnvelope[];
  cursor: EventCursor;
  violations: ContractViolation[];
} {
  const seen = new Set(cursor.seen_event_ids);
  const accepted: ProductEventEnvelope[] = [];
  const violations: ContractViolation[] = [];
  let lastSequence = cursor.last_sequence;

  for (const event of events) {
    if (seen.has(event.event_id)) continue;
    if (event.sequence <= lastSequence) {
      violations.push(violation(
        "EVENT_SEQUENCE_OUT_OF_ORDER",
        "sequence",
        "Event sequence moved backwards within one stream",
      ));
      seen.add(event.event_id);
      continue;
    }
    seen.add(event.event_id);
    accepted.push(event);
    lastSequence = event.sequence;
  }

  return {
    accepted,
    cursor: { last_sequence: lastSequence, seen_event_ids: [...seen] },
    violations,
  };
}

export interface AuthoritySnapshot {
  membership_status: "active" | "suspended" | "revoked";
  entitlement_version: number;
  consent_version?: number;
  case_scope_valid: boolean;
}

export function validateApprovalResume(
  approved: AuthoritySnapshot,
  current: AuthoritySnapshot,
): ContractViolation[] {
  const violations: ContractViolation[] = [];
  if (current.membership_status !== "active") {
    violations.push(violation(
      "MEMBERSHIP_NOT_ACTIVE",
      "membership_status",
      "Membership must be active before execution",
    ));
  }
  if (!current.case_scope_valid) {
    violations.push(violation(
      "CASE_SCOPE_INVALID",
      "case_scope_valid",
      "Case scope must be revalidated before execution",
    ));
  }
  if (
    approved.entitlement_version !== current.entitlement_version
    || approved.consent_version !== current.consent_version
  ) {
    violations.push(violation(
      "AUTHORITY_CHANGED_AFTER_APPROVAL",
      "authority_snapshot",
      "Authority changed after approval and requires a new decision",
    ));
  }
  return violations;
}
