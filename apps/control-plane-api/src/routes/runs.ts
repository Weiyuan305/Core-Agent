import {
  CreateAgentRunRequestSchema,
  type CreateAgentRunRequest,
} from "@core-agent/contracts";
import {
  createAgentRun,
  getAgentRun,
  type ProviderCatalog,
  type RuntimeDatabase,
} from "@core-agent/runtime-core";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import Type, { type Static } from "typebox";

const ConversationPathSchema = Type.Object({
  conversation_id: Type.String({ minLength: 1, maxLength: 255 }),
}, { additionalProperties: false });
type ConversationPath = Static<typeof ConversationPathSchema>;

const RunPathSchema = Type.Object({
  run_id: Type.String({ minLength: 1, maxLength: 255 }),
}, { additionalProperties: false });
type RunPath = Static<typeof RunPathSchema>;

export interface RunRouteDependencies {
  readonly db: Kysely<RuntimeDatabase>;
  readonly providerCatalog: ProviderCatalog;
}

export async function registerRunRoutes(app: FastifyInstance, dependencies: RunRouteDependencies): Promise<void> {
  app.post<{ Params: ConversationPath; Body: CreateAgentRunRequest }>(
    "/internal/v1/conversations/:conversation_id/runs",
    {
      config: { tenantScoped: true },
      schema: { params: ConversationPathSchema, body: CreateAgentRunRequestSchema },
    },
    async (request, reply) => {
      const context = request.apiContext;
      const run = await createAgentRun(dependencies, {
        tenantId: context.tenantId!,
        requestId: context.requestId,
        traceId: context.traceId,
        actorId: context.actorId,
        membershipId: context.membershipId,
        effectiveRole: context.effectiveRole,
      }, request.params.conversation_id, request.body);
      return reply.code(202).send(run);
    },
  );

  app.get<{ Params: RunPath }>("/internal/v1/runs/:run_id", {
    config: { tenantScoped: true },
    schema: { params: RunPathSchema },
  }, async (request) => getAgentRun(dependencies.db, request.apiContext.tenantId!, request.params.run_id));
}
