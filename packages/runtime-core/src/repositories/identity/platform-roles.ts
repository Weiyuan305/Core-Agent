import { createHash } from "node:crypto";

export function platformMembershipId(actorId: string, tenantId: string): string {
  return `membership_platform_${createHash("sha256")
    .update(`${actorId}:${tenantId}`, "utf8")
    .digest("hex")
    .slice(0, 32)}`;
}

export function platformRoleAssignmentId(actorId: string): string {
  return `platform_role_assignment_${createHash("sha256")
    .update(actorId, "utf8")
    .digest("hex")
    .slice(0, 32)}`;
}
