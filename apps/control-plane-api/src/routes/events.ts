import type { ProductEvent } from "@core-agent/contracts";
import {
  DomainError,
  ResourceRepositories,
  readEventsAfter,
  type PersistedProductEvent,
  type RuntimeDatabase,
} from "@core-agent/runtime-core";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import Type, { type Static } from "typebox";

import {
  formatSseEvent,
  parseEventCursor,
  writeSseChunk,
  type EventNotifier,
} from "../sse.js";

const ConversationEventsPathSchema = Type.Object({
  conversation_id: Type.String({ minLength: 1, maxLength: 255 }),
}, { additionalProperties: false });
type ConversationEventsPath = Static<typeof ConversationEventsPathSchema>;

interface ConversationEventsQuery {
  readonly after_sequence?: unknown;
}

export interface EventRouteDependencies {
  readonly db: Kysely<RuntimeDatabase>;
  readonly eventNotifier: EventNotifier;
}

function asProductEvent(persisted: PersistedProductEvent): ProductEvent {
  const { stream_id: _streamId, ...event } = persisted;
  return event;
}

export async function registerEventRoutes(
  app: FastifyInstance,
  dependencies: EventRouteDependencies,
): Promise<void> {
  app.get<{ Params: ConversationEventsPath; Querystring: ConversationEventsQuery }>(
    "/internal/v1/conversations/:conversation_id/events",
    {
      config: { tenantScoped: true, authentication: "trusted_context" },
      schema: { params: ConversationEventsPathSchema },
    },
    async (request, reply) => {
      const context = request.apiContext;
      const tenantId = context.tenantId!;
      const conversationId = request.params.conversation_id;
      if (!("authenticationKind" in context) || context.conversationId !== conversationId) {
        throw new DomainError("UNAUTHENTICATED", "Trusted context binding is invalid");
      }
      const conversation = await new ResourceRepositories(dependencies.db)
        .forTenant(tenantId).conversations.find(conversationId);
      if (conversation === undefined) {
        throw new DomainError("RESOURCE_NOT_FOUND", "Conversation was not found");
      }
      const cursor = parseEventCursor({
        lastEventId: request.headers["last-event-id"],
        rawHeaders: request.raw.rawHeaders,
        afterSequence: request.query.after_sequence,
      });
      const streamId = `conversation_${conversationId}`;
      const abortController = new AbortController();
      const abort = (): void => abortController.abort();
      const expiryTimer = setTimeout(abort, context.remainingLifetimeMs);
      expiryTimer.unref();
      request.raw.once("aborted", abort);
      reply.raw.once("close", abort);

      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      });
      reply.raw.flushHeaders();

      let currentCursor = cursor;
      let heartbeatAfterEmptyWait = false;
      try {
        while (!abortController.signal.aborted) {
          const events = await readEventsAfter(
            { tenantId, db: dependencies.db },
            streamId,
            currentCursor,
            100,
            abortController.signal,
          );
          if (events.length > 0) {
            for (const persisted of events) {
              const event = asProductEvent(persisted);
              if (!await writeSseChunk(reply.raw, formatSseEvent(event), abortController.signal)) return;
              currentCursor = persisted.sequence;
            }
            heartbeatAfterEmptyWait = false;
            if (events.length === 100) continue;
          } else if (heartbeatAfterEmptyWait) {
            if (!await writeSseChunk(reply.raw, ": heartbeat\n\n", abortController.signal)) return;
            heartbeatAfterEmptyWait = false;
          }
          await dependencies.eventNotifier.wait({ tenantId, streamId, signal: abortController.signal });
          if (abortController.signal.aborted) break;
          heartbeatAfterEmptyWait = true;
        }
      } catch (error) {
        if (!abortController.signal.aborted) {
          request.log.error({ error }, "Conversation event stream failed");
          reply.raw.destroy(error instanceof Error ? error : undefined);
        }
      } finally {
        clearTimeout(expiryTimer);
        request.raw.removeListener("aborted", abort);
        reply.raw.removeListener("close", abort);
        if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
      }
    },
  );
}
