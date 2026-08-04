import { AuditEventSchema, ProductEventSchema, type AuditEvent, type ProductEvent } from "@core-agent/contracts";
import Schema from "typebox/schema";

import { DomainError } from "./idempotency.js";

export function validateProductEvent(event: unknown, tenantId: string): asserts event is ProductEvent {
  if (
    typeof event !== "object"
    || event === null
    || (event as { tenant_id?: unknown }).tenant_id !== tenantId
    || !Schema.Check(ProductEventSchema, event)
  ) {
    throw new DomainError("INVALID_REQUEST", "ProductEvent does not satisfy its contract or tenant scope");
  }
}

export function validateAuditEvent(event: unknown, tenantId: string): asserts event is AuditEvent {
  if (
    typeof event !== "object"
    || event === null
    || (event as { tenant_id?: unknown }).tenant_id !== tenantId
    || !Schema.Check(AuditEventSchema, event)
  ) {
    throw new DomainError("INVALID_REQUEST", "AuditEvent does not satisfy its contract or tenant scope");
  }
}
