import {
  AgentRunSchema,
  MessageSchema,
  validateAgentRunFailureState,
  type AgentRun,
  type Message,
} from "@core-agent/contracts";

import type { TenantRepositoryContext } from "./resources.js";
import { safeContractInteger, validateContract } from "./resources.js";

export class AgentRunRepository {
  public constructor(private readonly context: TenantRepositoryContext) {}

  public async insert(run: AgentRun): Promise<void> {
    if (run.tenant_id !== this.context.tenantId) throw new Error("Resource tenant ID does not match repository scope");
    validateContract<AgentRun>(AgentRunSchema, run);
    if (validateAgentRunFailureState(run).length > 0) throw new Error("Agent Run violates failure state invariants");
    await this.context.db.insertInto("agent_runs").values({
      tenant_id: run.tenant_id,
      run_id: run.run_id,
      conversation_id: run.conversation_id,
      request_id: run.request_id,
      trace_id: run.trace_id,
      client_request_id: run.client_request_id,
      idempotency_key: run.idempotency_key,
      parent_run_id: run.parent_run_id ?? null,
      schema_version: run.schema_version,
      resource_version: run.resource_version,
      status: run.status,
      started_at: run.started_at === undefined ? null : new Date(run.started_at),
      finished_at: run.finished_at === undefined ? null : new Date(run.finished_at),
      failure_code: run.failure_code ?? null,
      failure_summary: run.failure_summary ?? null,
      created_at: new Date(run.created_at),
      updated_at: new Date(run.updated_at),
    }).execute();
  }

  public async find(runId: string): Promise<AgentRun | undefined> {
    const row = await this.context.db.selectFrom("agent_runs")
      .select(["tenant_id", "run_id", "conversation_id", "request_id", "trace_id", "client_request_id", "idempotency_key", "parent_run_id", "schema_version", "resource_version", "status", "started_at", "finished_at", "failure_code", "failure_summary", "created_at", "updated_at"])
      .where("tenant_id", "=", this.context.tenantId)
      .where("run_id", "=", runId)
      .executeTakeFirst();
    if (row === undefined) return undefined;
    const run = validateContract<AgentRun>(AgentRunSchema, {
      tenant_id: row.tenant_id,
      run_id: row.run_id,
      conversation_id: row.conversation_id,
      request_id: row.request_id,
      trace_id: row.trace_id,
      client_request_id: row.client_request_id,
      idempotency_key: row.idempotency_key,
      ...(row.parent_run_id === null ? {} : { parent_run_id: row.parent_run_id }),
      schema_version: row.schema_version,
      resource_version: safeContractInteger(row.resource_version),
      status: row.status,
      ...(row.started_at === null ? {} : { started_at: row.started_at.toISOString() }),
      ...(row.finished_at === null ? {} : { finished_at: row.finished_at.toISOString() }),
      ...(row.failure_code === null ? {} : { failure_code: row.failure_code }),
      ...(row.failure_summary === null ? {} : { failure_summary: row.failure_summary }),
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    });
    if (validateAgentRunFailureState(run).length > 0) throw new Error("Agent Run violates failure state invariants");
    return run;
  }
}

export class MessageRepository {
  public constructor(private readonly context: TenantRepositoryContext) {}

  public async insert(message: Message): Promise<void> {
    if (message.tenant_id !== this.context.tenantId) throw new Error("Resource tenant ID does not match repository scope");
    validateContract<Message>(MessageSchema, message);
    await this.context.db.insertInto("messages").values({
      tenant_id: message.tenant_id,
      message_id: message.message_id,
      conversation_id: message.conversation_id,
      run_id: message.run_id,
      schema_version: message.schema_version,
      resource_version: message.resource_version,
      role: message.role,
      status: message.status,
      content: message.content,
      created_at: new Date(message.created_at),
      updated_at: new Date(message.updated_at),
    }).execute();
  }

  public async find(messageId: string): Promise<Message | undefined> {
    const row = await this.context.db.selectFrom("messages")
      .select(["tenant_id", "message_id", "conversation_id", "run_id", "schema_version", "resource_version", "role", "status", "content", "created_at", "updated_at"])
      .where("tenant_id", "=", this.context.tenantId)
      .where("message_id", "=", messageId)
      .executeTakeFirst();
    return row === undefined ? undefined : validateContract<Message>(MessageSchema, {
      tenant_id: row.tenant_id,
      message_id: row.message_id,
      conversation_id: row.conversation_id,
      run_id: row.run_id,
      schema_version: row.schema_version,
      resource_version: safeContractInteger(row.resource_version),
      role: row.role,
      status: row.status,
      content: row.content,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    });
  }
}
