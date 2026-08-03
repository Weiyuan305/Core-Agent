import assert from "node:assert/strict";
import test from "node:test";
import Schema from "typebox/schema";

import {
  AgentRunSchema,
  ApprovalSchema,
  canTransitionAgentRun,
  canTransitionApproval,
  canTransitionContainerObservedState,
  canTransitionMembership,
  canTransitionProfile,
  canTransitionSession,
  canTransitionTask,
  canTransitionTenant,
  ConversationSchema,
  resolveContainerDeletion,
  RuntimeContainerSchema,
  SessionSchema,
  TaskSchema,
  validateContainerMutation,
  validateConversationMutation,
  validateConversationScopeChange,
  validateRetryRun,
  validateRuntimeGraph,
  type RuntimeGraph,
} from "../src/index.js";

const timestamp = "2026-08-03T01:02:03Z";
const resource = { schema_version: 1 as const, resource_version: 1, created_at: timestamp, updated_at: timestamp };

function assertTransitionMatrix<State extends string>(
  states: readonly State[],
  expected: Readonly<Record<State, readonly State[]>>,
  canTransition: (from: State, to: State) => boolean,
): void {
  for (const from of states) {
    for (const to of states) {
      assert.equal(
        canTransition(from, to),
        expected[from].includes(to),
        `${from} -> ${to}`,
      );
    }
  }
}

test("container transitions require lifecycle intermediates", () => {
  assert.equal(canTransitionContainerObservedState("requested", "provisioning"), true);
  assert.equal(canTransitionContainerObservedState("requested", "ready"), false);
  assert.equal(canTransitionContainerObservedState("deleted", "starting"), false);
});

test("runtime container image references are immutable digests", () => {
  const base = {
    schema_version: 1, resource_version: 1, created_at: "2026-08-03T01:02:03Z", updated_at: "2026-08-03T01:02:03Z",
    container_id: "container_demo", tenant_id: "tenant_demo", runtime_kind: "hermes",
    desired_state: "running", observed_state: "ready", generation: 1, volume_ref: "volume_demo", health_status: "healthy",
  };
  const validator = Schema.Compile(RuntimeContainerSchema);
  assert.equal(validator.Check({ ...base, image_ref: `registry.example/core-agent@sha256:${"a".repeat(64)}` }), true);
  assert.equal(validator.Check({ ...base, image_ref: "registry.example/core-agent:latest" }), false);
});

test("runtime schemas keep conversation, session, run, task, and approval distinct", () => {
  const student_ref = { student_id: "student_demo", source_system: "eduapply" };
  const case_ref = { case_id: "case_demo", student_id: "student_demo", capability_id: "university_apply" };
  const conversation = {
    ...resource,
    conversation_id: "conversation_demo",
    tenant_id: "tenant_demo",
    profile_id: "profile_demo",
    created_by_actor_id: "actor_demo",
    status: "active",
    student_ref,
    case_ref,
  };
  const session = {
    ...resource,
    session_id: "session_demo",
    tenant_id: "tenant_demo",
    profile_id: "profile_demo",
    actor_id: "actor_demo",
    conversation_id: "conversation_demo",
    status: "active",
    last_active_at: timestamp,
    expires_at: timestamp,
    hermes_session_ref: "hermes_session_demo",
  };
  const run = {
    ...resource,
    run_id: "run_demo",
    tenant_id: "tenant_demo",
    conversation_id: "conversation_demo",
    request_id: "request_demo",
    trace_id: "trace_demo",
    client_request_id: "client_request_demo",
    idempotency_key: "run_idempotency_demo",
    status: "running",
    started_at: timestamp,
  };
  const task = {
    ...resource,
    task_id: "task_demo",
    tenant_id: "tenant_demo",
    origin_run_id: "run_demo",
    idempotency_key: "task_idempotency_demo",
    capability_id: "university_apply",
    student_ref,
    case_ref,
    status: "queued",
    attempt_count: 0,
    dependency_status: "ready",
  };
  const approval = {
    ...resource,
    approval_id: "approval_demo",
    tenant_id: "tenant_demo",
    task_id: "task_demo",
    run_id: "run_demo",
    requested_action: "submit_application",
    summary: "Submit the reviewed application",
    status: "pending",
    requester_actor_id: "actor_demo",
    requested_at: timestamp,
    trusted_context_version: 1,
  };

  assert.equal(Schema.Compile(ConversationSchema).Check(conversation), true);
  assert.equal(Schema.Compile(SessionSchema).Check(session), true);
  assert.equal(Schema.Compile(AgentRunSchema).Check(run), true);
  assert.equal(Schema.Compile(TaskSchema).Check(task), true);
  assert.equal(Schema.Compile(ApprovalSchema).Check(approval), true);
  assert.equal(Schema.Compile(TaskSchema).Check({ ...task, attempt_count: -1 }), false);
  assert.equal(Schema.Compile(ApprovalSchema).Check({ ...approval, summary: "x".repeat(1001) }), false);
  assert.equal(Schema.Compile(SessionSchema).Check({ ...session, run_id: "run_demo" }), false);
});

