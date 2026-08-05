import { createHash } from "node:crypto";

import type { RuntimeContainer } from "@core-agent/contracts";
import Type, { type Static } from "typebox";
import Schema from "typebox/schema";
import { sql, type Kysely, type Transaction } from "kysely";

import type { RuntimeDatabase } from "../db/database.js";
import { assertTenantId, type TenantTransaction } from "../db/transaction.js";
import {
  beginIdempotentCommand,
  canonicalPayloadHash,
  completeIdempotentCommand,
  DomainError,
} from "../domain/idempotency.js";
import { appendAuditEvent, appendProductEvents } from "../repositories/events.js";
import { ResourceRepositories } from "../repositories/index.js";
import { safeContractInteger } from "../repositories/resources.js";
import { acquireRuntimeTransactionAdvisoryLock } from "../repositories/runtime-lock.js";
import { deriveRuntimeContainerId, type ProvisioningContext } from "./provision-tenant.js";

const idSchema = Type.String({ minLength: 1, maxLength: 255 });

export const RuntimeCommandRequestSchema = Type.Object({
  schema_version: Type.Literal(1),
  idempotency_key: idSchema,
  payload_hash: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }),
  expected_resource_version: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER - 1 }),
  command: Type.Union([
    Type.Literal("start"), Type.Literal("stop"), Type.Literal("restart"), Type.Literal("delete"),
  ]),
}, { additionalProperties: false });

export type RuntimeCommandRequest = Static<typeof RuntimeCommandRequestSchema>;

export interface CommandRuntimeDependencies {
  readonly db: Kysely<RuntimeDatabase>;
  readonly now?: () => Date;
}

export interface CommandRuntimeResponse {
  readonly schema_version: 1;
  readonly status: "accepted";
  readonly runtime: {
    readonly container_id: string;
    readonly resource_version: number;
    readonly desired_state: RuntimeContainer["desired_state"];
  };
}

const requestValidator = Schema.Compile(RuntimeCommandRequestSchema);

function invalid(message: string): never {
  throw new DomainError("INVALID_REQUEST", message);
}

function payloadWithoutHash(request: RuntimeCommandRequest): Omit<RuntimeCommandRequest, "payload_hash"> {
  const { payload_hash: _payloadHash, ...payload } = request;
  return payload;
}

function desiredState(command: RuntimeCommandRequest["command"]): RuntimeContainer["desired_state"] {
  switch (command) {
    case "start":
    case "restart": return "running";
    case "stop": return "stopped";
    case "delete": return "deleted";
  }
}

function deriveId(prefix: string, tenantId: string, idempotencyKey: string): string {
  const digest = createHash("sha256").update(`${tenantId}:${idempotencyKey}`, "utf8").digest("hex").slice(0, 32);
  return `${prefix}_${digest}`;
}

function notFound(): never {
  throw new DomainError("RESOURCE_NOT_FOUND", "Runtime was not found");
}

function assertResponse(
  value: unknown,
  expectedContainerId: string,
  expectedDesiredState: RuntimeContainer["desired_state"],
): asserts value is CommandRuntimeResponse {
  if (
    typeof value !== "object" || value === null || Array.isArray(value)
    || Object.keys(value).length !== 3
    || (value as CommandRuntimeResponse).schema_version !== 1
    || (value as CommandRuntimeResponse).status !== "accepted"
  ) throw new DomainError("INTERNAL_ERROR", "Stored runtime command response is invalid");
  const runtime = (value as CommandRuntimeResponse).runtime;
  if (
    runtime?.container_id !== expectedContainerId
    || !Number.isSafeInteger(runtime.resource_version) || runtime.resource_version < 1
    || runtime.desired_state !== expectedDesiredState
    || Object.keys(runtime).length !== 3
  ) throw new DomainError("INTERNAL_ERROR", "Stored runtime command response is invalid");
}

function retryableSerializationFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && ["40001", "40P01"].includes(String((error as { code?: unknown }).code));
}

async function serializable<T>(db: Kysely<RuntimeDatabase>, work: (trx: Transaction<RuntimeDatabase>) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await db.transaction().setIsolationLevel("serializable").execute(work);
    } catch (error) {
      if (!retryableSerializationFailure(error) || attempt === 2) throw error;
    }
  }
  throw new DomainError("INTERNAL_ERROR", "Serializable transaction retry exhausted");
}

export async function getTenantRuntime(
  db: Kysely<RuntimeDatabase>,
  authorityTenantId: string,
  pathTenantId: string,
): Promise<RuntimeContainer> {
  try {
    assertTenantId(authorityTenantId);
    assertTenantId(pathTenantId);
  } catch {
    notFound();
  }
  if (authorityTenantId !== pathTenantId) notFound();
  const runtime = await new ResourceRepositories(db).forTenant(authorityTenantId).runtimes
    .find(deriveRuntimeContainerId(authorityTenantId));
  if (runtime === undefined) notFound();
  return runtime;
}

