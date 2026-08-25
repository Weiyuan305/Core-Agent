import { canonicalPublicPayloadHash } from "../auth/auth-api.js";

const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const CSRF_COOKIE_NAME = "core_agent_csrf";
const CSRF_HEADER_NAME = "x-core-agent-csrf";
const opaquePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u;
const utcPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export type PublicServiceState = "preparing" | "available" | "suspended" | "expired" | "unavailable";

export interface PlatformCapabilityView {
  readonly capabilityId: string;
  readonly capabilityVersionId?: string;
  readonly displayName: string;
  readonly version: string;
  readonly kind: "mcp" | "skill" | "policy";
  readonly status: "draft" | "reviewed" | "retired" | "blocked";
  readonly resourceVersion?: number;
}

export interface PlatformPackView {
  readonly packProductId: string;
  readonly packVersionId?: string;
  readonly displayName: string;
  readonly version: string;
  readonly tenantModes: readonly ("b2b" | "b2c")[];
  readonly status: "draft" | "reviewed" | "published" | "retired" | "blocked";
  readonly resourceVersion?: number;
}

export interface PlatformEntitlementView {
  readonly entitlementId: string;
  readonly tenantId: string;
  readonly displayName: string;
  readonly tenantMode: "b2b" | "b2c";
  readonly status: "active" | "suspended" | "expired" | "revoked";
  readonly validFrom: string;
  readonly expiresAt?: string;
  readonly resourceVersion: number;
}

export interface CompanyServiceView {
  readonly serviceId: string;
  readonly resourceVersion: number;
  readonly displayName: string;
  readonly validFrom: string;
  readonly expiresAt?: string;
  readonly state: PublicServiceState;
  readonly usedSeats: number;
  readonly totalSeats: number;
  readonly availableSeats: number;
}

export interface CompanyAssignmentView {
  readonly assignmentId: string;
  readonly resourceVersion: number;
  readonly profileId: string;
  readonly profileDisplayName: string;
  readonly serviceDisplayName: string;
  readonly state: PublicServiceState;
}

export interface StudentServiceView {
  readonly serviceId: string;
  readonly displayName: string;
  readonly validFrom: string;
  readonly expiresAt?: string;
  readonly state: PublicServiceState;
}

export type ServiceWorkspace =
  | { readonly kind: "platform"; readonly catalog: { readonly capabilities: readonly PlatformCapabilityView[]; readonly packs: readonly PlatformPackView[] }; readonly entitlements: readonly PlatformEntitlementView[] }
  | { readonly kind: "company"; readonly tenantId: string; readonly services: readonly CompanyServiceView[]; readonly assignments: readonly CompanyAssignmentView[] }
  | { readonly kind: "student"; readonly services: readonly StudentServiceView[] }
  | { readonly kind: "none" };

export type ServiceMutation =
  | {
      readonly kind: "capability_create";
      readonly capabilityId: string;
      readonly capabilityVersionId: string;
      readonly displayName: string;
      readonly owningDomain: string;
      readonly capabilityKind: "mcp" | "skill" | "policy";
      readonly version: string;
      readonly artifactRef: string;
      readonly contractRef: string;
      readonly riskClass: "read" | "draft_write" | "external_write" | "privileged";
      readonly approvalRequirement: "none" | "user_confirmation" | "human_approval";
      readonly coreContractVersion: string;
      readonly domainContractVersion: string;
      readonly runtimeProtocolVersion: string;
      readonly tenantModes: readonly ("b2b" | "b2c")[];
    }
  | { readonly kind: "capability_review" | "capability_retire" | "capability_block"; readonly capabilityVersionId: string; readonly expectedResourceVersion: number }
  | {
      readonly kind: "pack_create";
      readonly packProductId: string;
      readonly packVersionId: string;
      readonly displayName: string;
      readonly tenantModes: readonly ("b2b" | "b2c")[];
      readonly version: string;
      readonly members: readonly { readonly capabilityId: string; readonly capabilityVersionId: string; readonly version: string }[];
    }
  | { readonly kind: "pack_review" | "pack_publish" | "pack_retire" | "pack_block"; readonly packVersionId: string; readonly expectedResourceVersion: number }
  | { readonly kind: "tenant_select_release"; readonly tenantId: string; readonly packProductId: string; readonly packVersionId: string; readonly expectedResourceVersion: number }
  | ({
      readonly kind: "entitlement_grant";
      readonly tenantId: string;
      readonly packProductId: string;
      readonly externalOrderRef: string;
      readonly expectedResourceVersion: number;
      readonly expiresAt?: string;
    } & (
      | { readonly tenantMode: "b2b"; readonly seatQuantity: number }
      | { readonly tenantMode: "b2c" }
    ))
  | { readonly kind: "entitlement_change_status"; readonly entitlementId: string; readonly expectedResourceVersion: number; readonly status: "active" | "suspended" | "revoked" }
  | { readonly kind: "seat_assign"; readonly tenantId: string; readonly entitlementId: string; readonly expectedResourceVersion: number; readonly profileId: string }
  | { readonly kind: "seat_revoke"; readonly tenantId: string; readonly assignmentId: string; readonly expectedResourceVersion: number };

