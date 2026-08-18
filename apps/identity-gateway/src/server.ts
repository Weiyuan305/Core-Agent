import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

import {
  assertSchemaVersion,
  acceptInvitation,
  admitEmailVerificationProviderAttempt,
  authenticateCoreSession,
  beginIdempotentCommand,
  beginEmailVerificationTransaction,
  checkpointEmailVerificationTransaction,
  canonicalPayloadHash,
  constantTimeDigestMatches,
  consumeEmailVerificationTransaction,
  consumePublicRateLimit,
  completeIdempotentCommand,
  createB2bCompany,
  createInvitation,
  createRuntimeDatabase,
  DomainError,
  establishRecentReauthenticationInTransaction,
  finalizeEmailVerificationTransactionStart,
  grantConsultantRole,
  inspectInvitation,
  invitationEmailHmac,
  issueCoreSession,
  lockInvitationByDigest,
  lockInvitationBySecret,
  prepareEmailVerificationTransaction,
  readEmailVerificationProviderRecovery,
  readInvitationBySecret,
  releaseEmailVerificationProviderAttempt,
  registerB2c,
  registerInvitedIdentityForVerifiedInvitation,
  removeConsultantRole,
  requireRecentReauthentication,
  revokeCoreSession,
  revokeCoreSessionInTransaction,
  revokeCoreSessionsInTransaction,
  revokeInvitation,
  suspendMembership,
  withDatabaseTransactionRetry,
  type RuntimeDatabase,
} from "@core-agent/runtime-core";
import type { FastifyInstance } from "fastify";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import { Pool } from "pg";

import { buildIdentityGatewayApp, type GatewayAuthenticatedSession, type IdentityGatewayOperations } from "./app.js";
import { assertManagedSecretFile, loadIdentityGatewayConfig } from "./config.js";
import type { VerifiedProviderSubject } from "./providers/auth-provider.js";
import { SupabaseAuthProvider, type OAuthTransactionRecord, type OAuthTransactionStore, type TransactionProtector } from "./providers/supabase-auth-provider.js";
import { PASSWORD_RESET_SETTLEMENT_SECONDS } from "./security.js";

export interface ProductionIdentityGatewayOptions {
  readonly environment?: NodeJS.ProcessEnv;
}

/** Task 9 owns durable account-deletion services; Task 7 fails these routes closed. */
export const TASK9_ACCOUNT_DELETION_AVAILABLE = false;

async function readManagedSecret(reference: string): Promise<Buffer> {
  const path = assertManagedSecretFile(reference);
  const metadata = await stat(path, { bigint: false });
  if (!metadata.isFile() || metadata.size < 1 || metadata.size > 65_536 || (metadata.mode & 0o077) !== 0) {
    throw new Error("Identity Gateway secret reference is invalid");
  }
  const bytes = await readFile(path);
  if (bytes.byteLength < 1 || bytes.includes(0)) throw new Error("Identity Gateway secret reference is invalid");
  return bytes.at(-1) === 0x0a ? bytes.subarray(0, -1) : bytes;
}

function deriveKey(material: Uint8Array, purpose: string): Buffer {
  if (material.byteLength < 32) throw new Error("Identity Gateway key material is invalid");
  return createHmac("sha256", material).update(`core-agent:identity-gateway:${purpose}:v1`, "utf8").digest();
}

function aesProtector(key: Uint8Array, purpose: string): TransactionProtector {
  const encryptionKey = deriveKey(key, purpose);
  return Object.freeze({
    async encrypt(plaintext: Uint8Array) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
      cipher.setAAD(Buffer.from(`core-agent:${purpose}:v1`, "utf8"));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return Uint8Array.from(Buffer.concat([Buffer.from([1, 0]), iv, cipher.getAuthTag(), ciphertext]));
    },
    async decrypt(ciphertext: Uint8Array) {
      const bytes = Buffer.from(ciphertext);
      if (bytes.byteLength < 31 || bytes[0] !== 1 || bytes[1] !== 0) throw new Error("protected value is invalid");
      const decipher = createDecipheriv("aes-256-gcm", encryptionKey, bytes.subarray(2, 14));
      decipher.setAAD(Buffer.from(`core-agent:${purpose}:v1`, "utf8"));
      decipher.setAuthTag(bytes.subarray(14, 30));
      return Uint8Array.from(Buffer.concat([decipher.update(bytes.subarray(30)), decipher.final()]));
    },
  });
}