export async function commandRuntime(
  dependencies: CommandRuntimeDependencies,
  context: ProvisioningContext,
  input: unknown,
): Promise<CommandRuntimeResponse> {
  if (!requestValidator.Check(input)) invalid("Runtime command does not satisfy its contract");
  const request = input as RuntimeCommandRequest;
  assertTenantId(context.tenantId);
  if (
    !Number.isSafeInteger(request.expected_resource_version)
    || request.expected_resource_version < 1
    || request.expected_resource_version >= Number.MAX_SAFE_INTEGER
  ) invalid("Expected resource version must be safely incrementable");
  if (request.payload_hash !== canonicalPayloadHash(payloadWithoutHash(request))) invalid("Payload hash does not match the canonical request");

  const tenantId = context.tenantId;
  const containerId = deriveRuntimeContainerId(tenantId);
  const targetState = desiredState(request.command);
  return serializable(dependencies.db, async (trx) => {
    const now = dependencies.now?.() ?? new Date();
    const nowIso = now.toISOString();
    const tenantTransaction: TenantTransaction = { tenantId, trx };
    await acquireRuntimeTransactionAdvisoryLock(trx, tenantId, containerId);
    const runtimeSnapshot = await trx.selectFrom("runtime_containers")
      .select(["container_id", "resource_version", "desired_state", "observed_state"])
      .where("tenant_id", "=", tenantId).where("container_id", "=", containerId)
      .forUpdate().executeTakeFirst();
    if (runtimeSnapshot === undefined) notFound();
    const admission = await beginIdempotentCommand<CommandRuntimeResponse>(tenantTransaction, {
      key: request.idempotency_key,
      payloadHash: request.payload_hash,
      operation: "runtime.command",
      now,
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000),
    });
    if (admission.kind === "replay") {
      if (admission.resultRef !== containerId) {
        throw new DomainError("INTERNAL_ERROR", "Runtime command replay result reference is invalid");
      }
      assertResponse(admission.response, containerId, targetState);
      return admission.response;
    }
    if (admission.kind === "in_progress") throw new DomainError("IDEMPOTENCY_CONFLICT", "Runtime command is already in progress");
    if (safeContractInteger(runtimeSnapshot.resource_version) !== request.expected_resource_version) {
      throw new DomainError("RESOURCE_VERSION_CONFLICT", "Runtime version has changed");
    }
    if (runtimeSnapshot.desired_state === "deleted" || runtimeSnapshot.observed_state === "deleted") {
      throw new DomainError("INVALID_STATE_TRANSITION", "Deleted runtime state is terminal");
    }

    const runtimeRepository = new ResourceRepositories(dependencies.db).forTransaction(tenantTransaction).runtimes;
    const result = await runtimeRepository.updateDesiredState(containerId, targetState, request.expected_resource_version, now);
    if (result.kind === "not_found") notFound();
    if (result.kind === "version_conflict") throw new DomainError("RESOURCE_VERSION_CONFLICT", "Runtime version has changed");
    const jobId = deriveId("job_reconcile", tenantId, request.idempotency_key);
    const eventId = deriveId("event_runtime_command", tenantId, request.idempotency_key);
    const auditEventId = deriveId("audit_runtime_command", tenantId, request.idempotency_key);
    const commandVersionRow = await trx.updateTable("runtime_containers").set({ command_version: sql`command_version + 1` })
      .where("tenant_id", "=", tenantId).where("container_id", "=", containerId).returning("command_version").executeTakeFirstOrThrow();
    const commandVersion = safeContractInteger(commandVersionRow.command_version);
    await trx.insertInto("worker_jobs").values({
      tenant_id: tenantId, job_id: jobId, job_kind: "reconcile_runtime", status: "queued",
      attempt_count: 0, max_attempts: 5, lease_owner: null, lease_expires_at: null,
      next_attempt_at: now, payload_ref: containerId, effect_state: "pre_effect",
      runtime_command: request.command,
      target_command_version: commandVersion,
      last_error_summary: null, run_id: null, container_id: containerId, created_at: now, updated_at: now,
    }).execute();
    const eventBase = {
      schema_version: 1 as const, event_id: eventId, occurred_at: nowIso,
      tenant_id: tenantId, request_id: context.requestId, trace_id: context.traceId,
      correlation_id: request.idempotency_key, causation_id: jobId,
      event_type: "runtime.command_accepted" as const,
    };
    const commandEvent = request.command === "start"
      ? { ...eventBase, payload: { container_id: containerId, command: "start" as const, desired_state: "running" as const } }
      : request.command === "restart"
        ? { ...eventBase, payload: { container_id: containerId, command: "restart" as const, desired_state: "running" as const } }
        : request.command === "stop"
          ? { ...eventBase, payload: { container_id: containerId, command: "stop" as const, desired_state: "stopped" as const } }
          : { ...eventBase, payload: { container_id: containerId, command: "delete" as const, desired_state: "deleted" as const } };
    await appendProductEvents(tenantTransaction, {
      streamId: `runtime_${containerId}`,
      deliveryTarget: "internal_event_stream",
      events: [commandEvent],
    });
    await appendAuditEvent(tenantTransaction, {
      schema_version: 1, audit_event_id: auditEventId, occurred_at: nowIso, tenant_id: tenantId,
      actor_id: context.actorId, membership_id: context.membershipId, effective_role: context.effectiveRole,
      action: `runtime.${request.command}`, resource_type: "runtime_container", resource_id: containerId,
      decision: "allowed", outcome: "pending", request_id: context.requestId, trace_id: context.traceId,
      reason_summary: "Accepted managed runtime command", resource_version: result.resource_version,
    });
    const response: CommandRuntimeResponse = {
      schema_version: 1, status: "accepted",
      runtime: { container_id: containerId, resource_version: result.resource_version, desired_state: targetState },
    };
    await completeIdempotentCommand(tenantTransaction, {
      key: request.idempotency_key,
      payloadHash: request.payload_hash,
      operation: "runtime.command",
      resultRef: containerId,
      response,
      updatedAt: now,
    });
    return response;
  });
}
