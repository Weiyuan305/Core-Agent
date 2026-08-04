import { ConversationSchema, SessionSchema, type Conversation, type Session } from "@core-agent/contracts";

import type { TenantRepositoryContext } from "./resources.js";
import { safeContractInteger, validateContract } from "./resources.js";

export class ConversationRepository {
  public constructor(private readonly context: TenantRepositoryContext) {}

  public async insert(conversation: Conversation): Promise<void> {
    if (conversation.tenant_id !== this.context.tenantId) throw new Error("Resource tenant ID does not match repository scope");
    validateContract<Conversation>(ConversationSchema, conversation);
    await this.context.db.insertInto("conversations").values({
      tenant_id: conversation.tenant_id,
      conversation_id: conversation.conversation_id,
      profile_id: conversation.profile_id,
      created_by_actor_id: conversation.created_by_actor_id,
      status: conversation.status,
      schema_version: conversation.schema_version,
      resource_version: conversation.resource_version,
      student_ref: conversation.student_ref ?? null,
      case_ref: conversation.case_ref ?? null,
      created_at: new Date(conversation.created_at),
      updated_at: new Date(conversation.updated_at),
    }).execute();
  }

  public async find(conversationId: string): Promise<Conversation | undefined> {
    const row = await this.context.db.selectFrom("conversations")
      .select(["tenant_id", "conversation_id", "profile_id", "created_by_actor_id", "status", "schema_version", "resource_version", "student_ref", "case_ref", "created_at", "updated_at"])
      .where("tenant_id", "=", this.context.tenantId)
      .where("conversation_id", "=", conversationId)
      .executeTakeFirst();
    return row === undefined ? undefined : validateContract<Conversation>(ConversationSchema, {
      tenant_id: row.tenant_id,
      conversation_id: row.conversation_id,
      profile_id: row.profile_id,
      created_by_actor_id: row.created_by_actor_id,
      status: row.status,
      schema_version: row.schema_version,
      resource_version: safeContractInteger(row.resource_version),
      ...(row.student_ref === null ? {} : { student_ref: row.student_ref }),
      ...(row.case_ref === null ? {} : { case_ref: row.case_ref }),
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    });
  }
}

export class SessionRepository {
  public constructor(private readonly context: TenantRepositoryContext) {}

  public async insert(session: Session): Promise<void> {
    if (session.tenant_id !== this.context.tenantId) throw new Error("Resource tenant ID does not match repository scope");
    validateContract<Session>(SessionSchema, session);
    await this.context.db.insertInto("sessions").values({
      tenant_id: session.tenant_id,
      session_id: session.session_id,
      profile_id: session.profile_id,
      actor_id: session.actor_id,
      conversation_id: session.conversation_id,
      schema_version: session.schema_version,
      resource_version: session.resource_version,
      status: session.status,
      last_active_at: new Date(session.last_active_at),
      expires_at: new Date(session.expires_at),
      hermes_session_ref: session.hermes_session_ref ?? null,
      created_at: new Date(session.created_at),
      updated_at: new Date(session.updated_at),
    }).execute();
  }

  public async find(sessionId: string): Promise<Session | undefined> {
    const row = await this.context.db.selectFrom("sessions")
      .select(["tenant_id", "session_id", "profile_id", "actor_id", "conversation_id", "schema_version", "resource_version", "status", "last_active_at", "expires_at", "hermes_session_ref", "created_at", "updated_at"])
      .where("tenant_id", "=", this.context.tenantId)
      .where("session_id", "=", sessionId)
      .executeTakeFirst();
    return row === undefined ? undefined : validateContract<Session>(SessionSchema, {
      tenant_id: row.tenant_id,
      session_id: row.session_id,
      profile_id: row.profile_id,
      actor_id: row.actor_id,
      conversation_id: row.conversation_id,
      schema_version: row.schema_version,
      resource_version: safeContractInteger(row.resource_version),
      status: row.status,
      last_active_at: row.last_active_at.toISOString(),
      expires_at: row.expires_at.toISOString(),
      ...(row.hermes_session_ref === null ? {} : { hermes_session_ref: row.hermes_session_ref }),
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    });
  }
}
