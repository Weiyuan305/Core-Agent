import { sql, type Kysely } from "kysely";

import type { RuntimeDatabase } from "../db/database.js";
import { assertTenantId } from "../db/transaction.js";

const opaqueIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;
const namespace = "agent-session:v1";

export interface AgentRunConversationLockInput {
  readonly tenantId: string;
  readonly runId: string;
  readonly signal?: AbortSignal;
}

export function agentRunConversationLockKey(tenantId: string, conversationId: string): string {
  assertTenantId(tenantId);
  if (!opaqueIdPattern.test(conversationId)) throw new Error("Invalid Conversation ID");
  return `${namespace}:${tenantId}:${conversationId}`;
}

async function resolveConversationId(
  db: Kysely<RuntimeDatabase>,
  input: AgentRunConversationLockInput,
): Promise<string> {
  assertTenantId(input.tenantId);
  if (!opaqueIdPattern.test(input.runId)) throw new Error("Invalid Agent Run ID");
  const row = await db.selectFrom("agent_runs").select("conversation_id")
    .where("tenant_id", "=", input.tenantId).where("run_id", "=", input.runId).executeTakeFirst();
  if (row === undefined) throw new Error("Stored Agent Run lock identity is unavailable");
  return row.conversation_id;
}

export async function withAgentRunConversationLock<T>(
  db: Kysely<RuntimeDatabase>,
  input: AgentRunConversationLockInput,
  work: (conversationId: string) => Promise<T>,
): Promise<T> {
  const conversationId = await resolveConversationId(db, input);
  const key = agentRunConversationLockKey(input.tenantId, conversationId);
  while (true) {
    if (input.signal?.aborted) throw new Error("Agent Run Conversation lock wait aborted");
    const attempt: { readonly acquired: false } | { readonly acquired: true; readonly value: T } = await db.connection().execute(async (connection) => {
      const result = await sql<{ acquired: boolean }>`select pg_try_advisory_lock(hashtextextended(${key}, 0)) as acquired`.execute(connection);
      if (result.rows[0]?.acquired !== true) return { acquired: false as const };
      try {
        const currentConversationId = await resolveConversationId(connection, input);
        if (currentConversationId !== conversationId) throw new Error("Stored Agent Run lock identity changed");
        return { acquired: true as const, value: await work(conversationId) };
      } finally {
        await sql`select pg_advisory_unlock(hashtextextended(${key}, 0))`.execute(connection);
      }
    });
    if (attempt.acquired) return attempt.value;
    await waitForLock(input.signal);
  }
}

async function waitForLock(signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) throw new Error("Agent Run Conversation lock wait aborted");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); resolve(); }, 25);
    const abort = () => { clearTimeout(timer); cleanup(); reject(new Error("Agent Run Conversation lock wait aborted")); };
    const cleanup = () => signal?.removeEventListener("abort", abort);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
