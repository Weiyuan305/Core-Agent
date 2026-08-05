import {
  CaseRefSchema,
  OpaqueIdSchema,
  PayloadHashSchema,
  StudentRefSchema,
} from "@core-agent/contracts";
import {
  createConversation,
  type CreateConversationRequest,
  type RuntimeDatabase,
} from "@core-agent/runtime-core";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import Type from "typebox";

// Contracts v1 intentionally has no published create-Conversation request.
// This strict bootstrap-only schema remains local to the HTTP admission route.
const CreateConversationRouteRequestSchema = Type.Object({
  schema_version: Type.Literal(1),
  idempotency_key: OpaqueIdSchema,
  payload_hash: PayloadHashSchema,
  tenant_id: OpaqueIdSchema,
  profile_id: OpaqueIdSchema,
  student_ref: Type.Optional(StudentRefSchema),
  case_ref: Type.Optional(CaseRefSchema),
}, { additionalProperties: false });

export interface ConversationRouteDependencies {
  readonly db: Kysely<RuntimeDatabase>;
}

export async function registerConversationRoutes(
  app: FastifyInstance,
  dependencies: ConversationRouteDependencies,
): Promise<void> {
  app.post<{ Body: CreateConversationRequest }>("/internal/v1/conversations", {
    config: { tenantScoped: true },
    schema: { body: CreateConversationRouteRequestSchema },
  }, async (request, reply) => {
    const context = request.apiContext;
    const conversation = await createConversation(dependencies, {
      tenantId: context.tenantId!,
      requestId: context.requestId,
      traceId: context.traceId,
      actorId: context.actorId,
      membershipId: context.membershipId,
      effectiveRole: context.effectiveRole,
    }, request.body);
    return reply.code(201).send(conversation);
  });
}
