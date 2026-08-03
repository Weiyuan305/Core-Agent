import type { Static } from "typebox";

import { ApprovalStatusSchema } from "../approval/schema.js";
import { ProfileStatusSchema } from "../profile/profile.js";
import { MembershipStatusSchema, TenantStatusSchema } from "../tenant/identity.js";
import {
  AgentRunStatusSchema,
  ContainerObservedStateSchema,
  SessionStatusSchema,
  TaskStatusSchema,
} from "./resources.js";

type TransitionTable<State extends string> = Readonly<Record<State, readonly State[]>>;

function allows<State extends string>(table: TransitionTable<State>, from: State, to: State): boolean {
  return table[from].includes(to);
}

type TenantStatus = Static<typeof TenantStatusSchema>;
type MembershipStatus = Static<typeof MembershipStatusSchema>;
type ProfileStatus = Static<typeof ProfileStatusSchema>;
type SessionStatus = Static<typeof SessionStatusSchema>;
type AgentRunStatus = Static<typeof AgentRunStatusSchema>;
type TaskStatus = Static<typeof TaskStatusSchema>;
type ApprovalStatus = Static<typeof ApprovalStatusSchema>;
type ContainerObservedState = Static<typeof ContainerObservedStateSchema>;

const tenantTransitions = {
  provisioning: ["active", "closing"], active: ["suspended", "closing"],
  suspended: ["active", "closing"], closing: ["closed"], closed: [],
} as const satisfies TransitionTable<TenantStatus>;

const membershipTransitions = {
  invited: ["active", "revoked"], active: ["suspended", "revoked"],
  suspended: ["active", "revoked"], revoked: [],
} as const satisfies TransitionTable<MembershipStatus>;

const profileTransitions = {
  provisioning: ["active", "archived"], active: ["suspended", "archived"],
  suspended: ["active", "archived"], archived: [],
} as const satisfies TransitionTable<ProfileStatus>;

const sessionTransitions = {
  active: ["idle", "expired", "closed"], idle: ["active", "expired", "closed"],
  expired: [], closed: [],
} as const satisfies TransitionTable<SessionStatus>;

const runTransitions = {
  queued: ["running", "cancelled"], running: ["waiting_approval", "succeeded", "failed", "cancelled"],
  waiting_approval: ["running", "failed", "cancelled"], succeeded: [], failed: [], cancelled: [],
} as const satisfies TransitionTable<AgentRunStatus>;

const taskTransitions = {
  queued: ["running", "cancelled"], running: ["waiting_approval", "paused", "succeeded", "failed", "cancelled"],
  waiting_approval: ["running", "paused", "failed", "cancelled"], paused: ["queued", "cancelled"],
  succeeded: [], failed: [], cancelled: [],
} as const satisfies TransitionTable<TaskStatus>;

const approvalTransitions = {
  pending: ["approved", "rejected", "expired", "cancelled"],
  approved: [], rejected: [], expired: [], cancelled: [],
} as const satisfies TransitionTable<ApprovalStatus>;

const containerTransitions = {
  requested: ["provisioning", "failed", "deleting"],
  provisioning: ["starting", "failed", "deleting"],
  starting: ["ready", "failed", "stopping", "deleting"],
  ready: ["draining", "upgrading", "recovering", "stopping", "failed", "deleting"],
  draining: ["ready", "upgrading", "stopping", "failed", "deleting"],
  upgrading: ["starting", "ready", "recovering", "failed", "deleting"],
  recovering: ["starting", "ready", "failed", "deleting"],
  stopping: ["stopped", "failed", "deleting"],
  stopped: ["starting", "failed", "deleting"],
  failed: ["recovering", "stopping", "deleting"],
  deleting: ["deleted", "failed"],
  deleted: [],
} as const satisfies TransitionTable<ContainerObservedState>;

export function canTransitionTenant(from: TenantStatus, to: TenantStatus): boolean {
  return allows(tenantTransitions, from, to);
}

export function canTransitionMembership(from: MembershipStatus, to: MembershipStatus): boolean {
  return allows(membershipTransitions, from, to);
}

export function canTransitionProfile(from: ProfileStatus, to: ProfileStatus): boolean {
  return allows(profileTransitions, from, to);
}

export function canTransitionSession(from: SessionStatus, to: SessionStatus): boolean {
  return allows(sessionTransitions, from, to);
}

export function canTransitionAgentRun(from: AgentRunStatus, to: AgentRunStatus): boolean {
  return allows(runTransitions, from, to);
}

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return allows(taskTransitions, from, to);
}

export function canTransitionApproval(from: ApprovalStatus, to: ApprovalStatus): boolean {
  return allows(approvalTransitions, from, to);
}

export function canTransitionContainerObservedState(
  from: ContainerObservedState,
  to: ContainerObservedState,
): boolean {
  return allows(containerTransitions, from, to);
}
