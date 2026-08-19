import type {
  AuthSessionView,
  CompanyMemberView,
  InvitationInspectResponse,
} from "@core-agent/contracts";

const CSRF_COOKIE_NAME = "core_agent_csrf";
const CSRF_HEADER_NAME = "x-core-agent-csrf";
const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const sha256Pattern = /^sha256:[a-f0-9]{64}$/u;
const opaquePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u;
const utcMillisecondsPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export type AuthClientFailureReason =
  | "anonymous"
  | "invalid"
  | "conflict"
  | "rate_limited"
  | "reauthentication_required"
  | "unavailable";

export class AuthClientError extends Error {
  public constructor(
    public readonly reason: AuthClientFailureReason,
    public readonly retryable: boolean,
  ) {
    super("AUTH_CLIENT_FAILURE");
    this.name = "AuthClientError";
  }
}

type JsonRecord = Readonly<Record<string, unknown>>;

export interface AuthApiOptions {
  readonly idempotencyKey?: () => string;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

export interface InvitationView {
  readonly invitation_id: string;
  readonly tenant_id: string;
  readonly role: "admin" | "consultant";
  readonly status: "pending" | "accepted" | "revoked" | "replaced" | "expired";
  readonly expires_at: string;
  readonly resource_version: number;
}

export interface VerificationPending {
  readonly verificationId: string;
  readonly status: "verification_pending";
}

export interface AcceptedInvitation {
  readonly session: AuthSessionView;
  readonly tenantId: string;
  readonly role: "admin" | "consultant";
}

export interface AccountDeletionView {
  readonly accountDeletionId: string;
  readonly scheduledFor: string;
  readonly resourceVersion: number;
}

export interface AuthApi {
  readonly inspectSession: () => Promise<AuthSessionView>;
  readonly signIn: (input: { readonly email: string; readonly password: string }) => Promise<AuthSessionView>;
  readonly signUp: (input: { readonly email: string; readonly password: string }) => Promise<VerificationPending>;
  readonly verifyEmail: (input: { readonly verificationId: string; readonly verificationCode: string }) => Promise<AuthSessionView>;
  readonly startAppleSignIn: () => Promise<string>;
  readonly inspectInvitation: (invitationSecret: string) => Promise<InvitationView>;
  readonly registerInvitation: (input: {
    readonly invitationSecret: string;
    readonly email: string;
    readonly password: string;
  }) => Promise<VerificationPending>;
  readonly acceptInvitation: (input: {
    readonly invitationSecret: string;
    readonly expectedResourceVersion: number;
  }) => Promise<AcceptedInvitation>;
  readonly signOut: () => Promise<void>;
  readonly revokeCurrentSession: (input: {
    readonly sessionId: string;
    readonly expectedResourceVersion: number;
  }) => Promise<void>;
  readonly reauthenticate: (input: {
    readonly password: string;
    readonly sessionResourceVersion: number;
  }) => Promise<AuthSessionView>;
  readonly listCompanyMembers: (tenantId: string) => Promise<readonly CompanyMemberView[]>;
  readonly inviteCompanyMember: (input: {
    readonly tenantId: string;
    readonly email: string;
    readonly role: "admin" | "consultant";
  }) => Promise<void>;
  readonly suspendCompanyMember: (input: {
    readonly membershipId: string;
    readonly expectedResourceVersion: number;
  }) => Promise<void>;
  readonly revokeCompanyMember: (input: {
    readonly membershipId: string;
    readonly expectedResourceVersion: number;
  }) => Promise<void>;
  readonly requestAccountDeletion: (sessionResourceVersion: number) => Promise<AccountDeletionView>;
  readonly cancelAccountDeletion: (input: {
    readonly accountDeletionId: string;
    readonly expectedResourceVersion: number;
  }) => Promise<void>;
}

function plainRecord(value: unknown): JsonRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  if (Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  return value as JsonRecord;
}

function exactKeys(record: JsonRecord, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Reflect.ownKeys(record);
  const accepted = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(record, key))
    && keys.every((key) => typeof key === "string" && accepted.has(key));
}

function validOpaque(value: unknown): value is string {
  return typeof value === "string" && opaquePattern.test(value);
}

function validVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function validUtc(value: unknown): value is string {
  if (typeof value !== "string" || !utcMillisecondsPattern.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function unavailable(): never {
  throw new AuthClientError("unavailable", true);
}

function parseSession(value: unknown): AuthSessionView {
  const record = plainRecord(value);
  if (record === undefined || !exactKeys(record, [
    "schema_version", "actor_id", "actor_resource_version", "session_id",
    "session_resource_version", "client_kind", "idle_expires_at",
    "absolute_expires_at", "reauthentication_required",
  ]) || record.schema_version !== 1 || !validOpaque(record.actor_id)
    || !validVersion(record.actor_resource_version) || !validOpaque(record.session_id)
    || !validVersion(record.session_resource_version) || record.client_kind !== "web"
    || !validUtc(record.idle_expires_at) || !validUtc(record.absolute_expires_at)
    || typeof record.reauthentication_required !== "boolean") unavailable();
  return Object.freeze({
    schema_version: 1,
    actor_id: record.actor_id,
    actor_resource_version: record.actor_resource_version,
    session_id: record.session_id,
    session_resource_version: record.session_resource_version,
    client_kind: "web",
    idle_expires_at: record.idle_expires_at,
    absolute_expires_at: record.absolute_expires_at,
    reauthentication_required: record.reauthentication_required,
  });
}

function parseSessionEnvelope(value: unknown): AuthSessionView {
  const record = plainRecord(value);
  if (record === undefined || record.schema_version !== 1) unavailable();
  if (exactKeys(record, ["schema_version", "session"])) return parseSession(record.session);
  if (!exactKeys(record, ["schema_version", "transport", "session"]) || record.transport !== "web_cookie") unavailable();
  return parseSession(record.session);
}

function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new AuthClientError("invalid", false);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const record = plainRecord(value);
  if (record === undefined) throw new AuthClientError("invalid", false);
  return `{${Object.keys(record).sort().map((key) => {
    const item = record[key];
    if (item === undefined) throw new AuthClientError("invalid", false);
    return `${JSON.stringify(key)}:${canonicalize(item)}`;
  }).join(",")}}`;
}

async function digestHex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  try {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, "0")).join("");
  } finally {
    bytes.fill(0);
  }
}

async function rawDigest(value: string): Promise<string> {
  return `sha256:${await digestHex(value)}`;
}

async function payloadHash(value: JsonRecord): Promise<string> {
  return rawDigest(canonicalize(value));
}

export const canonicalPublicPayloadHash = Object.assign(payloadHash, { rawDigest });

function defaultIdempotencyKey(): string {
  if (typeof globalThis.crypto.randomUUID === "function") return `web_${globalThis.crypto.randomUUID()}`;
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return `web_${[...bytes].map((item) => item.toString(16).padStart(2, "0")).join("")}`;
}