test("runtime summaries enforce only the specified maximum length", () => {
  const container = {
    ...resource,
    container_id: "container_demo", tenant_id: "tenant_demo", runtime_kind: "hermes",
    desired_state: "running", observed_state: "failed",
    image_ref: `registry.example/core-agent@sha256:${"a".repeat(64)}`,
    generation: 1, volume_ref: "volume_demo", health_status: "unhealthy",
  };
  const run = {
    ...resource,
    run_id: "run_demo", tenant_id: "tenant_demo", conversation_id: "conversation_demo",
    request_id: "request_demo", trace_id: "trace_demo", client_request_id: "client_request_demo",
    idempotency_key: "run_idempotency_demo", status: "failed",
  };
  const task = {
    ...resource,
    task_id: "task_demo", tenant_id: "tenant_demo", origin_run_id: "run_demo",
    idempotency_key: "task_idempotency_demo", status: "succeeded",
    attempt_count: 1, dependency_status: "ready",
  };

  assert.equal(Schema.Compile(RuntimeContainerSchema).Check({ ...container, failure_summary: "" }), true);
  assert.equal(Schema.Compile(AgentRunSchema).Check({ ...run, failure_summary: "" }), true);
  assert.equal(Schema.Compile(TaskSchema).Check({ ...task, result_summary: "" }), true);
  assert.equal(Schema.Compile(RuntimeContainerSchema).Check({ ...container, failure_summary: "x".repeat(1001) }), false);
  assert.equal(Schema.Compile(AgentRunSchema).Check({ ...run, failure_summary: "x".repeat(1001) }), false);
  assert.equal(Schema.Compile(TaskSchema).Check({ ...task, result_summary: "x".repeat(1001) }), false);
});

test("clients cannot report observed state and volume deletion stays explicit", () => {
  assert.deepEqual(validateContainerMutation("client", { observed_state: "ready" }).map((item) => item.code), ["CLIENT_CANNOT_SET_OBSERVED_STATE"]);
  assert.deepEqual(resolveContainerDeletion({ desired_state: "deleted", delete_volume_requested: false }), { delete_container: true, delete_volume: false });
  assert.deepEqual(resolveContainerDeletion({ desired_state: "deleted", delete_volume_requested: true }), { delete_container: true, delete_volume: true });
});

test("terminal execution and approval states cannot be overwritten", () => {
  assert.equal(canTransitionAgentRun("succeeded", "running"), false);
  assert.equal(canTransitionTask("cancelled", "running"), false);
  assert.equal(canTransitionApproval("approved", "rejected"), false);
});

test("all resource state machines expose allowed and denied transitions", () => {
  assert.equal(canTransitionTenant("active", "suspended"), true);
  assert.equal(canTransitionMembership("revoked", "active"), false);
  assert.equal(canTransitionProfile("archived", "active"), false);
  assert.equal(canTransitionSession("expired", "active"), false);
});

test("all eight lifecycle matrices match the contract exactly", () => {
  assertTransitionMatrix(
    ["provisioning", "active", "suspended", "closing", "closed"] as const,
    {
      provisioning: ["active", "closing"], active: ["suspended", "closing"],
      suspended: ["active", "closing"], closing: ["closed"], closed: [],
    },
    canTransitionTenant,
  );
  assertTransitionMatrix(
    ["invited", "active", "suspended", "revoked"] as const,
    {
      invited: ["active", "revoked"], active: ["suspended", "revoked"],
      suspended: ["active", "revoked"], revoked: [],
    },
    canTransitionMembership,
  );
  assertTransitionMatrix(
    ["provisioning", "active", "suspended", "archived"] as const,
    {
      provisioning: ["active", "archived"], active: ["suspended", "archived"],
      suspended: ["active", "archived"], archived: [],
    },
    canTransitionProfile,
  );
  assertTransitionMatrix(
    ["active", "idle", "expired", "closed"] as const,
    {
      active: ["idle", "expired", "closed"], idle: ["active", "expired", "closed"],
      expired: [], closed: [],
    },
    canTransitionSession,
  );
  assertTransitionMatrix(
    ["queued", "running", "waiting_approval", "succeeded", "failed", "cancelled"] as const,
    {
      queued: ["running", "cancelled"], running: ["waiting_approval", "succeeded", "failed", "cancelled"],
      waiting_approval: ["running", "failed", "cancelled"], succeeded: [], failed: [], cancelled: [],
    },
    canTransitionAgentRun,
  );
  assertTransitionMatrix(
    ["queued", "running", "waiting_approval", "paused", "succeeded", "failed", "cancelled"] as const,
    {
      queued: ["running", "cancelled"], running: ["waiting_approval", "paused", "succeeded", "failed", "cancelled"],
      waiting_approval: ["running", "paused", "failed", "cancelled"], paused: ["queued", "cancelled"],
      succeeded: [], failed: [], cancelled: [],
    },
    canTransitionTask,
  );
  assertTransitionMatrix(
    ["pending", "approved", "rejected", "expired", "cancelled"] as const,
    {
      pending: ["approved", "rejected", "expired", "cancelled"],
      approved: [], rejected: [], expired: [], cancelled: [],
    },
    canTransitionApproval,
  );
  assertTransitionMatrix(
    ["requested", "provisioning", "starting", "ready", "draining", "upgrading", "recovering", "stopping", "stopped", "failed", "deleting", "deleted"] as const,
    {
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
    },
    canTransitionContainerObservedState,
  );
});

