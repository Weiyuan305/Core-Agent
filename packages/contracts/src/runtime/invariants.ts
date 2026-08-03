import type { Approval } from "../approval/schema.js";
import { type ContractViolation, violation } from "../common/validation.js";
import { validateCaseScope } from "./refs.js";
import type { AgentRun, Conversation, RuntimeContainer, Session, Task } from "./resources.js";

type ConversationIdentity = Pick<
  Conversation,
  | "conversation_id"
  | "tenant_id"
  | "profile_id"
  | "created_by_actor_id"
  | "student_ref"
  | "case_ref"
>;

function sameStudentScope(
  previous: Conversation["student_ref"],
  current: Conversation["student_ref"],
): boolean {
  if (previous === undefined || current === undefined) return previous === current;
  return previous.student_id === current.student_id
    && previous.source_system === current.source_system
    && previous.source_version === current.source_version;
}

function sameCaseScope(
  previous: Conversation["case_ref"],
  current: Conversation["case_ref"],
): boolean {
  if (previous === undefined || current === undefined) return previous === current;
  return previous.case_id === current.case_id
    && previous.student_id === current.student_id
    && previous.capability_id === current.capability_id
    && previous.source_system === current.source_system
    && previous.source_version === current.source_version;
}

export function validateConversationMutation(
  previous: ConversationIdentity,
  current: ConversationIdentity,
): ContractViolation[] {
  const violations: ContractViolation[] = [];
  if (previous.conversation_id !== current.conversation_id) {
    violations.push(violation(
      "CONVERSATION_ID_IMMUTABLE",
      "conversation_id",
      "Conversation identity cannot change after creation",
    ));
  }
  if (previous.tenant_id !== current.tenant_id) {
    violations.push(violation(
      "CONVERSATION_TENANT_IMMUTABLE",
      "tenant_id",
      "Conversation tenant cannot change after creation",
    ));
  }
  if (previous.profile_id !== current.profile_id) {
    violations.push(violation(
      "CONVERSATION_PROFILE_IMMUTABLE",
      "profile_id",
      "Conversation profile cannot change after creation",
    ));
  }
  if (previous.created_by_actor_id !== current.created_by_actor_id) {
    violations.push(violation(
      "CONVERSATION_CREATOR_IMMUTABLE",
      "created_by_actor_id",
      "Conversation creator cannot change after creation",
    ));
  }
  if (!sameStudentScope(previous.student_ref, current.student_ref)) {
    violations.push(violation(
      "CONVERSATION_STUDENT_IMMUTABLE",
      "student_ref",
      "Create a new conversation to change student scope",
    ));
  }
  if (!sameCaseScope(previous.case_ref, current.case_ref)) {
    violations.push(violation(
      "CONVERSATION_CASE_IMMUTABLE",
      "case_ref",
      "Create a new conversation to change case scope",
    ));
  }
  return violations;
}

/**
 * @deprecated This flattened compatibility helper cannot validate complete
 * student and case references. All conversation mutation paths must call
 * {@link validateConversationMutation} with the stored and proposed identity.
 */
export function validateConversationScopeChange(
  previous: { student_id?: string; case_id?: string },
  next: { student_id?: string; case_id?: string },
): ContractViolation[] {
  if (previous.case_id !== undefined && previous.case_id !== next.case_id) {
    return [violation("CONVERSATION_CASE_IMMUTABLE", "case_ref.case_id", "Create a new conversation to change case scope")];
  }
  if (previous.student_id !== undefined && previous.student_id !== next.student_id) {
    return [violation("CONVERSATION_STUDENT_IMMUTABLE", "student_ref.student_id", "Create a new conversation to change student scope")];
  }
  return [];
}

export function validateRetryRun(
  previous: { run_id: string; status: string },
  next: { run_id: string; parent_run_id?: string; status: string },
): ContractViolation[] {
  const violations: ContractViolation[] = [];
  if (previous.status !== "failed") violations.push(violation("RETRY_SOURCE_NOT_FAILED", "parent_run_id", "Only a failed run can be retried"));
  if (next.run_id === previous.run_id) violations.push(violation("RETRY_MUST_CREATE_NEW_RUN", "run_id", "Retry must create a new run"));
  if (next.parent_run_id !== previous.run_id) violations.push(violation("RETRY_PARENT_MISMATCH", "parent_run_id", "Retry must reference the failed run"));
  if (next.status !== "queued") violations.push(violation("RETRY_MUST_START_QUEUED", "status", "Retry must start in queued state"));
  return violations;
}