function oauthStore(db: Kysely<RuntimeDatabase>): OAuthTransactionStore {
  const recordFromRow = (row: Selectable<RuntimeDatabase["oauth_transactions"]>): OAuthTransactionRecord => Object.freeze({
    oauth_transaction_id: row.oauth_transaction_id, provider: row.provider, flow_kind: row.flow_kind,
    actor_id: row.actor_id, client_kind: row.client_kind, state_digest: row.state_digest,
    nonce_digest: row.nonce_digest, pkce_verifier_ciphertext: row.pkce_verifier_ciphertext,
    redirect_uri: row.redirect_uri, status: "pending", expires_at: row.expires_at.toISOString(),
    provider_completion_status: row.provider_completion_status,
    ...(row.provider_completion_started_at === null ? {} : { provider_completion_started_at: row.provider_completion_started_at.toISOString() }),
    ...(row.expected_provider_subject_ciphertext === null ? {} : { expected_provider_subject_ciphertext: Uint8Array.from(row.expected_provider_subject_ciphertext) }),
    ...(row.provider_subject_ciphertext === null ? {} : { provider_subject_ciphertext: Uint8Array.from(row.provider_subject_ciphertext) }),
    ...(row.provider_completion_payload_hash === null ? {} : { provider_completion_payload_hash: row.provider_completion_payload_hash }),
    ...(row.provider_settlement_expires_at === null ? {} : { provider_settlement_expires_at: row.provider_settlement_expires_at.toISOString() }),
    ...(row.provider_completed_at === null ? {} : { provider_completed_at: row.provider_completed_at.toISOString() }),
    ...(row.provider_evidence_at === null ? {} : { provider_evidence_at: row.provider_evidence_at.toISOString() }),
  });
  const databaseNow = async (): Promise<Date> => {
    const now = (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(db)).rows[0]?.now;
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new DomainError("INTERNAL_ERROR", "OAuth database clock is unavailable");
    return now;
  };
  return Object.freeze({
    async save(record: OAuthTransactionRecord) {
      const now = await databaseNow();
      await db.insertInto("oauth_transactions").values({
        oauth_transaction_id: record.oauth_transaction_id, provider: record.provider,
        flow_kind: record.flow_kind, actor_id: record.actor_id, client_kind: record.client_kind,
        state_digest: record.state_digest, nonce_digest: record.nonce_digest,
        pkce_verifier_ciphertext: record.pkce_verifier_ciphertext, redirect_uri: record.redirect_uri,
        status: "pending", expires_at: new Date(record.expires_at), consumed_at: null,
        provider_completion_status: "pending", provider_completion_started_at: null,
        expected_provider_subject_ciphertext: record.expected_provider_subject_ciphertext ?? null,
        provider_subject_ciphertext: null, provider_completion_payload_hash: null,
        provider_settlement_expires_at: null,
        provider_completed_at: null, provider_evidence_at: null,
        created_at: now, updated_at: now,
      }).execute();
    },
    async consume(transactionId: string) {
      return db.transaction().execute(async (trx) => {
        const now = (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(trx)).rows[0]?.now;
        if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new DomainError("INTERNAL_ERROR", "OAuth database clock is unavailable");
        const row = await trx.selectFrom("oauth_transactions").selectAll()
          .where("oauth_transaction_id", "=", transactionId).forUpdate().executeTakeFirst();
        if (row === undefined || row.status !== "pending" || row.expires_at.getTime() <= now.getTime()) return undefined;
        await trx.updateTable("oauth_transactions").set({ status: "consumed", consumed_at: now, updated_at: now })
          .where("oauth_transaction_id", "=", transactionId).execute();
        return recordFromRow(row);
      });
    },
    async reserveStart(record: OAuthTransactionRecord) {
      const now = await databaseNow();
      const result = await db.insertInto("oauth_transactions").values({
        oauth_transaction_id: record.oauth_transaction_id, provider: record.provider,
        flow_kind: record.flow_kind, actor_id: record.actor_id, client_kind: record.client_kind,
        state_digest: record.state_digest, nonce_digest: record.nonce_digest,
        pkce_verifier_ciphertext: record.pkce_verifier_ciphertext, redirect_uri: record.redirect_uri,
        status: "pending", expires_at: new Date(record.expires_at), consumed_at: null,
        provider_completion_status: "pending", provider_completion_started_at: null,
        expected_provider_subject_ciphertext: record.expected_provider_subject_ciphertext ?? null,
        provider_subject_ciphertext: null, provider_completion_payload_hash: null,
        provider_settlement_expires_at: null,
        provider_completed_at: null, provider_evidence_at: null,
        created_at: now, updated_at: now,
      }).onConflict((conflict) => conflict.column("oauth_transaction_id").doNothing()).executeTakeFirst();
      return result.numInsertedOrUpdatedRows === 1n;
    },
    async completeStart(record: OAuthTransactionRecord) {
      const now = await databaseNow();
      const result = await db.updateTable("oauth_transactions").set({
        state_digest: record.state_digest, nonce_digest: record.nonce_digest,
        pkce_verifier_ciphertext: record.pkce_verifier_ciphertext,
        expected_provider_subject_ciphertext: record.expected_provider_subject_ciphertext ?? null,
        redirect_uri: record.redirect_uri, expires_at: new Date(record.expires_at), updated_at: now,
      }).where("oauth_transaction_id", "=", record.oauth_transaction_id)
        .where("status", "=", "pending").executeTakeFirst();
      if (result.numUpdatedRows !== 1n) throw new DomainError("IDEMPOTENCY_CONFLICT", "OAuth start reservation changed");
    },
    async loadStart(transactionId: string) {
      const row = await db.selectFrom("oauth_transactions").selectAll()
        .where("oauth_transaction_id", "=", transactionId).where("status", "=", "pending").executeTakeFirst();
      return row === undefined ? undefined : recordFromRow(row);
    },
    async beginPasswordResetCompletion(input: {
      readonly transactionId: string; readonly payloadHash: string; readonly settlementNotAfter: string;
    }) {
      return db.transaction().execute(async (trx) => {
        const now = (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(trx)).rows[0]?.now;
        const settlementNotAfter = new Date(input.settlementNotAfter);
        if (!(now instanceof Date) || !Number.isFinite(now.getTime())
          || !Number.isFinite(settlementNotAfter.getTime()) || settlementNotAfter.toISOString() !== input.settlementNotAfter) {
          throw new DomainError("INTERNAL_ERROR", "OAuth database clock is unavailable");
        }
        const row = await trx.selectFrom("oauth_transactions").selectAll()
          .where("oauth_transaction_id", "=", input.transactionId).forUpdate().executeTakeFirst();
        if (row === undefined || row.flow_kind !== "password_reset" || row.status !== "pending"
          || settlementNotAfter.getTime() !== row.expires_at.getTime() + PASSWORD_RESET_SETTLEMENT_SECONDS * 1_000) {
          throw new DomainError("UNAUTHENTICATED", "Password reset authority is invalid");
        }
        if (row.provider_completion_status === "provider_started") {
          if (row.provider_completion_started_at === null || row.provider_subject_ciphertext === null
            || row.provider_completion_payload_hash !== input.payloadHash
            || row.provider_settlement_expires_at === null
            || row.provider_settlement_expires_at.getTime() <= now.getTime()) {
            throw new DomainError("UNAUTHENTICATED", "Password reset checkpoint conflicts");
          }
          return {
            kind: "existing" as const,
            startedAt: row.provider_completion_started_at.toISOString(),
            settlementExpiresAt: row.provider_settlement_expires_at.toISOString(),
          };
        }
        if (row.provider_completion_status !== "pending" || row.expected_provider_subject_ciphertext === null
          || row.expires_at.getTime() <= now.getTime()) {
          throw new DomainError("IDEMPOTENCY_CONFLICT", "Password reset provider completion changed");
        }
        const settlementExpiresAt = new Date(now.getTime() + PASSWORD_RESET_SETTLEMENT_SECONDS * 1_000);
        await trx.updateTable("oauth_transactions").set({
          provider_completion_status: "provider_started", provider_completion_started_at: now,
          provider_subject_ciphertext: row.expected_provider_subject_ciphertext,
          provider_completion_payload_hash: input.payloadHash,
          provider_settlement_expires_at: settlementExpiresAt, updated_at: now,
        }).where("oauth_transaction_id", "=", input.transactionId).executeTakeFirstOrThrow();
        return { kind: "acquired" as const, startedAt: now.toISOString(), settlementExpiresAt: settlementExpiresAt.toISOString() };
      });
    },
    async checkpointPasswordResetCompletion(input: { readonly transactionId: string; readonly providerEvidenceAt: string }) {
      await db.transaction().execute(async (trx) => {
        const now = (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(trx)).rows[0]?.now;
        const evidenceAt = new Date(input.providerEvidenceAt);
        if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || !Number.isFinite(evidenceAt.getTime())) {
          throw new DomainError("INTERNAL_ERROR", "Password reset checkpoint clock is invalid");
        }
        const row = await trx.selectFrom("oauth_transactions").selectAll()
          .where("oauth_transaction_id", "=", input.transactionId).forUpdate().executeTakeFirst();
        if (row === undefined || row.flow_kind !== "password_reset" || row.status !== "pending"
          || row.provider_completion_started_at === null || row.provider_subject_ciphertext === null
          || row.provider_settlement_expires_at === null || row.provider_settlement_expires_at.getTime() <= now.getTime()
          || evidenceAt.getTime() < row.provider_completion_started_at.getTime()
          || evidenceAt.getTime() > now.getTime()) throw new DomainError("UNAUTHENTICATED", "Password reset checkpoint evidence is invalid");
        if (row.provider_completion_status === "provider_completed") return;
        if (row.provider_completion_status !== "provider_started") throw new DomainError("UNAUTHENTICATED", "Password reset checkpoint is invalid");
        await trx.updateTable("oauth_transactions").set({
          provider_completion_status: "provider_completed", provider_completed_at: now,
          provider_evidence_at: evidenceAt, updated_at: now,
        }).where("oauth_transaction_id", "=", input.transactionId).executeTakeFirstOrThrow();
      });
    },
  });
}

function sessionView(session: Record<string, unknown>, actorResourceVersion: number) {
  const reauthenticatedAt = typeof session.reauthenticated_at === "string" ? Date.parse(session.reauthenticated_at) : Number.NaN;
  return Object.freeze({
    schema_version: 1 as const, actor_id: String(session.actor_id), actor_resource_version: actorResourceVersion,
    session_id: String(session.session_id), session_resource_version: Number(session.resource_version),
    client_kind: session.client_kind as "web" | "iphone" | "macos",
    idle_expires_at: String(session.idle_expires_at), absolute_expires_at: String(session.absolute_expires_at),
    reauthentication_required: !Number.isFinite(reauthenticatedAt) || Date.now() - reauthenticatedAt >= 10 * 60 * 1_000,
  });
}

function authorityInput(authority: GatewayAuthenticatedSession) {
  return { actorId: authority.actorId, authSubjectId: authority.authSubjectId, sessionId: String(authority.session.session_id) };
}

function derivedId(prefix: string, key: string): string {
  return `${prefix}_${createHmac("sha256", "core-agent:identity-gateway:id:v1").update(key, "utf8").digest("hex").slice(0, 32)}`;
}

function internalCommand<T extends Record<string, unknown>>(payload: T): T & { readonly payload_hash: string } {
  return { ...payload, payload_hash: canonicalPayloadHash(payload) };
}

function commandContext(actorId: string, tenantId?: string) {
  return {
    ...(tenantId === undefined ? {} : { tenantId }), actorId,
    requestId: `request_${randomUUID()}`, traceId: `trace_${randomUUID()}`,
  };
}

async function resolveCompanyTenant(
  trx: Transaction<RuntimeDatabase>, actorId: string, membershipId: string,
): Promise<string> {
  const rows = await sql<{ tenant_id: string }>`
    select administrator.tenant_id
    from memberships administrator
    join memberships target on target.tenant_id = administrator.tenant_id
    join tenants company on company.tenant_id = administrator.tenant_id
    where administrator.actor_id = ${actorId}
      and administrator.membership_source = 'company'
      and administrator.status = 'active'
      and administrator.roles @> array['admin']::text[]
      and company.tenant_mode = 'b2b'
      and company.status = 'active'
      and target.membership_id = ${membershipId}
    order by administrator.tenant_id
    limit 2
  `.execute(trx);
  if (rows.rows.length !== 1) throw new DomainError("UNAUTHENTICATED", "Company authority is ambiguous or unavailable");
  return rows.rows[0]!.tenant_id;
}