test("conversation case binding cannot be silently replaced", () => {
  assert.deepEqual(
    validateConversationScopeChange(
      { student_id: "student_demo", case_id: "case_one" },
      { student_id: "student_demo", case_id: "case_two" },
    ).map((item) => item.code),
    ["CONVERSATION_CASE_IMMUTABLE"],
  );
});

test("conversation fixed identity and frozen scope reject every mutation", () => {
  const previous = {
    ...resource,
    conversation_id: "conversation_demo",
    tenant_id: "tenant_demo",
    profile_id: "profile_demo",
    created_by_actor_id: "actor_demo",
    status: "active" as const,
    student_ref: { student_id: "student_demo", source_system: "eduapply" },
    case_ref: {
      case_id: "case_demo",
      student_id: "student_demo",
      capability_id: "university_apply",
    },
  };
  const mutations = [
    {
      code: "CONVERSATION_ID_IMMUTABLE",
      mutate: () => ({ ...previous, conversation_id: "conversation_other" }),
    },
    {
      code: "CONVERSATION_TENANT_IMMUTABLE",
      mutate: () => ({ ...previous, tenant_id: "tenant_other" }),
    },
    {
      code: "CONVERSATION_PROFILE_IMMUTABLE",
      mutate: () => ({ ...previous, profile_id: "profile_other" }),
    },
    {
      code: "CONVERSATION_CREATOR_IMMUTABLE",
      mutate: () => ({ ...previous, created_by_actor_id: "actor_other" }),
    },
    {
      code: "CONVERSATION_STUDENT_IMMUTABLE",
      mutate: () => ({
        ...previous,
        student_ref: { ...previous.student_ref, student_id: "student_other" },
      }),
    },
    {
      code: "CONVERSATION_CASE_IMMUTABLE",
      mutate: () => ({
        ...previous,
        case_ref: { ...previous.case_ref, case_id: "case_other" },
      }),
    },
  ] as const;

  for (const { code, mutate } of mutations) {
    assert.deepEqual(
      validateConversationMutation(previous, mutate()).map((item) => item.code),
      [code],
    );
  }
});

test("conversation mutation permits lifecycle and metadata changes", () => {
  const previous = {
    ...resource,
    conversation_id: "conversation_demo",
    tenant_id: "tenant_demo",
    profile_id: "profile_demo",
    created_by_actor_id: "actor_demo",
    status: "active" as const,
    student_ref: { student_id: "student_demo", source_system: "eduapply" },
    case_ref: {
      case_id: "case_demo",
      student_id: "student_demo",
      capability_id: "university_apply",
    },
  };

  assert.deepEqual(validateConversationMutation(previous, {
    ...previous,
    resource_version: 2,
    updated_at: "2026-08-03T01:03:03Z",
    status: "archived",
  }), []);
});

test("a retry must have a new run id and point to the failed run", () => {
  assert.deepEqual(
    validateRetryRun(
      { run_id: "run_failed", status: "failed" },
      { run_id: "run_retry", parent_run_id: "run_failed", status: "queued" },
    ),
    [],
  );
  assert.deepEqual(
    validateRetryRun(
      { run_id: "run_failed", status: "failed" },
      { run_id: "run_failed", parent_run_id: "run_failed", status: "running" },
    ).map((item) => item.code).sort(),
    ["RETRY_MUST_CREATE_NEW_RUN", "RETRY_MUST_START_QUEUED"],
  );
});