export type ServiceClientFailureReason = "anonymous" | "forbidden" | "invalid" | "conflict" | "seat_exhausted" | "capability_conflict" | "rate_limited" | "reauthentication_required" | "unavailable";

export class ServiceClientError extends Error {
  public constructor(public readonly reason: ServiceClientFailureReason, public readonly retryable: boolean) {
    super("SERVICE_CLIENT_FAILURE");
    this.name = "ServiceClientError";
  }
}

export interface ServicesApi {
  readonly loadWorkspace: (tenantId?: string) => Promise<ServiceWorkspace>;
  readonly mutate: (input: ServiceMutation) => Promise<void>;
}

export interface ServicesApiOptions {
  readonly idempotencyKey?: () => string;
  readonly timeoutMs?: number;
}

type JsonRecord = Readonly<Record<string, unknown>>;

function plainRecord(value: unknown): JsonRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !("value" in descriptors[key]!))) return undefined;
  return value as JsonRecord;
}

function exactKeys(record: JsonRecord, required: readonly string[], optional: readonly string[] = []): boolean {
  const accepted = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(record, key))
    && Reflect.ownKeys(record).every((key) => typeof key === "string" && accepted.has(key));
}

function unavailable(): never {
  throw new ServiceClientError("unavailable", true);
}

function validOpaque(value: unknown): value is string {
  return typeof value === "string" && opaquePattern.test(value);
}

function validVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function validSemanticVersion(value: unknown): value is string {
  return typeof value === "string" && /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/u.test(value);
}

function validUtc(value: unknown): value is string {
  return typeof value === "string" && utcPattern.test(value) && Number.isFinite(Date.parse(value));
}

function validDisplay(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 200;
}

function validState(value: unknown): value is PublicServiceState {
  return value === "preparing" || value === "available" || value === "suspended" || value === "expired" || value === "unavailable";
}

function parseError(status: number, value: unknown): ServiceClientError {
  const record = plainRecord(value);
  const code = record?.code;
  const message = record?.message;
  if (status === 401 && code === "REAUTHENTICATION_REQUIRED") return new ServiceClientError("reauthentication_required", false);
  if (status === 401) return new ServiceClientError("anonymous", false);
  if (status === 403 || status === 404) return new ServiceClientError("forbidden", false);
  if (status === 400) return new ServiceClientError("invalid", false);
  if (status === 409 && code === "AUTH_CONFLICT" && message === "可分配名额已用完。") return new ServiceClientError("seat_exhausted", false);
  if (status === 409 && code === "AUTH_CONFLICT" && message === "当前服务组合暂时无法启用，请联系支持。") return new ServiceClientError("capability_conflict", false);
  if (status === 409) return new ServiceClientError("conflict", false);
  if (status === 429) return new ServiceClientError("rate_limited", true);
  return new ServiceClientError("unavailable", status >= 500);
}

async function boundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.toLowerCase();
  if (contentType === undefined || !contentType.startsWith("application/json")) unavailable();
  if (response.body === null) unavailable();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        unavailable();
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    unavailable();
  } finally {
    bytes.fill(0);
  }
}