async function requireCompanyAdminForTenant(
  trx: Transaction<RuntimeDatabase>, actorId: string, tenantId: string,
): Promise<void> {
  const authority = await trx.selectFrom("memberships")
    .innerJoin("tenants", "tenants.tenant_id", "memberships.tenant_id")
    .select("memberships.membership_id")
    .where("memberships.actor_id", "=", actorId)
    .where("memberships.tenant_id", "=", tenantId)
    .where("memberships.membership_source", "=", "company")
    .where("memberships.status", "=", "active")
    .where("memberships.roles", "@>", sql<string[]>`array['admin']::text[]`)
    .where("tenants.tenant_mode", "=", "b2b")
    .where("tenants.status", "=", "active")
    .executeTakeFirst();
  if (authority === undefined) throw new DomainError("UNAUTHENTICATED", "Active company administrator authority is required");
}

function providerIdentityKindAccepts(
  verifiedKind: VerifiedProviderSubject["identityKind"],
  storedKind: "email_password" | "apple" | "email_password_apple",
): boolean {
  return verifiedKind === "email_password"
    ? storedKind === "email_password" || storedKind === "email_password_apple"
    : storedKind === "apple" || storedKind === "email_password_apple";
}

function productionOperations(db: Kysely<RuntimeDatabase>, piiKey: Uint8Array, piiProtector: TransactionProtector): IdentityGatewayOperations {
  const verificationDependencies = { db, hmacKey: piiKey, protector: aesProtector(piiKey, "email-verification") };
  const unavailable = (): never => { throw new DomainError("DEPENDENCY_UNAVAILABLE", "Identity operation is unavailable", true); };
  const issueSessionInTransaction = async (
    trx: Transaction<RuntimeDatabase>,
    subject: Parameters<IdentityGatewayOperations["issueSession"]>[0],
    clientKind: Parameters<IdentityGatewayOperations["issueSession"]>[1],
    deviceLabel: string | undefined,
    idempotency: NonNullable<Parameters<IdentityGatewayOperations["issueSession"]>[3]>,
  ) => {
    const subjectRow = await trx.selectFrom("auth_subjects").select(["auth_subject_id", "actor_id", "provider_identity_kind"])
      .where("provider", "=", subject.provider).where("provider_subject", "=", subject.providerSubject)
      .where("status", "=", "active").executeTakeFirst();
    if (subjectRow === undefined) throw new DomainError("UNAUTHENTICATED", "Verified subject is not registered");
    if (!providerIdentityKindAccepts(subject.identityKind, subjectRow.provider_identity_kind)) {
      throw new DomainError("UNAUTHENTICATED", "Verified authentication method is not linked");
    }
    const actor = await trx.selectFrom("actors").select("resource_version")
      .where("actor_id", "=", subjectRow.actor_id).executeTakeFirstOrThrow();
    const membership = await trx.selectFrom("memberships").select("tenant_id")
      .where("actor_id", "=", subjectRow.actor_id).where("status", "=", "active")
      .orderBy("tenant_id").executeTakeFirst();
    if (membership === undefined) throw new DomainError("UNAUTHENTICATED", "Active Session tenant authority is unavailable");
    const now = (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(trx)).rows[0]?.now;
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new DomainError("INTERNAL_ERROR", "Session database clock is unavailable");
    const context = { tenantId: membership.tenant_id, trx };
    const admission = await beginIdempotentCommand(context, {
      key: idempotency.idempotencyKey, payloadHash: idempotency.payloadHash,
      operation: `identity.session.${idempotency.operation}`, now,
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000),
    });
    if (admission.kind !== "acquired") throw new DomainError("IDEMPOTENCY_CONFLICT", "Session issuance was already completed");
    const issued = await issueCoreSession({ db, transaction: trx }, {
      sessionId: `session_${randomUUID()}`, actorId: subjectRow.actor_id,
      authSubjectId: subjectRow.auth_subject_id, clientKind,
      ...(deviceLabel === undefined ? {} : { deviceLabel }),
    });
    const view = sessionView(issued.session as unknown as Record<string, unknown>, Number(actor.resource_version));
    await completeIdempotentCommand(context, {
      key: idempotency.idempotencyKey, payloadHash: idempotency.payloadHash,
      operation: `identity.session.${idempotency.operation}`, resultRef: String(view.session_id),
      response: { schema_version: 1, session_id: view.session_id }, updatedAt: now,
    });
    return { session: view, sessionSecret: issued.sessionSecret, ...(issued.csrfSecret === undefined ? {} : { csrfSecret: issued.csrfSecret }) };
  };
  return Object.freeze({
    async consumeRateLimit(input) {
      return consumePublicRateLimit({ db, hmacKey: piiKey }, { ...input, limit: 20, windowMs: 15 * 60 * 1_000 });
    },
    async preparePasswordReset(normalizedEmail) {
      const emailHmac = invitationEmailHmac(piiKey, normalizedEmail);
      try {
        const subject = await db.selectFrom("private_identity_pii")
          .innerJoin("auth_subjects", "auth_subjects.actor_id", "private_identity_pii.actor_id")
          .select(["auth_subjects.provider_subject", "auth_subjects.provider_identity_kind", "auth_subjects.verified_at"])
          .where("private_identity_pii.normalized_email_hmac", "=", emailHmac)
          .where("auth_subjects.provider", "=", "supabase")
          .where("auth_subjects.status", "=", "active")
          .where("auth_subjects.provider_identity_kind", "in", ["email_password", "email_password_apple"])
          .orderBy("auth_subjects.auth_subject_id")
          .executeTakeFirst();
        if (subject !== undefined) {
          return Object.freeze({
            provider: "supabase" as const, providerSubject: subject.provider_subject,
            identityKind: "email_password" as const, normalizedEmail,
            verifiedAt: subject.verified_at.toISOString(),
          });
        }
        return Object.freeze({
          provider: "supabase" as const,
          providerSubject: `unregistered_${emailHmac.toString("base64url")}`,
          identityKind: "email_password" as const, normalizedEmail,
          verifiedAt: "1970-01-01T00:00:00.000Z",
        });
      } finally {
        emailHmac.fill(0);
      }
    },
    async beginEmailVerification(input) {
      if (input.invitationSecret === undefined) {
        const begun = await beginEmailVerificationTransaction(verificationDependencies, { ...input, flow: { kind: "b2c" } });
        if (begun.kind === "expired") throw new DomainError("UNAUTHENTICATED", "Email verification authority is invalid");
        return begun;
      }
      const inspected = await inspectInvitation({ db }, input.invitationSecret);
      const begun = await db.transaction().execute(async (trx) => {
        // Canonical unauthenticated lock order: Tenant -> Invitation -> verification transaction.
        const tenant = await trx.selectFrom("tenants").select(["tenant_mode", "status"])
          .where("tenant_id", "=", inspected.tenant_id).forUpdate().executeTakeFirst();
        if (tenant?.tenant_mode !== "b2b" || tenant.status !== "active") {
          throw new DomainError("RESOURCE_NOT_FOUND", "Invitation was not found");
        }
        const invitation = await lockInvitationBySecret(trx, input.invitationSecret!);
        const now = (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(trx)).rows[0]?.now;
        const observedEmail = invitationEmailHmac(piiKey, input.normalizedEmail);
        try {
          if (!(now instanceof Date) || invitation.invitationId !== inspected.invitation_id
            || invitation.tenantId !== inspected.tenant_id || invitation.status !== "pending"
            || invitation.expiresAt.getTime() <= now.getTime()
            || !constantTimeDigestMatches(observedEmail, invitation.normalizedEmailHmac)) {
            throw new DomainError("RESOURCE_NOT_FOUND", "Invitation was not found");
          }
          const secretBytes = Buffer.from(input.invitationSecret!, "base64url");
          const invitationSecretDigest = createHash("sha256").update(secretBytes).digest("base64url");
          secretBytes.fill(0);
          return beginEmailVerificationTransaction({ ...verificationDependencies, transaction: trx }, {
            idempotencyKey: input.idempotencyKey,
            payloadHash: input.payloadHash,
            normalizedEmail: input.normalizedEmail,
            clientKind: input.clientKind,
            ...(input.deviceLabel === undefined ? {} : { deviceLabel: input.deviceLabel }),
            flow: {
              kind: "invitation",
              invitationId: invitation.invitationId,
              tenantId: invitation.tenantId,
              invitationSecretDigest,
              expectedResourceVersion: invitation.resourceVersion,
              role: invitation.role,
            },
          });
        } finally {
          observedEmail.fill(0);
        }
      });
      if (begun.kind === "expired") throw new DomainError("UNAUTHENTICATED", "Email verification authority is invalid");
      return begun;
    },
    async finalizeEmailVerificationStart(input) {
      await finalizeEmailVerificationTransactionStart(verificationDependencies, input);
    },
    async prepareEmailVerification(input) {
      return prepareEmailVerificationTransaction(verificationDependencies, input);
    },
    async admitEmailVerificationProviderAttempt(input) {
      return admitEmailVerificationProviderAttempt(verificationDependencies, input);
    },
    async readEmailVerificationProviderRecovery(input) {
      return readEmailVerificationProviderRecovery(verificationDependencies, input);
    },
    async releaseEmailVerificationProviderAttempt(input) {
      await releaseEmailVerificationProviderAttempt(verificationDependencies, input);
    },
    async checkpointEmailVerification(input) {
      await checkpointEmailVerificationTransaction(verificationDependencies, input);
    },
    async completeEmailVerification(input) {
      const prepared = await prepareEmailVerificationTransaction(
        verificationDependencies, { verificationId: input.verificationId },
      );
      if (prepared.providerVerification.kind !== "verified") {
        throw new DomainError("UNAUTHENTICATED", "Provider verification checkpoint is required");
      }
      const completion = await withDatabaseTransactionRetry(db, async (trx) => {
        if (prepared.flowKind === "invitation") {
          if (prepared.tenantId === undefined || prepared.invitationId === undefined
            || prepared.invitationSecretDigest === undefined || prepared.expectedResourceVersion === undefined
            || prepared.role === undefined) {
            throw new DomainError("INTERNAL_ERROR", "Verified invitation binding is incomplete");
          }
          // New invited Actors do not exist yet; canonical lock order is Tenant -> Invitation -> verification.
          const tenant = await trx.selectFrom("tenants").select(["tenant_mode", "status"])
            .where("tenant_id", "=", prepared.tenantId).forUpdate().executeTakeFirst();
          if (tenant?.tenant_mode !== "b2b" || tenant.status !== "active") {
            throw new DomainError("UNAUTHENTICATED", "Verified invitation authority is unavailable");
          }
          const secretDigest = Buffer.from(prepared.invitationSecretDigest, "base64url");
          try {
            const invitation = await lockInvitationByDigest(trx, secretDigest);
            if (invitation.invitationId !== prepared.invitationId || invitation.tenantId !== prepared.tenantId
              || invitation.resourceVersion !== prepared.expectedResourceVersion || invitation.role !== prepared.role) {
              throw new DomainError("UNAUTHENTICATED", "Verified invitation authority is unavailable");
            }
          } finally {
            secretDigest.fill(0);
          }
        }
        const binding = await consumeEmailVerificationTransaction({ ...verificationDependencies, transaction: trx }, input);
        if ("kind" in binding) return binding;
        if (binding.flowKind !== prepared.flowKind || binding.normalizedEmail !== prepared.normalizedEmail
          || binding.clientKind !== prepared.clientKind || binding.invitationId !== prepared.invitationId
          || binding.tenantId !== prepared.tenantId || binding.expectedResourceVersion !== prepared.expectedResourceVersion) {
          throw new DomainError("UNAUTHENTICATED", "Email verification binding changed");
        }
        const context = { requestId: `request_${randomUUID()}`, traceId: `trace_${randomUUID()}` };
        const privatePii = {
          normalizedEmailHmacKey: piiKey, encryptionKeyRef: "identity-pii-v1",
          encryptNormalizedEmail: (email: string) => piiProtector.encrypt(Buffer.from(email, "utf8")),
        };
        let registration: { actor_id: string; auth_subject_id: string };
        if (binding.flowKind === "b2c") {
          const commandWithoutHash = {
            schema_version: 1 as const,
            idempotency_key: `email-verification:${input.verificationId}:register-b2c`,
            auth_subject: binding.verifiedSubject,
            display_name: "学生用户",
          };
          registration = await registerB2c({
            db, transaction: trx,
            defaultProfile: { providerConfigId: "identity-default", modelId: "identity-default" },
            privatePii,
          }, context, { ...commandWithoutHash, payload_hash: canonicalPayloadHash(commandWithoutHash) });
        } else {
          if (binding.invitationId === undefined || binding.tenantId === undefined
            || binding.invitationSecretDigest === undefined || binding.expectedResourceVersion === undefined
            || binding.role === undefined) {
            throw new DomainError("INTERNAL_ERROR", "Verified invitation binding is incomplete");
          }
          const registrationPayload = {
            schema_version: 1 as const,
            idempotency_key: `email-verification:${input.verificationId}:register-invited`,
            tenant_id: binding.tenantId,
            auth_subject: binding.verifiedSubject,
            display_name: "受邀用户",
          };
          const registrationSecretDigest = Buffer.from(binding.invitationSecretDigest, "base64url");
          try {
            registration = await registerInvitedIdentityForVerifiedInvitation({
              db, transaction: trx, privatePii,
              verifiedInvitationBinding: {
                invitationId: binding.invitationId, tenantId: binding.tenantId,
                secretDigest: registrationSecretDigest, expectedResourceVersion: binding.expectedResourceVersion,
                role: binding.role,
              },
            }, context, {
              ...registrationPayload, payload_hash: canonicalPayloadHash(registrationPayload),
            });
          } finally {
            registrationSecretDigest.fill(0);
          }
          const acceptPayload = {
            schema_version: 1 as const,
            idempotency_key: `email-verification:${input.verificationId}:accept-invitation`,
            tenant_id: binding.tenantId,
            invitation_code: "",
            expected_resource_version: binding.expectedResourceVersion,
          };
          const secretDigest = Buffer.from(binding.invitationSecretDigest, "base64url");
          try {
            await acceptInvitation({
              db,
              transaction: trx,
              emailHmacKey: piiKey,
              consultantProfile: { providerConfigId: "identity-default", modelId: "identity-default" },
              verifiedInvitationBinding: {
                invitationId: binding.invitationId,
                secretDigest,
                tenantId: binding.tenantId,
                expectedResourceVersion: binding.expectedResourceVersion,
                role: binding.role,
              },
            }, { ...context, actorId: registration.actor_id, normalizedEmail: binding.verifiedSubject.normalizedEmail }, {
              ...acceptPayload, payload_hash: canonicalPayloadHash(acceptPayload),
            });
          } finally {
            secretDigest.fill(0);
          }
        }
        const sessionPayload = {
          schema_version: 1 as const,
          verification_id: input.verificationId,
          actor_id: registration.actor_id,
          client_kind: binding.clientKind,
          ...(binding.deviceLabel === undefined ? {} : { device_label: binding.deviceLabel }),
        };
        const issuedSession = await issueSessionInTransaction(trx, binding.verifiedSubject, binding.clientKind, binding.deviceLabel, {
          idempotencyKey: `email-verification:${input.verificationId}:issue-session`,
          payloadHash: canonicalPayloadHash(sessionPayload),
          operation: "email_verification",
        });
        return { actorId: registration.actor_id, authSubjectId: registration.auth_subject_id, clientKind: binding.clientKind, ...(binding.deviceLabel === undefined ? {} : { deviceLabel: binding.deviceLabel }), issuedSession };
      }, { isolationLevel: "serializable" });
      if ("kind" in completion) throw new DomainError("UNAUTHENTICATED", "Email verification expired");
      return completion;
    },
    async issueSession(subject, clientKind, deviceLabel, idempotency) {
      if (idempotency === undefined) throw new DomainError("INVALID_REQUEST", "Session issuance idempotency is required");
      return withDatabaseTransactionRetry(db, async (trx) => {
        let subjectRow = await trx.selectFrom("auth_subjects").select(["auth_subject_id", "actor_id", "provider_identity_kind"])
          .where("provider", "=", subject.provider).where("provider_subject", "=", subject.providerSubject)
          .where("status", "=", "active").executeTakeFirst();
        if (subjectRow === undefined && idempotency.operation === "apple_sign_in") {
          const registrationPayload = {
            schema_version: 1 as const,
            idempotency_key: derivedId("idem_apple_registration", idempotency.idempotencyKey),
            auth_subject: subject,
            display_name: "Apple 用户",
          };
          await registerB2c({
            db, transaction: trx,
            defaultProfile: { providerConfigId: "identity-default", modelId: "identity-default" },
            privatePii: {
              normalizedEmailHmacKey: piiKey, encryptionKeyRef: "identity-pii-v1",
              encryptNormalizedEmail: (email: string) => piiProtector.encrypt(Buffer.from(email, "utf8")),
            },
          }, { requestId: `request_${randomUUID()}`, traceId: `trace_${randomUUID()}` }, {
            ...registrationPayload, payload_hash: canonicalPayloadHash(registrationPayload),
          });
          subjectRow = await trx.selectFrom("auth_subjects").select(["auth_subject_id", "actor_id", "provider_identity_kind"])
            .where("provider", "=", subject.provider).where("provider_subject", "=", subject.providerSubject)
            .where("status", "=", "active").executeTakeFirst();
        }
        if (subjectRow === undefined) throw new DomainError("UNAUTHENTICATED", "Verified subject is not registered");
        if (!providerIdentityKindAccepts(subject.identityKind, subjectRow.provider_identity_kind)) {
          throw new DomainError("UNAUTHENTICATED", "Verified authentication method is not linked");
        }
        const actor = await trx.selectFrom("actors").select("resource_version")
          .where("actor_id", "=", subjectRow.actor_id).executeTakeFirstOrThrow();
        const membership = await trx.selectFrom("memberships").select("tenant_id")
          .where("actor_id", "=", subjectRow.actor_id).where("status", "=", "active")
          .orderBy("tenant_id").executeTakeFirst();
        if (membership === undefined) throw new DomainError("UNAUTHENTICATED", "Active Session tenant authority is unavailable");
        const now = (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(trx)).rows[0]?.now;
        if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new DomainError("INTERNAL_ERROR", "Session database clock is unavailable");
        const context = { tenantId: membership.tenant_id, trx };
        const admission = await beginIdempotentCommand(context, {
          key: idempotency.idempotencyKey, payloadHash: idempotency.payloadHash,
          operation: `identity.session.${idempotency.operation}`, now,
          expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000),
        });
        if (admission.kind !== "acquired") {
          throw new DomainError("IDEMPOTENCY_CONFLICT", "Session issuance was already completed");
        }
        const issued = await issueCoreSession({ db, transaction: trx }, {
          sessionId: `session_${randomUUID()}`, actorId: subjectRow.actor_id,
          authSubjectId: subjectRow.auth_subject_id, clientKind,
          ...(deviceLabel === undefined ? {} : { deviceLabel }),
        });
        const view = sessionView(issued.session as unknown as Record<string, unknown>, Number(actor.resource_version));
        await completeIdempotentCommand(context, {
          key: idempotency.idempotencyKey, payloadHash: idempotency.payloadHash,
          operation: `identity.session.${idempotency.operation}`, resultRef: String(view.session_id),
          response: { schema_version: 1, session_id: view.session_id }, updatedAt: now,
        });
        return { session: view, sessionSecret: issued.sessionSecret, ...(issued.csrfSecret === undefined ? {} : { csrfSecret: issued.csrfSecret }) };
      }, { isolationLevel: "serializable" });
    },
    async authenticateSession(input) {
      const authenticated = await authenticateCoreSession({ db }, {
        ...input,
        advanceActivity: input.advanceActivity ?? false,
      });
      const actor = await db.selectFrom("actors").select("resource_version").where("actor_id", "=", authenticated.authSubject.actorId).executeTakeFirstOrThrow();
      return { actorId: authenticated.authSubject.actorId, authSubjectId: authenticated.authSubject.authSubjectId, session: sessionView(authenticated.session as unknown as Record<string, unknown>, Number(actor.resource_version)) };
    },
    async requireRecentReauthentication(authority) {
      await db.transaction().execute((trx) => requireRecentReauthentication({ trx }, authorityInput(authority)));
    },
    async loadNormalizedEmail(authority) {
      const row = await db.selectFrom("private_identity_pii").select("encrypted_email").where("actor_id", "=", authority.actorId).executeTakeFirst();
      if (row === undefined) throw new DomainError("UNAUTHENTICATED", "Private identity projection is unavailable");
      return Buffer.from(await piiProtector.decrypt(row.encrypted_email)).toString("utf8");
    },
    async executeAuthorityCommand(input) {
      if (input.kind === "session_inspect") {
        if (input.authority === undefined) throw new DomainError("UNAUTHENTICATED", "Session authority is required");
        const payload = input.payload as { session_id: string };
        if (payload.session_id !== input.authority.session.session_id) {
          throw new DomainError("RESOURCE_NOT_FOUND", "Session was not found");
        }
        return { schema_version: 1, session: input.authority.session };
      }
      if (input.kind === "session_sign_out" && input.authority !== undefined) {
        await revokeCoreSession({ db }, { actorId: input.authority.actorId, sessionId: String(input.authority.session.session_id), reason: "user_sign_out" });
        return { schema_version: 1 };
      }
      if (input.kind === "reauthenticate" && input.authority !== undefined && input.verifiedSubject !== undefined) {
        const payload = input.payload as {
          schema_version: 1;
          idempotency_key: string;
          payload_hash: string;
          expected_resource_version: number;
          reauthentication_proof_digest: string;
          client_kind?: "web" | "iphone" | "macos";
        };
        const { payload_hash: suppliedHash, ...canonicalPayload } = payload;
        const computedHash = canonicalPayloadHash(canonicalPayload);
        if (suppliedHash !== computedHash) {
          throw new DomainError("INVALID_REQUEST", "Reauthentication payload hash is invalid");
        }
        return withDatabaseTransactionRetry(db, async (trx) => {
          const tenant = await trx.selectFrom("memberships").select("tenant_id")
            .where("actor_id", "=", input.authority!.actorId).where("status", "=", "active")
            .orderBy("tenant_id").executeTakeFirst();
          if (tenant === undefined) throw new DomainError("UNAUTHENTICATED", "Active reauthentication tenant authority is unavailable");
          const now = (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(trx)).rows[0]?.now;
          if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new DomainError("INTERNAL_ERROR", "Reauthentication database clock is unavailable");
          const context = { tenantId: tenant.tenant_id, trx };
          const operation = "identity.reauthenticate";
          const admission = await beginIdempotentCommand(context, {
            key: payload.idempotency_key, payloadHash: computedHash, operation, now,
            expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000),
          });
          if (admission.kind === "replay") return admission.response;
          if (admission.kind === "in_progress") throw new DomainError("IDEMPOTENCY_CONFLICT", "Reauthentication is already in progress");
          const response = await establishRecentReauthenticationInTransaction({ trx }, {
            ...authorityInput(input.authority!),
            verifiedPasswordSubject: input.verifiedSubject!,
            expectedResourceVersion: payload.expected_resource_version,
          });
          await completeIdempotentCommand(context, {
            key: payload.idempotency_key, payloadHash: computedHash, operation,
            resultRef: String(input.authority!.session.session_id), response, updatedAt: now,
          });
          return response;
        }, { isolationLevel: "serializable" });
      }
      if (input.kind === "invitation_inspect") {
        const payload = input.payload as { invitation_secret: string };
        const inspected = await inspectInvitation({ db }, payload.invitation_secret);
        const version = await db.selectFrom("identity_invitations").select("resource_version")
          .where("invitation_id", "=", inspected.invitation_id).executeTakeFirstOrThrow();
        return { schema_version: 1, invitation_id: inspected.invitation_id, tenant_id: inspected.tenant_id, role: inspected.role, status: "pending", expires_at: inspected.expires_at, resource_version: Number(version.resource_version) };
      }
      if (input.kind === "invitation_accept" && input.verifiedSubject !== undefined) {
        const payload = input.payload as {
          schema_version: 1;
          idempotency_key: string;
          payload_hash: string;
          invitation_secret: string;
          expected_resource_version: number;
          client_kind: "web" | "iphone" | "macos";
          device_label?: string;
        };
        const inspected = await db.transaction().execute((trx) => readInvitationBySecret(trx, payload.invitation_secret));
        return withDatabaseTransactionRetry(db, async (trx) => {
          let subject = await trx.selectFrom("auth_subjects").select(["actor_id", "auth_subject_id"])
            .where("provider", "=", input.verifiedSubject!.provider)
            .where("provider_subject", "=", input.verifiedSubject!.providerSubject)
            .where("status", "=", "active").executeTakeFirst();
          let verifiedInvitationBinding: {
            invitationId: string; secretDigest: Buffer; tenantId: string;
            expectedResourceVersion: number; role: "admin" | "consultant";
          } | undefined;
          if (subject === undefined) {
            const tenant = await trx.selectFrom("tenants").select(["tenant_mode", "status"])
              .where("tenant_id", "=", inspected.tenantId).forUpdate().executeTakeFirst();
            if (tenant?.tenant_mode !== "b2b" || tenant.status !== "active") {
              throw new DomainError("UNAUTHENTICATED", "Invitation authority is unavailable");
            }
            const invitation = await lockInvitationBySecret(trx, payload.invitation_secret);
            if (invitation.invitationId !== inspected.invitationId || invitation.tenantId !== inspected.tenantId
              || invitation.resourceVersion !== payload.expected_resource_version || invitation.role !== inspected.role) {
              throw new DomainError("UNAUTHENTICATED", "Invitation authority is unavailable");
            }
            const secretBytes = Buffer.from(payload.invitation_secret, "base64url");
            const secretDigest = createHash("sha256").update(secretBytes).digest();
            secretBytes.fill(0);
            verifiedInvitationBinding = {
              invitationId: invitation.invitationId, tenantId: invitation.tenantId, secretDigest,
              expectedResourceVersion: invitation.resourceVersion, role: invitation.role,
            };
            const registrationPayload = {
              schema_version: 1 as const,
              idempotency_key: derivedId("idem_apple_invited_registration", payload.idempotency_key),
              tenant_id: invitation.tenantId,
              auth_subject: input.verifiedSubject!,
              display_name: "Apple 受邀用户",
            };
            try {
              const registered = await registerInvitedIdentityForVerifiedInvitation({
                db, transaction: trx,
                privatePii: {
                  normalizedEmailHmacKey: piiKey, encryptionKeyRef: "identity-pii-v1",
                  encryptNormalizedEmail: (email: string) => piiProtector.encrypt(Buffer.from(email, "utf8")),
                },
                verifiedInvitationBinding,
              }, { requestId: `request_${randomUUID()}`, traceId: `trace_${randomUUID()}` }, {
                ...registrationPayload, payload_hash: canonicalPayloadHash(registrationPayload),
              });
              subject = { actor_id: registered.actor_id, auth_subject_id: registered.auth_subject_id };
            } catch (error) {
              secretDigest.fill(0);
              throw error;
            }
          }
          if (subject === undefined) throw new DomainError("UNAUTHENTICATED", "Invitation subject is not registered");
          try {
            const acceptCommand = internalCommand({
              schema_version: 1 as const,
              idempotency_key: derivedId("idem_invitation_accept", payload.idempotency_key),
              tenant_id: inspected.tenantId,
              invitation_code: payload.invitation_secret,
              expected_resource_version: payload.expected_resource_version,
            });
            const accepted = await acceptInvitation({
              db, transaction: trx, emailHmacKey: piiKey,
              consultantProfile: { providerConfigId: "identity-default", modelId: "identity-default" },
              ...(verifiedInvitationBinding === undefined ? {} : { verifiedInvitationBinding }),
            }, { ...commandContext(subject.actor_id), normalizedEmail: input.verifiedSubject!.normalizedEmail }, acceptCommand);
            const sessionPayload = {
              schema_version: 1 as const,
              actor_id: subject.actor_id,
              client_kind: payload.client_kind,
              invitation_id: accepted.invitation_id,
              ...(payload.device_label === undefined ? {} : { device_label: payload.device_label }),
            };
            const issuedSession = await issueSessionInTransaction(
              trx, input.verifiedSubject!, payload.client_kind, payload.device_label,
              {
                idempotencyKey: derivedId("idem_invitation_session", payload.idempotency_key),
                payloadHash: canonicalPayloadHash(sessionPayload),
                operation: "invitation_accept",
              },
            );
            return {
              schema_version: 1, tenant_id: accepted.tenant_id,
              invitation_resource_version: accepted.invitation_resource_version,
              membership_id: accepted.membership_id, membership_resource_version: accepted.membership_resource_version,
              role: inspected.role,
              ...(accepted.profile_id === undefined ? {} : { profile_id: accepted.profile_id, profile_resource_version: 1 }),
              issuedSession,
            };
          } finally {
            verifiedInvitationBinding?.secretDigest.fill(0);
          }
        }, { isolationLevel: "serializable" });
      }
      if (input.kind === "password_reset_settlement_checkpoint") {
        const payload = input.payload as { idempotency_key: string; payload_hash: string; transaction_id: string };
        const settlement = await withDatabaseTransactionRetry(db, async (trx) => {
          const transaction = await trx.selectFrom("oauth_transactions").selectAll()
            .where("oauth_transaction_id", "=", payload.transaction_id).forUpdate().executeTakeFirst();
          if (transaction === undefined || transaction.flow_kind !== "password_reset"
            || transaction.status !== "pending"
            || (transaction.provider_completion_status !== "provider_started"
              && transaction.provider_completion_status !== "provider_completed")
            || transaction.provider_subject_ciphertext === null
            || transaction.provider_completion_payload_hash !== payload.payload_hash
            || transaction.provider_settlement_expires_at === null) {
            throw new DomainError("UNAUTHENTICATED", "Password-reset settlement checkpoint is invalid");
          }
          const now = (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(trx)).rows[0]?.now;
          if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
            throw new DomainError("INTERNAL_ERROR", "Password-reset database clock is unavailable");
          }
          if (transaction.provider_settlement_expires_at.getTime() > now.getTime()) {
            return { kind: "in_progress" as const };
          }
          await trx.updateTable("oauth_transactions").set({
            status: "expired", pkce_verifier_ciphertext: Buffer.from([0]),
            provider_completion_status: "pending", provider_completion_started_at: null,
            expected_provider_subject_ciphertext: null, provider_subject_ciphertext: null,
            provider_completion_payload_hash: null, provider_settlement_expires_at: null,
            provider_completed_at: null, provider_evidence_at: null, updated_at: now,
          }).where("oauth_transaction_id", "=", payload.transaction_id).executeTakeFirstOrThrow();
          return { kind: "expired" as const };
        }, { isolationLevel: "serializable" });
        if (settlement.kind === "expired") {
          throw new DomainError("UNAUTHENTICATED", "Password-reset settlement authority expired");
        }
        return settlement;
      }
      if (input.kind === "password_reset_completed" && input.verifiedSubject !== undefined) {
        const payload = input.payload as { idempotency_key: string; payload_hash: string; transaction_id: string };
        const settlement = await withDatabaseTransactionRetry(db, async (trx) => {
          const transaction = await trx.selectFrom("oauth_transactions").selectAll()
            .where("oauth_transaction_id", "=", payload.transaction_id).forUpdate().executeTakeFirst();
          if (transaction === undefined || transaction.flow_kind !== "password_reset"
            || transaction.status !== "pending" || transaction.provider_completion_status !== "provider_completed"
            || transaction.provider_subject_ciphertext === null
            || transaction.provider_completion_payload_hash !== payload.payload_hash
            || transaction.provider_settlement_expires_at === null) {
            throw new DomainError("UNAUTHENTICATED", "Password-reset completion authority is invalid");
          }
          const now = (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(trx)).rows[0]?.now;
          if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
            throw new DomainError("INTERNAL_ERROR", "Password-reset database clock is unavailable");
          }
          if (transaction.provider_settlement_expires_at.getTime() <= now.getTime()) {
            await trx.updateTable("oauth_transactions").set({
              status: "expired", pkce_verifier_ciphertext: Buffer.from([0]),
              provider_completion_status: "pending", provider_completion_started_at: null,
              expected_provider_subject_ciphertext: null, provider_subject_ciphertext: null,
              provider_completion_payload_hash: null, provider_settlement_expires_at: null,
              provider_completed_at: null, provider_evidence_at: null, updated_at: now,
            })
              .where("oauth_transaction_id", "=", payload.transaction_id).executeTakeFirstOrThrow();
            return { kind: "expired" as const };
          }
          const subject = await trx.selectFrom("auth_subjects").select("actor_id")
            .where("provider", "=", input.verifiedSubject!.provider)
            .where("provider_subject", "=", input.verifiedSubject!.providerSubject)
            .where("status", "=", "active").forUpdate().executeTakeFirst();
          if (subject === undefined) throw new DomainError("UNAUTHENTICATED", "Password-reset subject is not registered");
          await revokeCoreSessionsInTransaction({ db }, trx, { actorId: subject.actor_id, reason: "password_reset" });
          await trx.updateTable("oauth_transactions").set({ status: "consumed", consumed_at: now, updated_at: now })
            .where("oauth_transaction_id", "=", payload.transaction_id).executeTakeFirstOrThrow();
          return { kind: "settled" as const, response: { schema_version: 1 } };
        }, { isolationLevel: "serializable" });
        if (settlement.kind === "expired") {
          throw new DomainError("UNAUTHENTICATED", "Password-reset settlement authority expired");
        }
        return settlement.response;
      }
      return unavailable();
    },
    async executeProtectedAuthorityCommand(input) {
      return withDatabaseTransactionRetry(db, async (trx) => {
        await requireRecentReauthentication({ trx }, authorityInput(input.authority));
        if (input.kind === "session_revoke") {
          const payload = input.payload as {
            schema_version: 1;
            idempotency_key: string;
            payload_hash: string;
            expected_resource_version: number;
            session_id: string;
            reason_code: "user_sign_out" | "administrator_revoked";
          };
          const { payload_hash: suppliedHash, ...canonicalPayload } = payload;
          const computedHash = canonicalPayloadHash(canonicalPayload);
          if (suppliedHash !== computedHash) throw new DomainError("INVALID_REQUEST", "Session revocation payload hash is invalid");
          const tenant = await trx.selectFrom("memberships").select("tenant_id")
            .where("actor_id", "=", input.authority.actorId).where("status", "=", "active")
            .orderBy("tenant_id").executeTakeFirst();
          if (tenant === undefined) throw new DomainError("UNAUTHENTICATED", "Active Session-revocation tenant authority is unavailable");
          const now = (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(trx)).rows[0]?.now;
          if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new DomainError("INTERNAL_ERROR", "Session-revocation database clock is unavailable");
          const context = { tenantId: tenant.tenant_id, trx };
          const operation = "identity.session-revoke";
          const admission = await beginIdempotentCommand<{
            schema_version: 1;
            session_id: string;
            status: "revoked";
            resource_version: number;
          }>(context, {
            key: payload.idempotency_key, payloadHash: computedHash, operation, now,
            expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000),
          });
          if (admission.kind === "replay") return admission.response;
          if (admission.kind === "in_progress") throw new DomainError("IDEMPOTENCY_CONFLICT", "Session revocation is already in progress");
          const revoked = await revokeCoreSessionInTransaction({}, trx, {
            actorId: input.authority.actorId,
            sessionId: payload.session_id,
            reason: payload.reason_code,
            expectedResourceVersion: payload.expected_resource_version,
          });
          const response = {
            schema_version: 1 as const, session_id: revoked.session_id,
            status: "revoked" as const, resource_version: revoked.resource_version,
          };
          await completeIdempotentCommand(context, {
            key: payload.idempotency_key, payloadHash: computedHash, operation,
            resultRef: revoked.session_id, response, updatedAt: now,
          });
          return response;
        }
        const payload = input.payload as Record<string, unknown>;
        if (input.kind === "company_create") {
          const idempotencyKey = String(payload.idempotency_key);
          const command = internalCommand({
            schema_version: 1 as const, idempotency_key: idempotencyKey,
            tenant_id: derivedId("tenant", idempotencyKey), display_name: String(payload.display_name),
            invitation: {
              invitation_id: derivedId("invitation", idempotencyKey), membership_id: derivedId("membership", idempotencyKey),
              normalized_email: String(payload.administrator_email).toLowerCase(),
            },
          });
          const result = await createB2bCompany({ db, transaction: trx, emailHmacKey: piiKey }, commandContext(input.authority.actorId), command);
          if (result.invitation_secret === undefined) {
            throw new DomainError("IDEMPOTENCY_CONFLICT", "Company invitation secret was already delivered");
          }
          return {
            schema_version: 1, tenant_id: result.tenant_id, tenant_resource_version: result.resource_version,
            administrator_invitation_id: result.invitation_id, administrator_invitation_resource_version: 1,
            administrator_invitation_secret: result.invitation_secret,
          };
        }
        if (input.kind === "company_member_invite") {
          const idempotencyKey = String(payload.idempotency_key);
          const tenantId = String(payload.tenant_id);
          const command = internalCommand({
            schema_version: 1 as const, idempotency_key: idempotencyKey, tenant_id: tenantId,
            invitation_id: derivedId("invitation", idempotencyKey), membership_id: derivedId("membership", idempotencyKey),
            normalized_email: String(payload.email).toLowerCase(), role: payload.role as "admin" | "consultant",
          });
          const result = await createInvitation({ db, transaction: trx, emailHmacKey: piiKey }, commandContext(input.authority.actorId, tenantId) as never, command);
          if (result.invitation_secret === undefined) {
            throw new DomainError("IDEMPOTENCY_CONFLICT", "Invitation secret was already delivered");
          }
          return {
            schema_version: 1, membership_id: result.membership_id, membership_resource_version: 1,
            invitation_id: result.invitation_id, invitation_resource_version: result.resource_version,
            invitation_secret: result.invitation_secret,
          };
        }
        if (input.kind === "invitation_revoke") {
          const invitation = await trx.selectFrom("identity_invitations").select("tenant_id")
            .where("invitation_id", "=", String(payload.invitation_id)).executeTakeFirst();
          if (invitation === undefined) throw new DomainError("RESOURCE_NOT_FOUND", "Invitation was not found");
          const command = internalCommand({
            schema_version: 1 as const, idempotency_key: String(payload.idempotency_key), tenant_id: invitation.tenant_id,
            invitation_id: String(payload.invitation_id), expected_resource_version: Number(payload.expected_resource_version),
          });
          const result = await revokeInvitation({ db, transaction: trx, emailHmacKey: piiKey }, commandContext(input.authority.actorId, invitation.tenant_id) as never, command);
          return { schema_version: 1, invitation_id: result.invitation_id, status: "revoked", resource_version: result.resource_version };
        }
        if (input.kind === "company_consultant_grant" || input.kind === "company_consultant_remove" || input.kind === "company_member_suspend") {
          const tenantId = await resolveCompanyTenant(trx, input.authority.actorId, String(payload.membership_id));
          const dependencies = { db, transaction: trx, consultantProfile: { providerConfigId: "identity-default", modelId: "identity-default" } };
          const context = commandContext(input.authority.actorId, tenantId) as never;
          const { payload_hash: _publicPayloadHash, ...commandPayload } = payload;
          if (input.kind === "company_consultant_grant") return grantConsultantRole(dependencies, context, internalCommand({ ...commandPayload, schema_version: 1 }) as never);
          if (input.kind === "company_consultant_remove") return removeConsultantRole(dependencies, context, internalCommand({ ...commandPayload, schema_version: 1 }) as never);
          const command = internalCommand({
            schema_version: 1 as const, idempotency_key: String(payload.idempotency_key), tenant_id: tenantId,
            membership_id: String(payload.membership_id), expected_resource_version: Number(payload.expected_resource_version),
          });
          const result = await suspendMembership(dependencies, context, command);
          return { schema_version: 1, membership_id: result.membership_id, status: "suspended", resource_version: result.resource_version };
        }
        if (input.kind === "company_member_list") {
          const tenantId = String(payload.tenant_id);
          await requireCompanyAdminForTenant(trx, input.authority.actorId, tenantId);
          const limit = Number(payload.limit);
          const cursor = payload.cursor === undefined ? undefined : String(payload.cursor);
          let query = trx.selectFrom("memberships").selectAll()
            .where("tenant_id", "=", tenantId).where("membership_source", "=", "company")
            .orderBy("membership_id").limit(limit + 1);
          if (cursor !== undefined) query = query.where("membership_id", ">", cursor);
          const rows = await query.execute();
          const hasMore = rows.length > limit;
          const members = rows.slice(0, limit);
          const actorIds = members.map((member) => member.actor_id);
          const profiles = actorIds.length === 0 ? [] : await trx.selectFrom("profiles")
            .select(["profile_id", "owner_actor_id", "resource_version", "status"])
            .where("tenant_id", "=", tenantId).where("profile_kind", "=", "consultant")
            .where("owner_actor_id", "in", actorIds).execute();
          const profileByActor = new Map(profiles.map((profile) => [profile.owner_actor_id, profile]));
          const views = members.map((member) => {
            if (member.status !== "active" && member.status !== "suspended" && member.status !== "revoked") {
              throw new DomainError("INTERNAL_ERROR", "Stored company Membership status is invalid");
            }
            const roles = member.roles;
            if (JSON.stringify(roles) !== '["admin"]' && JSON.stringify(roles) !== '["consultant"]'
              && JSON.stringify(roles) !== '["admin","consultant"]') {
              throw new DomainError("INTERNAL_ERROR", "Stored company Membership roles are invalid");
            }
            const profile = profileByActor.get(member.actor_id);
            if (roles.includes("consultant") && profile === undefined) {
              throw new DomainError("INTERNAL_ERROR", "Consultant Profile projection is unavailable");
            }
            if (profile !== undefined && profile.status !== "active" && profile.status !== "suspended" && profile.status !== "archived") {
              throw new DomainError("INTERNAL_ERROR", "Stored consultant Profile status is invalid");
            }
            return {
              schema_version: 1 as const, membership_id: member.membership_id, actor_id: member.actor_id,
              membership_resource_version: Number(member.resource_version), source: "company" as const,
              status: member.status, roles,
              ...(profile === undefined ? {} : {
                profile_id: profile.profile_id, profile_resource_version: Number(profile.resource_version),
                profile_status: profile.status,
              }),
            };
          });
          return {
            schema_version: 1, tenant_id: tenantId, members: views,
            page_info: {
              schema_version: 1, has_more: hasMore,
              ...(hasMore ? { next_cursor: members.at(-1)!.membership_id } : {}),
            },
          };
        }
        if (input.kind === "company_member_revoke") {
          const tenantId = await resolveCompanyTenant(trx, input.authority.actorId, String(payload.membership_id));
          const idempotencyKey = String(payload.idempotency_key);
          const payloadHash = String(payload.payload_hash);
          const { payload_hash: _payloadHash, ...canonicalPayload } = payload;
          if (payloadHash !== canonicalPayloadHash(canonicalPayload)) {
            throw new DomainError("INVALID_REQUEST", "Membership revocation payload hash is invalid");
          }
          const now = (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(trx)).rows[0]?.now;
          if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new DomainError("INTERNAL_ERROR", "Membership database clock is unavailable");
          const context = { tenantId, trx };
          const operation = "identity.company-member-revoke";
          const admission = await beginIdempotentCommand<{ schema_version: 1; membership_id: string; status: "revoked"; resource_version: number }>(context, {
            key: idempotencyKey, payloadHash, operation, now,
            expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000),
          });
          if (admission.kind === "replay") return admission.response;
          if (admission.kind === "in_progress") throw new DomainError("IDEMPOTENCY_CONFLICT", "Membership revocation is already in progress");
          const membership = await trx.selectFrom("memberships").select(["resource_version", "membership_source"])
            .where("tenant_id", "=", tenantId).where("membership_id", "=", String(payload.membership_id)).forUpdate().executeTakeFirst();
          if (membership === undefined) throw new DomainError("RESOURCE_NOT_FOUND", "Membership was not found");
          const expected = Number(payload.expected_resource_version);
          if (Number(membership.resource_version) !== expected || membership.membership_source !== "company") throw new DomainError("RESOURCE_VERSION_CONFLICT", "Membership version changed");
          await trx.updateTable("memberships").set({ status: "revoked", resource_version: expected + 1, updated_at: now }).where("tenant_id", "=", tenantId).where("membership_id", "=", String(payload.membership_id)).execute();
          const response = { schema_version: 1 as const, membership_id: String(payload.membership_id), status: "revoked" as const, resource_version: expected + 1 };
          await completeIdempotentCommand(context, {
            key: idempotencyKey, payloadHash, operation, resultRef: response.membership_id, response, updatedAt: now,
          });
          return response;
        }
        if (input.kind === "apple_identity_link" && input.verifiedSubject !== undefined) {
          const idempotencyKey = String(payload.idempotency_key);
          const payloadHash = String(payload.payload_hash);
          const tenant = await trx.selectFrom("memberships").select("tenant_id")
            .where("actor_id", "=", input.authority.actorId).where("status", "=", "active")
            .orderBy("tenant_id").executeTakeFirst();
          if (tenant === undefined) throw new DomainError("UNAUTHENTICATED", "Active identity-link tenant authority is unavailable");
          const now = (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(trx)).rows[0]?.now;
          if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new DomainError("INTERNAL_ERROR", "Identity-link database clock is unavailable");
          const context = { tenantId: tenant.tenant_id, trx };
          const operation = "identity.apple-link";
          const admission = await beginIdempotentCommand<{ schema_version: 1; auth_subject_id: string; linked: true }>(context, {
            key: idempotencyKey, payloadHash, operation, now,
            expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000),
          });
          if (admission.kind === "in_progress") throw new DomainError("IDEMPOTENCY_CONFLICT", "Apple identity link is already in progress");
          if (admission.kind === "replay") {
            const existing = await trx.selectFrom("auth_subjects")
              .select(["auth_subject_id", "actor_id", "provider", "provider_subject", "provider_identity_kind", "status"])
              .where("auth_subject_id", "=", admission.resultRef).executeTakeFirst();
            if (existing?.actor_id !== input.authority.actorId || existing.provider !== input.verifiedSubject.provider
              || existing.provider_subject !== input.verifiedSubject.providerSubject
              || existing.provider_identity_kind !== "email_password_apple" || existing.status !== "active"
              || admission.response.auth_subject_id !== existing.auth_subject_id || admission.response.linked !== true) {
              throw new DomainError("IDEMPOTENCY_CONFLICT", "Apple identity link replay conflicts");
            }
            return admission.response;
          }
          const current = await trx.selectFrom("auth_subjects")
            .select(["auth_subject_id", "actor_id", "provider_identity_kind", "status", "resource_version"])
            .where("provider", "=", input.verifiedSubject.provider)
            .where("provider_subject", "=", input.verifiedSubject.providerSubject).forUpdate().executeTakeFirst();
          if (current?.auth_subject_id !== input.authority.authSubjectId || current.actor_id !== input.authority.actorId
            || current.status !== "active"
            || (current.provider_identity_kind !== "email_password" && current.provider_identity_kind !== "email_password_apple")) {
            throw new DomainError("IDEMPOTENCY_CONFLICT", "Apple identity is already linked");
          }
          if (current.provider_identity_kind === "email_password") {
            await trx.updateTable("auth_subjects").set({
              provider_identity_kind: "email_password_apple",
              verified_at: new Date(input.verifiedSubject.verifiedAt),
              resource_version: Number(current.resource_version) + 1,
              updated_at: now,
            }).where("auth_subject_id", "=", current.auth_subject_id)
              .where("resource_version", "=", String(current.resource_version)).executeTakeFirstOrThrow();
          }
          const linked = { auth_subject_id: current.auth_subject_id };
          const response = { schema_version: 1 as const, auth_subject_id: linked.auth_subject_id, linked: true as const };
          await completeIdempotentCommand(context, {
            key: idempotencyKey, payloadHash, operation, resultRef: linked.auth_subject_id, response, updatedAt: now,
          });
          return response;
        }
        if (input.kind === "account_deletion_request" || input.kind === "account_deletion_cancel") return unavailable();
        return unavailable();
      }, { isolationLevel: "serializable" });
    },
  } satisfies IdentityGatewayOperations);
}