function csrfCookie(): string | undefined {
  if (typeof document === "undefined") return undefined;
  const values = document.cookie.split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${CSRF_COOKIE_NAME}=`));
  if (values.length !== 1) return undefined;
  const value = values[0]!.slice(CSRF_COOKIE_NAME.length + 1);
  return value.length >= 1 && value.length <= 4_096 ? value : undefined;
}

function errorReason(status: number, value: unknown): AuthClientError {
  const record = plainRecord(value);
  const code = record === undefined ? undefined : record.code;
  if (status === 401 && code === "REAUTHENTICATION_REQUIRED") return new AuthClientError("reauthentication_required", false);
  if (status === 401) return new AuthClientError("anonymous", false);
  if (status === 400) return new AuthClientError("invalid", false);
  if (status === 409) return new AuthClientError("conflict", false);
  if (status === 429) return new AuthClientError("rate_limited", true);
  return new AuthClientError("unavailable", status >= 500);
}

async function boundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.toLowerCase();
  if (contentType === undefined || !contentType.startsWith("application/json")) unavailable();
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d{1,10}$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) unavailable();
  if (response.body === null) unavailable();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        unavailable();
      }
      chunks.push(result.value);
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

function parseErrorEnvelope(value: unknown): JsonRecord | undefined {
  const record = plainRecord(value);
  if (record === undefined || !exactKeys(record, [
    "schema_version", "error_id", "code", "category", "message", "retryable", "request_id", "trace_id",
  ], ["retry_after_ms", "field_errors", "resource_type", "resource_id", "resource_version", "current_state"])) return undefined;
  return record.schema_version === 1 && typeof record.code === "string" && typeof record.retryable === "boolean"
    ? record : undefined;
}

function normalizedEmail(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized.length < 3 || normalized.length > 320 || !/^[^\s@]+@[^\s@]+$/u.test(normalized)) {
    throw new AuthClientError("invalid", false);
  }
  return normalized;
}

function assertPassword(value: string): void {
  if (value.length < 8 || value.length > 1_024) throw new AuthClientError("invalid", false);
}

function invitationBytes(secret: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(secret)) throw new AuthClientError("invalid", false);
  const base64 = secret.replace(/-/gu, "+").replace(/_/gu, "/") + "=";
  const decoded = atob(base64);
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  if (bytes.byteLength !== 32) {
    bytes.fill(0);
    throw new AuthClientError("invalid", false);
  }
  return bytes;
}

function assertInvitationSecret(secret: string): void {
  const owned = invitationBytes(secret);
  owned.fill(0);
}

async function invitationDigest(secret: string): Promise<string> {
  const owned = invitationBytes(secret);
  try {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", owned.buffer as ArrayBuffer);
    let binary = "";
    for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
  } finally {
    owned.fill(0);
  }
}

function parseInvitation(value: unknown): InvitationView {
  const record = plainRecord(value);
  if (record === undefined || !exactKeys(record, [
    "schema_version", "invitation_id", "tenant_id", "role", "status", "expires_at", "resource_version",
  ]) || record.schema_version !== 1 || !validOpaque(record.invitation_id) || !validOpaque(record.tenant_id)
    || (record.role !== "admin" && record.role !== "consultant")
    || !new Set(["pending", "accepted", "revoked", "replaced", "expired"]).has(String(record.status))
    || !validUtc(record.expires_at) || !validVersion(record.resource_version)) unavailable();
  return Object.freeze(record as unknown as InvitationView);
}

function parseMember(value: unknown): CompanyMemberView {
  const record = plainRecord(value);
  if (record === undefined || record.schema_version !== 1 || !validOpaque(record.membership_id)
    || !validOpaque(record.actor_id) || !validVersion(record.membership_resource_version)
    || (record.source !== "platform" && record.source !== "company")
    || !Array.isArray(record.roles) || record.roles.length < 1 || record.roles.length > 2
    || record.roles.some((role) => role !== "admin" && role !== "consultant")) unavailable();
  const permitted = new Set([
    "schema_version", "membership_id", "actor_id", "membership_resource_version", "source", "status", "roles",
    "profile_id", "profile_resource_version", "profile_status",
  ]);
  if (Reflect.ownKeys(record).some((key) => typeof key !== "string" || !permitted.has(key))) unavailable();
  if (!new Set(["invited", "active", "suspended", "revoked"]).has(String(record.status))) unavailable();
  const roles = record.roles as unknown[];
  if (new Set(roles).size !== roles.length || (roles.length === 2 && (roles[0] !== "admin" || roles[1] !== "consultant"))) unavailable();
  const profileKeys = ["profile_id", "profile_resource_version", "profile_status"] as const;
  const profileCount = profileKeys.filter((key) => Object.prototype.hasOwnProperty.call(record, key)).length;
  if (record.source === "platform") {
    if (record.status !== "active" || roles.length !== 1 || roles[0] !== "admin" || profileCount !== 0) unavailable();
  } else if (record.status === "invited") {
    if (roles.length !== 1 || profileCount !== 0) unavailable();
  } else if (profileCount === 0) {
    if (roles.length !== 1 || roles[0] !== "admin") unavailable();
  } else if (profileCount !== 3 || !validOpaque(record.profile_id) || !validVersion(record.profile_resource_version)
    || !new Set(["active", "suspended", "archived"]).has(String(record.profile_status))) {
    unavailable();
  } else {
    const profileStatus = record.profile_status;
    if (roles.length === 1 && roles[0] === "admin") {
      const validAdminProfile = (record.status === "active" && (profileStatus === "suspended" || profileStatus === "archived"))
        || (record.status === "suspended" && profileStatus === "suspended")
        || (record.status === "revoked" && profileStatus === "archived");
      if (!validAdminProfile) unavailable();
    } else {
      const expectedProfileStatus = record.status === "active" ? "active"
        : record.status === "suspended" ? "suspended" : "archived";
      if (profileStatus !== expectedProfileStatus) unavailable();
    }
  }
  return Object.freeze({ ...record } as CompanyMemberView);
}

function exactMutationResponse(value: unknown, fields: Readonly<Record<string, (candidate: unknown) => boolean>>): JsonRecord {
  const record = plainRecord(value);
  const keys = ["schema_version", ...Object.keys(fields)];
  if (record === undefined || !exactKeys(record, keys) || record.schema_version !== 1
    || Object.entries(fields).some(([key, validate]) => !validate(record[key]))) unavailable();
  return record;
}

const literal = (expected: string) => (value: unknown): boolean => value === expected;

export function createAuthApi(fetchImpl: typeof fetch = fetch, options: AuthApiOptions = {}): AuthApi {
  if (typeof fetchImpl !== "function") throw new AuthClientError("unavailable", false);
  const makeKey = options.idempotencyKey ?? defaultIdempotencyKey;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) unavailable();

  async function request(path: string, init: RequestInit): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    const isMutation = init.method !== undefined && init.method !== "GET" && init.method !== "HEAD";
    if (isMutation) {
      headers.set("content-type", "application/json");
      const csrf = csrfCookie();
      if (csrf !== undefined) headers.set(CSRF_HEADER_NAME, csrf);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(path, {
        ...init,
        credentials: "same-origin",
        headers,
        signal: controller.signal,
      });
      const body = await boundedJson(response);
      if (!response.ok) {
        const error = parseErrorEnvelope(body);
        throw errorReason(response.status, error);
      }
      return body;
    } catch (error) {
      if (error instanceof AuthClientError) throw error;
      throw new AuthClientError("unavailable", true);
    } finally {
      clearTimeout(timeout);
    }
  }

  async function post(path: string, body: JsonRecord): Promise<unknown> {
    const serialized = JSON.stringify(body);
    if (new TextEncoder().encode(serialized).byteLength > MAX_RESPONSE_BYTES) throw new AuthClientError("invalid", false);
    return request(path, { method: "POST", body: serialized });
  }

  async function protectedBody(facts: JsonRecord): Promise<JsonRecord> {
    return { ...facts, payload_hash: await payloadHash(facts) };
  }

  const pendingAdmissions = new Map<string, string>();
  async function withIdempotency<T>(
    scope: string,
    fingerprintFacts: JsonRecord,
    operation: (idempotencyKey: string) => Promise<T>,
  ): Promise<T> {
    const admission = `${scope}:${await payloadHash(fingerprintFacts)}`;
    let idempotencyKey = pendingAdmissions.get(admission);
    if (idempotencyKey === undefined) {
      while (pendingAdmissions.size >= 32) {
        const oldest = pendingAdmissions.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        pendingAdmissions.delete(oldest);
      }
      idempotencyKey = makeKey();
      if (!validOpaque(idempotencyKey)) throw new AuthClientError("unavailable", false);
      pendingAdmissions.set(admission, idempotencyKey);
    }
    try {
      const result = await operation(idempotencyKey);
      pendingAdmissions.delete(admission);
      return result;
    } catch (error) {
      const retain = error instanceof AuthClientError
        && (error.retryable || error.reason === "conflict" || error.reason === "reauthentication_required");
      if (!retain) pendingAdmissions.delete(admission);
      throw error;
    }
  }

  const api: AuthApi = {
    async inspectSession() {
      return parseSessionEnvelope(await request("/auth/v1/session", { method: "GET" }));
    },
    async signIn(input) {
      const email = normalizedEmail(input.email);
      assertPassword(input.password);
      const proofDigest = await rawDigest(input.password);
      return withIdempotency("email-sign-in", { normalized_email: email, sign_in_proof_digest: proofDigest, client_kind: "web" }, async (idempotencyKey) => {
        const facts = {
          schema_version: 1, idempotency_key: idempotencyKey, normalized_email: email,
          sign_in_proof_digest: proofDigest, client_kind: "web",
        } as const;
        return parseSessionEnvelope(await post("/auth/v1/email/sign-in", {
          schema_version: 1, idempotency_key: idempotencyKey, payload_hash: await payloadHash(facts),
          email, password: input.password, client_kind: "web",
        }));
      });
    },
    async signUp(input) {
      const email = normalizedEmail(input.email);
      assertPassword(input.password);
      const passwordProofDigest = await rawDigest(input.password);
      return withIdempotency("email-sign-up", { normalized_email: email, password_proof_digest: passwordProofDigest, client_kind: "web" }, async (idempotencyKey) => {
        const hash = await payloadHash({
          schema_version: 1, flow_kind: "b2c", idempotency_key: idempotencyKey,
          normalized_email: email, client_kind: "web",
        });
        const result = plainRecord(await post("/auth/v1/email/sign-up", {
          schema_version: 1, idempotency_key: idempotencyKey, payload_hash: hash,
          email, password: input.password, client_kind: "web",
        }));
        if (result === undefined || !exactKeys(result, ["schema_version", "verification_id", "status"])
          || result.schema_version !== 1 || !validOpaque(result.verification_id) || result.status !== "verification_pending") unavailable();
        return Object.freeze({ verificationId: result.verification_id, status: "verification_pending" as const });
      });
    },
    async verifyEmail(input) {
      return withIdempotency("email-verification", {
        verification_id: input.verificationId, verification_code_digest: await rawDigest(input.verificationCode),
      }, async (idempotencyKey) => {
        const facts = {
          schema_version: 1, idempotency_key: idempotencyKey,
          verification_id: input.verificationId, verification_code: input.verificationCode,
        } as const;
        return parseSessionEnvelope(await post("/auth/v1/email/verification", {
          ...facts, payload_hash: await payloadHash(facts),
        }));
      });
    },
    async startAppleSignIn() {
      const redirectUri = new URL("/auth/apple/callback", globalThis.location.origin).toString();
      return withIdempotency("apple-sign-in-start", { client_kind: "web", redirect_uri: redirectUri }, async (idempotencyKey) => {
        const facts = {
          schema_version: 1, flow_kind: "apple_sign_in", idempotency_key: idempotencyKey,
          client_kind: "web", redirect_uri: redirectUri,
        } as const;
        const result = plainRecord(await post("/auth/v1/apple/start", {
          schema_version: 1, idempotency_key: idempotencyKey, payload_hash: await payloadHash(facts),
          client_kind: "web", redirect_uri: redirectUri,
        }));
        if (result === undefined || !exactKeys(result, ["schema_version", "authorization_url"])
          || result.schema_version !== 1 || typeof result.authorization_url !== "string") unavailable();
        let authorization: URL;
        try { authorization = new URL(result.authorization_url); } catch { unavailable(); }
        if (authorization.protocol !== "https:" || authorization.username !== "" || authorization.password !== ""
          || authorization.hash !== "" || result.authorization_url.length > 2_048) unavailable();
        return result.authorization_url;
      });
    },
    async inspectInvitation(secret) {
      assertInvitationSecret(secret);
      return parseInvitation(await post("/auth/v1/invitations/inspect", {
        schema_version: 1, invitation_secret: secret,
      }));
    },
    async registerInvitation(input) {
      const email = normalizedEmail(input.email);
      assertPassword(input.password);
      const invitationProof = await invitationDigest(input.invitationSecret);
      return withIdempotency("invitation-register", {
        normalized_email: email, password_proof_digest: await rawDigest(input.password),
        invitation_digest: invitationProof, client_kind: "web",
      }, async (idempotencyKey) => {
        const hash = await payloadHash({
          schema_version: 1, flow_kind: "invitation", idempotency_key: idempotencyKey,
          normalized_email: email, client_kind: "web", invitation_digest: invitationProof,
        });
        const result = plainRecord(await post("/auth/v1/invitations/register", {
          schema_version: 1, idempotency_key: idempotencyKey, payload_hash: hash,
          invitation_secret: input.invitationSecret, email, password: input.password, client_kind: "web",
        }));
        if (result === undefined || !exactKeys(result, ["schema_version", "verification_id", "status"])
          || result.schema_version !== 1 || result.status !== "verification_pending" || !validOpaque(result.verification_id)) unavailable();
        return Object.freeze({ verificationId: result.verification_id, status: "verification_pending" as const });
      });
    },
    async acceptInvitation(input) {
      const invitationProof = await rawDigest(input.invitationSecret);
      return withIdempotency("invitation-accept", {
        expected_resource_version: input.expectedResourceVersion, invitation_digest: invitationProof,
        authentication: { kind: "core_session", client_kind: "web" },
      }, async (idempotencyKey) => {
        const facts = {
          schema_version: 1, idempotency_key: idempotencyKey,
          expected_resource_version: input.expectedResourceVersion,
          invitation_digest: invitationProof,
          authentication: { kind: "core_session", client_kind: "web" },
        } as const;
        const result = plainRecord(await post("/auth/v1/invitations/accept", {
          schema_version: 1, idempotency_key: idempotencyKey, payload_hash: await payloadHash(facts),
          expected_resource_version: input.expectedResourceVersion,
          invitation_secret: input.invitationSecret, client_kind: "web",
        }));
        const common = ["schema_version", "transport", "tenant_id", "invitation_resource_version", "membership_id", "membership_resource_version", "role", "session"];
        const consultant = result?.role === "consultant";
        if (result === undefined || !exactKeys(result, consultant ? [...common, "profile_id", "profile_resource_version"] : common)
          || result.schema_version !== 1 || result.transport !== "web_cookie" || !validOpaque(result.tenant_id)
          || !validVersion(result.invitation_resource_version) || !validOpaque(result.membership_id)
          || !validVersion(result.membership_resource_version) || (result.role !== "admin" && result.role !== "consultant")
          || (consultant && (!validOpaque(result.profile_id) || !validVersion(result.profile_resource_version)))) unavailable();
        return Object.freeze({ session: parseSession(result.session), tenantId: result.tenant_id, role: result.role });
      });
    },
    async signOut() {
      const result = plainRecord(await post("/auth/v1/session/sign-out", { schema_version: 1 }));
      if (result === undefined || !exactKeys(result, ["schema_version", "signed_out"])
        || result.schema_version !== 1 || result.signed_out !== true) unavailable();
    },
    async revokeCurrentSession(input) {
      if (!validOpaque(input.sessionId) || !validVersion(input.expectedResourceVersion)) throw new AuthClientError("invalid", false);
      await withIdempotency("session-revoke", input, async (idempotencyKey) => {
        const facts = {
          schema_version: 1, idempotency_key: idempotencyKey, expected_resource_version: input.expectedResourceVersion,
          session_id: input.sessionId, reason_code: "user_sign_out",
        } as const;
        exactMutationResponse(await post("/auth/v1/sessions/revoke", await protectedBody(facts)), {
          session_id: (value) => value === input.sessionId,
          status: literal("revoked"),
          resource_version: validVersion,
        });
      });
    },
    async reauthenticate(input) {
      assertPassword(input.password);
      const proofDigest = await rawDigest(input.password);
      return withIdempotency("reauthenticate", {
        expected_resource_version: input.sessionResourceVersion, reauthentication_proof_digest: proofDigest,
      }, async (idempotencyKey) => {
        const facts = {
          schema_version: 1, idempotency_key: idempotencyKey,
          expected_resource_version: input.sessionResourceVersion,
          reauthentication_proof_digest: proofDigest,
        } as const;
        const result = plainRecord(await post("/auth/v1/reauthenticate", {
          schema_version: 1, idempotency_key: idempotencyKey, payload_hash: await payloadHash(facts),
          expected_resource_version: input.sessionResourceVersion, password: input.password,
        }));
        if (result === undefined || !exactKeys(result, ["schema_version", "reauthenticated_at", "valid_until", "session_resource_version"])
          || result.schema_version !== 1 || !validUtc(result.reauthenticated_at) || !validUtc(result.valid_until)
          || !validVersion(result.session_resource_version)) unavailable();
        return parseSessionEnvelope(await request("/auth/v1/session", { method: "GET" }));
      });
    },
    async listCompanyMembers(tenantId) {
      if (!validOpaque(tenantId)) throw new AuthClientError("invalid", false);
      const result = plainRecord(await post("/auth/v1/companies/members/list", {
        schema_version: 1, tenant_id: tenantId, limit: 200,
      }));
      if (result === undefined || !exactKeys(result, ["schema_version", "tenant_id", "members", "page_info"])
        || result.schema_version !== 1 || result.tenant_id !== tenantId
        || !Array.isArray(result.members) || result.members.length > 200) unavailable();
      const pageInfo = plainRecord(result.page_info);
      if (pageInfo === undefined || !exactKeys(pageInfo, ["schema_version", "has_more"], ["next_cursor"])
        || pageInfo.schema_version !== 1 || typeof pageInfo.has_more !== "boolean"
        || (pageInfo.next_cursor !== undefined && !validOpaque(pageInfo.next_cursor))) unavailable();
      return Object.freeze(result.members.map(parseMember));
    },
    async inviteCompanyMember(input) {
      const email = normalizedEmail(input.email);
      await withIdempotency("company-member-invite", { tenant_id: input.tenantId, email, role: input.role }, async (idempotencyKey) => {
        const facts = { schema_version: 1, idempotency_key: idempotencyKey, tenant_id: input.tenantId, email, role: input.role } as const;
        exactMutationResponse(await post("/auth/v1/companies/members", await protectedBody(facts)), {
          membership_id: validOpaque,
          membership_resource_version: validVersion,
          invitation_id: validOpaque,
          invitation_resource_version: validVersion,
          invitation_secret: (value) => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value),
        });
      });
    },
    async suspendCompanyMember(input) {
      await withIdempotency("company-member-suspend", input, async (idempotencyKey) => {
        const facts = {
          schema_version: 1, idempotency_key: idempotencyKey, expected_resource_version: input.expectedResourceVersion,
          membership_id: input.membershipId, reason_code: "administrator_suspended",
        } as const;
        exactMutationResponse(await post("/auth/v1/companies/members/suspend", await protectedBody(facts)), {
          membership_id: (value) => value === input.membershipId,
          status: literal("suspended"),
          resource_version: validVersion,
        });
      });
    },
    async revokeCompanyMember(input) {
      await withIdempotency("company-member-revoke", input, async (idempotencyKey) => {
        const facts = {
          schema_version: 1, idempotency_key: idempotencyKey, expected_resource_version: input.expectedResourceVersion,
          membership_id: input.membershipId, reason_code: "administrator_revoked",
        } as const;
        exactMutationResponse(await post("/auth/v1/companies/members/revoke", await protectedBody(facts)), {
          membership_id: (value) => value === input.membershipId,
          status: literal("revoked"),
          resource_version: validVersion,
        });
      });
    },
    async requestAccountDeletion(sessionResourceVersion) {
      return withIdempotency("account-deletion-request", { expected_resource_version: sessionResourceVersion }, async (idempotencyKey) => {
        const facts = {
          schema_version: 1, idempotency_key: idempotencyKey, expected_resource_version: sessionResourceVersion,
          reason_code: "user_requested",
        } as const;
        const result = exactMutationResponse(await post("/auth/v1/account/deletion/request", await protectedBody(facts)), {
          account_deletion_id: validOpaque,
          status: literal("deletion_pending"),
          scheduled_for: validUtc,
          resource_version: validVersion,
        });
        return Object.freeze({
          accountDeletionId: result.account_deletion_id as string,
          scheduledFor: result.scheduled_for as string,
          resourceVersion: result.resource_version as number,
        });
      });
    },
    async cancelAccountDeletion(input) {
      await withIdempotency("account-deletion-cancel", input, async (idempotencyKey) => {
        const facts = {
          schema_version: 1, idempotency_key: idempotencyKey, expected_resource_version: input.expectedResourceVersion,
          account_deletion_id: input.accountDeletionId,
        } as const;
        exactMutationResponse(await post("/auth/v1/account/deletion/cancel", await protectedBody(facts)), {
          account_deletion_id: (value) => value === input.accountDeletionId,
          status: literal("cancelled"),
          resource_version: validVersion,
        });
      });
    },
  };
  return Object.freeze(api);
}