function csrfCookie(): string | undefined {
  if (typeof document === "undefined") return undefined;
  const values = document.cookie.split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${CSRF_COOKIE_NAME}=`));
  if (values.length !== 1) return undefined;
  const value = values[0]!.slice(CSRF_COOKIE_NAME.length + 1);
  return value.length >= 1 && value.length <= 4_096 ? value : undefined;
}

function defaultIdempotencyKey(): string {
  if (typeof globalThis.crypto.randomUUID === "function") return `service_${globalThis.crypto.randomUUID()}`;
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return `service_${[...bytes].map((item) => item.toString(16).padStart(2, "0")).join("")}`;
}

function parseCatalog(value: unknown): Extract<ServiceWorkspace, { kind: "platform" }>["catalog"] {
  const record = plainRecord(value);
  if (record === undefined || !exactKeys(record, ["schema_version", "capabilities", "packs"])
    || record.schema_version !== 1 || !Array.isArray(record.capabilities) || !Array.isArray(record.packs)
    || record.capabilities.length > 200 || record.packs.length > 200) unavailable();
  const capabilities = record.capabilities.map((entry): PlatformCapabilityView => {
    const row = plainRecord(entry);
    if (row === undefined || !exactKeys(row, ["schema_version", "capability_id", "version", "display_name", "kind", "status"], ["capability_version_id", "resource_version"])
      || row.schema_version !== 1 || !validOpaque(row.capability_id) || !validDisplay(row.display_name)
      || !validSemanticVersion(row.version)
      || (row.kind !== "mcp" && row.kind !== "skill" && row.kind !== "policy")
      || (row.status !== "draft" && row.status !== "reviewed" && row.status !== "retired" && row.status !== "blocked")
      || (row.capability_version_id !== undefined && !validOpaque(row.capability_version_id))
      || (row.resource_version !== undefined && !validVersion(row.resource_version))) unavailable();
    return Object.freeze({
      capabilityId: row.capability_id,
      ...(row.capability_version_id === undefined ? {} : { capabilityVersionId: row.capability_version_id as string }),
      displayName: row.display_name,
      version: row.version,
      kind: row.kind,
      status: row.status,
      ...(row.resource_version === undefined ? {} : { resourceVersion: row.resource_version as number }),
    });
  });
  const packs = record.packs.map((entry): PlatformPackView => {
    const row = plainRecord(entry);
    if (row === undefined || !exactKeys(row, ["schema_version", "pack_product_id", "version", "display_name", "tenant_modes", "status"], ["pack_version_id", "resource_version"])
      || row.schema_version !== 1 || !validOpaque(row.pack_product_id) || !validDisplay(row.display_name)
      || !validSemanticVersion(row.version)
      || !Array.isArray(row.tenant_modes) || row.tenant_modes.length < 1 || row.tenant_modes.length > 2
      || row.tenant_modes.some((mode) => mode !== "b2b" && mode !== "b2c") || new Set(row.tenant_modes).size !== row.tenant_modes.length
      || (row.status !== "draft" && row.status !== "reviewed" && row.status !== "published" && row.status !== "retired" && row.status !== "blocked")
      || (row.pack_version_id !== undefined && !validOpaque(row.pack_version_id))
      || (row.resource_version !== undefined && !validVersion(row.resource_version))) unavailable();
    return Object.freeze({
      packProductId: row.pack_product_id,
      ...(row.pack_version_id === undefined ? {} : { packVersionId: row.pack_version_id as string }),
      displayName: row.display_name,
      version: row.version,
      tenantModes: Object.freeze([...(row.tenant_modes as ("b2b" | "b2c")[])]),
      status: row.status,
      ...(row.resource_version === undefined ? {} : { resourceVersion: row.resource_version as number }),
    });
  });
  return Object.freeze({ capabilities: Object.freeze(capabilities), packs: Object.freeze(packs) });
}

function parsePlatformEntitlements(value: unknown): readonly PlatformEntitlementView[] {
  const record = plainRecord(value);
  if (record === undefined || !exactKeys(record, ["schema_version", "entitlements"])
    || record.schema_version !== 1 || !Array.isArray(record.entitlements) || record.entitlements.length > 200) unavailable();
  return Object.freeze(record.entitlements.map((entry): PlatformEntitlementView => {
    const row = plainRecord(entry);
    if (row === undefined || !exactKeys(row, ["schema_version", "entitlement_id", "tenant_id", "display_name", "tenant_mode", "status", "valid_from", "resource_version"], ["expires_at"])
      || row.schema_version !== 1 || !validOpaque(row.entitlement_id) || !validOpaque(row.tenant_id) || !validDisplay(row.display_name)
      || (row.tenant_mode !== "b2b" && row.tenant_mode !== "b2c")
      || (row.status !== "active" && row.status !== "suspended" && row.status !== "expired" && row.status !== "revoked")
      || !validUtc(row.valid_from) || (row.expires_at !== undefined && !validUtc(row.expires_at)) || !validVersion(row.resource_version)) unavailable();
    return Object.freeze({
      entitlementId: row.entitlement_id,
      tenantId: row.tenant_id,
      displayName: row.display_name,
      tenantMode: row.tenant_mode,
      status: row.status,
      validFrom: row.valid_from,
      ...(row.expires_at === undefined ? {} : { expiresAt: row.expires_at as string }),
      resourceVersion: row.resource_version,
    });
  }));
}

function parseServiceRows(value: unknown, company: true): readonly CompanyServiceView[];
function parseServiceRows(value: unknown, company: false): readonly StudentServiceView[];
function parseServiceRows(value: unknown, company: boolean): readonly (CompanyServiceView | StudentServiceView)[] {
  const record = plainRecord(value);
  if (record === undefined || !exactKeys(record, ["schema_version", "services"])
    || record.schema_version !== 1 || !Array.isArray(record.services) || record.services.length > 200) unavailable();
  return Object.freeze(record.services.map((entry): CompanyServiceView | StudentServiceView => {
    const required = ["schema_version", "service_id", "display_name", "valid_from", "service_state"];
    const companyFields = ["used_seats", "total_seats", "available_seats"];
    const row = plainRecord(entry);
    if (row === undefined || !exactKeys(row, company ? [...required, "entitlement_resource_version", ...companyFields] : required, ["expires_at"])
      || row.schema_version !== 1 || !validOpaque(row.service_id) || !validDisplay(row.display_name)
      || !validUtc(row.valid_from) || (row.expires_at !== undefined && !validUtc(row.expires_at)) || !validState(row.service_state)
      || (company && !validVersion(row.entitlement_resource_version))) unavailable();
    const common = {
      serviceId: row.service_id,
      displayName: row.display_name,
      validFrom: row.valid_from,
      ...(row.expires_at === undefined ? {} : { expiresAt: row.expires_at as string }),
      state: row.service_state,
    } as const;
    if (!company) return Object.freeze(common);
    if (![row.used_seats, row.total_seats, row.available_seats].every((item) => Number.isSafeInteger(item) && Number(item) >= 0)
      || Number(row.total_seats) < 1 || Number(row.used_seats) + Number(row.available_seats) !== Number(row.total_seats)) unavailable();
    return Object.freeze({
      ...common,
      resourceVersion: row.entitlement_resource_version as number,
      usedSeats: row.used_seats as number,
      totalSeats: row.total_seats as number,
      availableSeats: row.available_seats as number,
    });
  }));
}

function parseAssignments(value: unknown): readonly CompanyAssignmentView[] {
  const record = plainRecord(value);
  if (record === undefined || !exactKeys(record, ["schema_version", "assignments"])
    || record.schema_version !== 1 || !Array.isArray(record.assignments) || record.assignments.length > 500) unavailable();
  return Object.freeze(record.assignments.map((entry): CompanyAssignmentView => {
    const row = plainRecord(entry);
    if (row === undefined || !exactKeys(row, ["schema_version", "assignment_id", "assignment_resource_version", "profile_id", "profile_display_name", "service_display_name", "service_state"])
      || row.schema_version !== 1 || !validOpaque(row.assignment_id) || !validOpaque(row.profile_id)
      || !validVersion(row.assignment_resource_version) || !validDisplay(row.profile_display_name) || !validDisplay(row.service_display_name) || !validState(row.service_state)) unavailable();
    return Object.freeze({
      assignmentId: row.assignment_id,
      resourceVersion: row.assignment_resource_version,
      profileId: row.profile_id,
      profileDisplayName: row.profile_display_name,
      serviceDisplayName: row.service_display_name,
      state: row.service_state,
    });
  }));
}

export function createServicesApi(fetchImpl: typeof fetch = fetch, options: ServicesApiOptions = {}): ServicesApi {
  if (typeof fetchImpl !== "function") unavailable();
  const makeKey = options.idempotencyKey ?? defaultIdempotencyKey;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) unavailable();

  async function request(path: string, init: RequestInit = { method: "GET" }): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (init.method === "POST") {
      const csrf = csrfCookie();
      if (csrf === undefined) throw new ServiceClientError("invalid", false);
      headers.set("content-type", "application/json");
      headers.set(CSRF_HEADER_NAME, csrf);
    }
    try {
      const response = await fetchImpl(path, { ...init, credentials: "same-origin", headers, signal: controller.signal });
      const body = await boundedJson(response);
      if (!response.ok) throw parseError(response.status, body);
      return body;
    } catch (error) {
      if (error instanceof ServiceClientError) throw error;
      throw new ServiceClientError("unavailable", true);
    } finally {
      clearTimeout(timer);
    }
  }

  async function tryLoad(path: string): Promise<{ readonly kind: "ok"; readonly value: unknown } | { readonly kind: "forbidden" }> {
    try {
      return { kind: "ok", value: await request(path) };
    } catch (error) {
      if (error instanceof ServiceClientError && error.reason === "forbidden") return { kind: "forbidden" };
      throw error;
    }
  }

  return Object.freeze({
    async loadWorkspace(tenantId?: string) {
      const [catalog, entitlements] = await Promise.all([
        tryLoad("/app/v1/platform/catalog"),
        tryLoad("/app/v1/platform/entitlements"),
      ]);
      if (catalog.kind === "ok" || entitlements.kind === "ok") {
        if (catalog.kind !== "ok" || entitlements.kind !== "ok") unavailable();
        return Object.freeze({ kind: "platform" as const, catalog: parseCatalog(catalog.value), entitlements: parsePlatformEntitlements(entitlements.value) });
      }
      if (tenantId !== undefined) {
        if (!validOpaque(tenantId)) throw new ServiceClientError("invalid", false);
        const query = `?tenant_id=${encodeURIComponent(tenantId)}`;
        const [services, assignments] = await Promise.all([
          tryLoad(`/app/v1/company/services${query}`),
          tryLoad(`/app/v1/company/assignments${query}`),
        ]);
        if (services.kind === "ok" || assignments.kind === "ok") {
          if (services.kind !== "ok" || assignments.kind !== "ok") unavailable();
          return Object.freeze({
            kind: "company" as const,
            tenantId,
            services: parseServiceRows(services.value, true),
            assignments: parseAssignments(assignments.value),
          });
        }
      }
      const student = await tryLoad("/app/v1/student/services");
      return student.kind === "ok"
        ? Object.freeze({ kind: "student" as const, services: parseServiceRows(student.value, false) })
        : Object.freeze({ kind: "none" as const });
    },
    async mutate(input: ServiceMutation) {
      const idempotencyKey = makeKey();
      if (!validOpaque(idempotencyKey)) throw new ServiceClientError("unavailable", false);
      let path: string;
      let body: JsonRecord;
      if (input.kind === "capability_create") {
        const facts = {
          schema_version: 1,
          idempotency_key: idempotencyKey,
          capability_id: input.capabilityId,
          capability_version_id: input.capabilityVersionId,
          display_name: input.displayName,
          owning_domain: input.owningDomain,
          kind: input.capabilityKind,
          version: input.version,
          artifact_ref: input.artifactRef,
          contract_ref: input.contractRef,
          risk_class: input.riskClass,
          approval_requirement: input.approvalRequirement,
          compatibility: {
            core_contract_version: input.coreContractVersion,
            domain_contract_version: input.domainContractVersion,
            runtime_protocol_version: input.runtimeProtocolVersion,
            tenant_modes: input.tenantModes,
          },
          expected_resource_version: null,
        } as const;
        path = "/app/v1/platform/catalog";
        body = { action: input.kind, command: { ...facts, payload_hash: await canonicalPublicPayloadHash(facts) } };
      } else if (input.kind === "capability_review" || input.kind === "capability_retire" || input.kind === "capability_block") {
        const facts = {
          schema_version: 1,
          idempotency_key: idempotencyKey,
          capability_version_id: input.capabilityVersionId,
          expected_resource_version: input.expectedResourceVersion,
        } as const;
        path = "/app/v1/platform/catalog";
        body = { action: input.kind, command: { ...facts, payload_hash: await canonicalPublicPayloadHash(facts) } };
      } else if (input.kind === "pack_create") {
        const facts = {
          schema_version: 1,
          idempotency_key: idempotencyKey,
          pack_product_id: input.packProductId,
          pack_version_id: input.packVersionId,
          display_name: input.displayName,
          tenant_modes: input.tenantModes,
          version: input.version,
          expected_resource_version: null,
          members: input.members.map((member) => ({
            capability_id: member.capabilityId,
            capability_version_id: member.capabilityVersionId,
            version: member.version,
          })),
        } as const;
        path = "/app/v1/platform/catalog";
        body = { action: input.kind, command: { ...facts, payload_hash: await canonicalPublicPayloadHash(facts) } };
      } else if (input.kind === "pack_review" || input.kind === "pack_publish" || input.kind === "pack_retire" || input.kind === "pack_block") {
        const facts = {
          schema_version: 1,
          idempotency_key: idempotencyKey,
          pack_version_id: input.packVersionId,
          expected_resource_version: input.expectedResourceVersion,
        } as const;
        path = "/app/v1/platform/catalog";
        body = { action: input.kind, command: { ...facts, payload_hash: await canonicalPublicPayloadHash(facts) } };
      } else if (input.kind === "tenant_select_release") {
        const facts = {
          schema_version: 1,
          idempotency_key: idempotencyKey,
          tenant_id: input.tenantId,
          pack_product_id: input.packProductId,
          pack_version_id: input.packVersionId,
          expected_resource_version: input.expectedResourceVersion,
        } as const;
        path = "/app/v1/platform/entitlements";
        body = { action: "select_release", command: { ...facts, payload_hash: await canonicalPublicPayloadHash(facts) } };
      } else if (input.kind === "entitlement_grant") {
        const common = {
          schema_version: 1,
          idempotency_key: idempotencyKey,
          tenant_id: input.tenantId,
          pack_product_id: input.packProductId,
          source: "platform_manual",
          external_order_ref: input.externalOrderRef,
          expected_resource_version: input.expectedResourceVersion,
          ...(input.expiresAt === undefined ? {} : { expires_at: input.expiresAt }),
        } as const;
        const facts = input.tenantMode === "b2b"
          ? { ...common, tenant_mode: "b2b" as const, assignment_mode: "seat" as const, seat_quantity: input.seatQuantity }
          : { ...common, tenant_mode: "b2c" as const, assignment_mode: "automatic" as const };
        path = "/app/v1/platform/entitlements";
        body = { action: "grant", command: { ...facts, payload_hash: await canonicalPublicPayloadHash(facts) } };
      } else if (input.kind === "entitlement_change_status") {
        const reasonCode = input.status === "suspended"
          ? "administrator_suspended"
          : input.status === "active"
            ? "administrator_reactivated"
            : "platform_revoked";
        const facts = {
          schema_version: 1,
          idempotency_key: idempotencyKey,
          entitlement_id: input.entitlementId,
          expected_resource_version: input.expectedResourceVersion,
          status: input.status,
          reason_code: reasonCode,
        } as const;
        path = "/app/v1/platform/entitlements";
        body = { action: "change_status", command: { ...facts, payload_hash: await canonicalPublicPayloadHash(facts) } };
      } else if (input.kind === "seat_assign") {
        const facts = {
          schema_version: 1,
          idempotency_key: idempotencyKey,
          entitlement_id: input.entitlementId,
          expected_resource_version: input.expectedResourceVersion,
          profile_id: input.profileId,
        } as const;
        path = "/app/v1/company/assignments";
        body = { action: "assign", tenant_id: input.tenantId, command: { ...facts, payload_hash: await canonicalPublicPayloadHash(facts) } };
      } else if (input.kind === "seat_revoke") {
        const facts = {
          schema_version: 1,
          idempotency_key: idempotencyKey,
          assignment_id: input.assignmentId,
          expected_resource_version: input.expectedResourceVersion,
          reason_code: "administrator_revoked",
        } as const;
        path = "/app/v1/company/assignments";
        body = { action: "revoke", tenant_id: input.tenantId, command: { ...facts, payload_hash: await canonicalPublicPayloadHash(facts) } };
      } else {
        throw new ServiceClientError("invalid", false);
      }
      const serialized = JSON.stringify(body);
      if (new TextEncoder().encode(serialized).byteLength > MAX_RESPONSE_BYTES) throw new ServiceClientError("invalid", false);
      await request(path, { method: "POST", body: serialized });
    },
  });
}