export function validateContainerMutation(
  source: "client" | "runtime_controller",
  patch: { desired_state?: string; observed_state?: string },
): ContractViolation[] {
  return source === "client" && patch.observed_state !== undefined
    ? [violation("CLIENT_CANNOT_SET_OBSERVED_STATE", "observed_state", "Only the runtime controller can report observed state")]
    : [];
}

export function resolveContainerDeletion(input: {
  desired_state: string;
  delete_volume_requested: boolean;
}): { delete_container: boolean; delete_volume: boolean } {
  return {
    delete_container: input.desired_state === "deleted",
    delete_volume: input.desired_state === "deleted" && input.delete_volume_requested,
  };
}

export interface RuntimeGraph {
  tenant_id: string;
  containers: RuntimeContainer[];
  conversations: Conversation[];
  sessions: Session[];
  runs: AgentRun[];
  tasks: Task[];
  approvals: Approval[];
}

export function validateRuntimeGraph(graph: RuntimeGraph): ContractViolation[] {
  const violations: ContractViolation[] = [];
  const validateTenantScope = (resources: readonly { tenant_id: string }[], path: string): void => {
    for (const resource of resources) {
      if (resource.tenant_id !== graph.tenant_id) {
        violations.push(violation("TENANT_SCOPE_MISMATCH", path, "Runtime resource is outside the selected tenant"));
      }
    }
  };

  validateTenantScope(graph.containers, "containers.tenant_id");
  validateTenantScope(graph.conversations, "conversations.tenant_id");
  validateTenantScope(graph.sessions, "sessions.tenant_id");
  validateTenantScope(graph.runs, "runs.tenant_id");
  validateTenantScope(graph.tasks, "tasks.tenant_id");
  validateTenantScope(graph.approvals, "approvals.tenant_id");

  const conversations = new Map(
    graph.conversations
      .filter((conversation) => conversation.tenant_id === graph.tenant_id)
      .map((conversation) => [conversation.conversation_id, conversation]),
  );
  const runs = new Map(
    graph.runs
      .filter((run) => run.tenant_id === graph.tenant_id)
      .map((run) => [run.run_id, run]),
  );
  const tasks = new Map(
    graph.tasks
      .filter((task) => task.tenant_id === graph.tenant_id)
      .map((task) => [task.task_id, task]),
  );

  for (const session of graph.sessions) {
    const conversation = conversations.get(session.conversation_id);
    if (conversation === undefined) {
      violations.push(violation("SESSION_CONVERSATION_NOT_FOUND", "sessions.conversation_id", "Session conversation does not exist in the selected tenant"));
    } else if (session.profile_id !== conversation.profile_id) {
      violations.push(violation("SESSION_PROFILE_MISMATCH", "sessions.profile_id", "Session and conversation profiles do not match"));
    }
  }

  for (const run of graph.runs) {
    if (!conversations.has(run.conversation_id)) {
      violations.push(violation("RUN_CONVERSATION_NOT_FOUND", "runs.conversation_id", "Run conversation does not exist in the selected tenant"));
    }
  }

  for (const task of graph.tasks) {
    if (!runs.has(task.origin_run_id)) {
      violations.push(violation("TASK_ORIGIN_RUN_NOT_FOUND", "tasks.origin_run_id", "Task origin run does not exist in the selected tenant"));
    }
  }

  for (const approval of graph.approvals) {
    const run = runs.get(approval.run_id);
    const task = tasks.get(approval.task_id);
    if (run === undefined) {
      violations.push(violation("APPROVAL_RUN_NOT_FOUND", "approvals.run_id", "Approval run does not exist in the selected tenant"));
    }
    if (task === undefined) {
      violations.push(violation("APPROVAL_TASK_NOT_FOUND", "approvals.task_id", "Approval task does not exist in the selected tenant"));
    }
    if (run !== undefined && task !== undefined && task.origin_run_id !== run.run_id) {
      violations.push(violation("APPROVAL_RUN_TASK_MISMATCH", "approvals.task_id", "Approval task does not belong to the approval run"));
    }
  }

  for (const conversation of graph.conversations) {
    violations.push(...validateCaseScope(conversation.student_ref, conversation.case_ref));
  }
  for (const task of graph.tasks) {
    violations.push(...validateCaseScope(task.student_ref, task.case_ref));
  }

  return violations;
}