function createRuntimeGraph(): RuntimeGraph {
  const student_ref = { student_id: "student_demo", source_system: "eduapply" };
  const case_ref = { case_id: "case_demo", student_id: "student_demo", capability_id: "university_apply" };
  return {
    tenant_id: "tenant_demo",
    containers: [{
      ...resource,
      container_id: "container_demo", tenant_id: "tenant_demo", runtime_kind: "hermes",
      desired_state: "running", observed_state: "ready",
      image_ref: `registry.example/core-agent@sha256:${"a".repeat(64)}`,
      generation: 1, volume_ref: "volume_demo", health_status: "healthy",
    }],
    conversations: [{
      ...resource,
      conversation_id: "conversation_demo", tenant_id: "tenant_demo", profile_id: "profile_demo",
      created_by_actor_id: "actor_demo", status: "active", student_ref, case_ref,
    }],
    sessions: [{
      ...resource,
      session_id: "session_demo", tenant_id: "tenant_demo", profile_id: "profile_demo",
      actor_id: "actor_demo", conversation_id: "conversation_demo", status: "active",
      last_active_at: timestamp, expires_at: timestamp,
    }],
    runs: [{
      ...resource,
      run_id: "run_demo", tenant_id: "tenant_demo", conversation_id: "conversation_demo",
      request_id: "request_demo", trace_id: "trace_demo", client_request_id: "client_request_demo",
      idempotency_key: "run_idempotency_demo", status: "succeeded", started_at: timestamp, finished_at: timestamp,
    }],
    tasks: [{
      ...resource,
      task_id: "task_demo", tenant_id: "tenant_demo", origin_run_id: "run_demo",
      idempotency_key: "task_idempotency_demo", capability_id: "university_apply", student_ref, case_ref,
      status: "succeeded", attempt_count: 1, dependency_status: "ready",
    }],
    approvals: [{
      ...resource,
      approval_id: "approval_demo", tenant_id: "tenant_demo", task_id: "task_demo", run_id: "run_demo",
      requested_action: "submit_application", summary: "Submit reviewed application", status: "approved",
      requester_actor_id: "actor_demo", decision_actor_id: "actor_reviewer", requested_at: timestamp,
      decided_at: timestamp, trusted_context_version: 1,
    }],
  };
}

test("validates a tenant-scoped runtime graph", () => {
  assert.deepEqual(validateRuntimeGraph(createRuntimeGraph()), []);
});

test("runtime graph tenant violations identify each resource collection", () => {
  const cases: Array<{ path: string; mutate: (graph: RuntimeGraph) => void }> = [
    { path: "containers.tenant_id", mutate: (graph) => { graph.containers[0]!.tenant_id = "tenant_other"; } },
    { path: "conversations.tenant_id", mutate: (graph) => { graph.conversations[0]!.tenant_id = "tenant_other"; } },
    { path: "sessions.tenant_id", mutate: (graph) => { graph.sessions[0]!.tenant_id = "tenant_other"; } },
    { path: "runs.tenant_id", mutate: (graph) => { graph.runs[0]!.tenant_id = "tenant_other"; } },
    { path: "tasks.tenant_id", mutate: (graph) => { graph.tasks[0]!.tenant_id = "tenant_other"; } },
    { path: "approvals.tenant_id", mutate: (graph) => { graph.approvals[0]!.tenant_id = "tenant_other"; } },
  ];

  for (const item of cases) {
    const graph = createRuntimeGraph();
    item.mutate(graph);
    assert.equal(validateRuntimeGraph(graph)[0]?.path, item.path);
  }
});

test("runtime graph fails closed on tenant and link mismatches", () => {
  const graph = createRuntimeGraph();
  graph.conversations[0]!.tenant_id = "tenant_other";
  graph.sessions[0]!.profile_id = "profile_other";
  graph.runs[0]!.conversation_id = "conversation_missing";
  graph.tasks[0]!.origin_run_id = "run_missing";
  graph.approvals[0]!.run_id = "run_missing";
  graph.approvals[0]!.task_id = "task_missing";

  assert.deepEqual(
    validateRuntimeGraph(graph).map((item) => item.code),
    [
      "TENANT_SCOPE_MISMATCH",
      "SESSION_CONVERSATION_NOT_FOUND",
      "RUN_CONVERSATION_NOT_FOUND",
      "TASK_ORIGIN_RUN_NOT_FOUND",
      "APPROVAL_RUN_NOT_FOUND",
      "APPROVAL_TASK_NOT_FOUND",
    ],
  );
});

test("runtime graph rejects profile, approval pair, and case scope mismatches", () => {
  const graph = createRuntimeGraph();
  graph.sessions[0]!.profile_id = "profile_other";
  graph.approvals[0]!.run_id = "run_other";
  graph.runs.push({ ...graph.runs[0]!, run_id: "run_other" });
  graph.tasks[0]!.case_ref = { ...graph.tasks[0]!.case_ref!, student_id: "student_other" };

  assert.deepEqual(
    validateRuntimeGraph(graph).map((item) => item.code),
    ["SESSION_PROFILE_MISMATCH", "APPROVAL_RUN_TASK_MISMATCH", "CASE_STUDENT_MISMATCH"],
  );
});