export const identityGatewayServerTestInternals = Object.freeze({ aesProtector, oauthStore, productionOperations });

export async function buildProductionIdentityGateway(options: ProductionIdentityGatewayOptions = {}): Promise<FastifyInstance> {
  const config = loadIdentityGatewayConfig(options.environment ?? process.env);
  const [publishableKey, serviceRoleKey, sessionMaterial, piiMaterial, signingMaterial] = await Promise.all([
    readManagedSecret(config.providerPublishableKeyRef), readManagedSecret(config.providerServiceRoleKeyRef),
    readManagedSecret(config.sessionHmacKeyRef), readManagedSecret(config.piiHmacKeyRef), readManagedSecret(config.signingKeyRef),
  ]);
  const pool = new Pool({ connectionString: config.databaseUrl });
  const db = createRuntimeDatabase(pool);
  try {
    await assertSchemaVersion(db);
    const piiKey = deriveKey(piiMaterial, "pii-hmac");
    const piiProtector = aesProtector(piiMaterial, "private-pii");
    const provider = new SupabaseAuthProvider({
      supabaseUrl: config.providerUrl, publishableKey: publishableKey.toString("utf8"), serviceRoleKey: serviceRoleKey.toString("utf8"),
      appleRedirectUris: [...config.appleWebRedirectUris, ...config.appleNativeRedirectUris],
      passwordResetRedirectUri: config.passwordResetRedirectUri, emailVerificationRedirectUri: config.emailVerificationRedirectUri,
      transactionStore: oauthStore(db), transactionProtector: aesProtector(signingMaterial, "oauth-transaction"),
    });
    const app = await buildIdentityGatewayApp({ config, provider, operations: productionOperations(db, piiKey, piiProtector), flowCookieKey: deriveKey(sessionMaterial, "flow-cookie") });
    app.addHook("onClose", async () => { await db.destroy(); });
    return app;
  } catch (error) {
    await db.destroy().catch(() => undefined);
    throw error;
  } finally {
    publishableKey.fill(0); serviceRoleKey.fill(0); sessionMaterial.fill(0); piiMaterial.fill(0); signingMaterial.fill(0);
  }
}

export async function startIdentityGatewayServer(): Promise<FastifyInstance> {
  const app = await buildProductionIdentityGateway();
  const config = loadIdentityGatewayConfig(process.env);
  try {
    await app.listen({ host: config.host, port: config.port });
    return app;
  } catch (error) {
    await app.close().catch(() => undefined);
    throw error;
  }
}
