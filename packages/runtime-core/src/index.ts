export { loadRuntimeEnvironment, type RuntimeEnvironment } from "./config/environment.js";
export {
  databaseConnectionOptions,
  readProtectedDatabasePassword,
} from "./config/database-password.js";
export {
  deriveManagedRuntimeNames,
  type ManagedRuntimeIdentity,
  type ManagedRuntimeNames,
} from "./runtime/managed-names.js";
export {
  loadProviderCatalog,
  type ProviderCatalog,
  type ProviderConfig,
} from "./config/provider-catalog.js";
export { loadRuntimeImageLock, type ManagedImageLock } from "./config/image-lock.js";
export {
  createRuntimeDatabase,
  type NullableRuntimeBigInt,
  type RuntimeBigInt,
  type RuntimeDatabase,
} from "./db/database.js";
export type {
  AccountDeletionTable,
  AuthSubjectTable,
  CoreSessionTable,
  IdentityAuthorityTables,
  IdentityInvitationTable,
  OauthTransactionTable,
  PlatformRoleAssignmentTable,
  PrivateIdentityPiiTable,
  PublicRateLimitTable,
} from "./db/identity-tables.js";
export {
  DatabaseTransactionRetryAbortedError,
  DatabaseTransactionRetryExhaustedError,
  isDatabaseTransactionRetryExhaustedError,
  isRetryableDatabaseTransactionError,
  withDatabaseTransactionRetry,
} from "./db/transaction-retry.js";
export { applyMigrations } from "./db/migrate.js";
export {
  bootstrapRuntimeDatabaseAuth,
  type RuntimeDatabaseAuthBootstrapInput,
} from "./db/bootstrap-auth.js";
export {
  assertTenantId,
  withTenantTransaction,
  type TenantDatabaseContext,
  type TenantTransaction,
} from "./db/transaction.js";
export {
  ResourceRepositories,
  type TenantResourceRepositories,
} from "./repositories/index.js";
export {
  ActorRepository,
  MembershipRepository,
  ProfileRepository,
  TenantRepository,
  safeContractInteger,
  type ProfileInsert,
  type TenantRepositoryContext,
} from "./repositories/resources.js";
export { RuntimeRepository, type VersionedWriteResult } from "./repositories/runtime.js";
export { ConversationRepository, SessionRepository } from "./repositories/conversation.js";
export { AgentRunRepository, MessageRepository } from "./repositories/run.js";
export {
  SecretReferenceRepository,
  type SecretReferenceMetadata,
  type SecretReferenceStatus,
} from "./repositories/secret-references.js";
export {
  claimJobs,
  claimPlatformWorkerJobs,
  heartbeatJob,
  completeJob,
  rescheduleJob,
  failJob,
  type ClaimedJob,
  type ClaimJobsInput,
  type PlatformWorkerClaimInput,
  type JobLeaseResult,
  runtimeCommandIntents,
  type RuntimeCommandIntent,
  workerEffectStates,
  type WorkerEffectState,
  type ReconcileEffectState,
  type AgentRunEffectState,
  workerJobKinds,
  type WorkerJobKind,
} from "./repositories/jobs.js";
export { acquireRuntimeTransactionAdvisoryLock, runtimeAdvisoryLockKey, withRuntimeAdvisoryLock } from "./repositories/runtime-lock.js";
export {
  agentRunConversationLockKey,
  withAgentRunConversationLock,
  type AgentRunConversationLockInput,
} from "./repositories/agent-run-conversation-lock.js";
export { WorkerRuntimeRepository, type ProvisionAdmissionResult, type ProvisionCompletionResult, type ProvisionFailureResult, type ReconcileClaimedIntent, type ReconcileFailureResult, type ReconcileRetryResult, type ReconcileSuccessIntent, type RuntimeWorkerJobRef, type StoredProvisionFacts, type StoredProvisionProfile, type StoredReconcileFacts } from "./repositories/worker-runtime.js";
export {
  WorkerAgentRunRepository,
  type AgentRunFailure,
  type AgentRunBeginResult,
  type AgentRunWorkerJobRef,
  type StoredAgentRunExecutionFacts,
} from "./repositories/worker-agent-run.js";
export {
  claimOutboxWakeups,
  failOutbox,
  markOutboxDelivered,
  OUTBOX_EXHAUSTED_SUMMARY,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_RECOVERY_BATCH_SIZE,
  rescheduleOutbox,
  type ClaimedOutboxWakeup,
  type ClaimOutboxInput,
} from "./repositories/outbox.js";
export {
  appendProductEvents,
  appendAuditEvent,
  enqueueOutbox,
  readEventsAfter,
  type AppendProductEventsInput,
  type PersistedProductEvent,
  type ProductEventWithoutSequence,
} from "./repositories/events.js";
export {
  canonicalPayloadHash,
  beginIdempotentCommand,
  completeIdempotentCommand,
  DomainError,
  type DependencyFailure,
  type IdempotencyAdmission,
  type StableDomainErrorCode,
} from "./domain/idempotency.js";
export { classifyDependencyFailure, retryDecision, type RetryDecision } from "./domain/jobs.js";
export { createRedactor, redactSummary, type Redactor } from "./domain/redaction.js";
export { validateAuditEvent, validateProductEvent } from "./domain/events.js";
export {
  assertAgentRunTransition,
  assertRuntimeObservedTransition,
  redactedFailureSummary,
} from "./domain/transitions.js";
export { FileSecretStore } from "./secrets/file-secret-store.js";
export {
  assertSecretReference,
  assertSecretReferenceId,
  secretPurposes,
  type SecretMaterial,
  type SecretPurpose,
  type SecretReference,
  type SecretStore,
} from "./secrets/secret-store.js";
export {
  HermesClient,
  HermesStreamError,
  validateManagedHermesOrigin,
  type HermesChatInput,
  type HermesClientOptions,
  type HermesStreamErrorCode,
} from "./hermes/client.js";
export {
  MAX_HERMES_ASSISTANT_CHARACTERS,
  MAX_HERMES_SSE_LINE_BYTES,
  parseHermesEventStream,
} from "./hermes/stream-parser.js";
export {
  assertSchemaVersion,
  EXPECTED_SCHEMA_VERSION,
  readSchemaVersion,
} from "./db/schema-version.js";
export {
  MAX_SUPERVISOR_FRAME_BYTES,
  MAX_SUPERVISOR_TIMEOUT_MS,
  SUPERVISOR_DEADLINE_BUDGET,
  REMOVED_RUNTIME_IMAGE_REF,
  canonicalSupervisorRequestHash,
  decodeSupervisorFrame,
  encodeSupervisorFrame,
  validateSupervisorRequest,
  validateSupervisorResponse,
  type LifecycleRuntimeCommandDataV1,
  type ProvisionRuntimeCommandDataV1,
  type RuntimeObservation,
  type SupervisorRequestDataV1,
  type SupervisorRequestV1,
  type SupervisorResponseV1,
} from "./supervisor/contracts.js";
export { RuntimeSupervisorClient, RuntimeSupervisorDependencyError, type RuntimeSupervisorClientOptions } from "./supervisor/client.js";
export {
  FakeRuntimeSupervisorServer,
  type FakeRuntimeSupervisorServerOptions,
} from "./supervisor/fake-server.js";
export {
  TenantProvisioningRequestSchema,
  deriveRuntimeContainerId,
  deriveRuntimeVolumeRef,
  provisionTenant,
  type ProvisioningContext,
  type ProvisionTenantDependencies,
  type ProvisionTenantResponse,
  type TenantProvisioningRequest,
} from "./services/provision-tenant.js";
export {
  registerB2c,
  type B2cRegistrationResult,
  type RegisterB2cCommand,
  type RegisterB2cContext,
  type RegisterB2cDependencies,
  type VerifiedAuthSubjectInput,
} from "./services/identity/register-b2c.js";
export {
  loadActorIdentityAuthority,
  type ActorIdentityAuthority,
} from "./repositories/identity/identity-authority.js";
export {
  constantTimeDigestMatches,
  deriveIdentityCommandId,
  invitationEmailHmac,
  issueInvitationSecret,
  lockInvitationBySecret,
  publicInvitationNotFound,
  type InvitationRandomBytes,
  type StoredInvitationCredential,
} from "./repositories/identity/invitations.js";
export {
  platformMembershipId,
  platformRoleAssignmentId,
} from "./repositories/identity/platform-roles.js";
export {
  grantPlatformRole,
  revokePlatformRole,
  type PlatformRoleCommand,
  type PlatformRoleCommandContext,
  type PlatformRoleCommandDependencies,
  type PlatformRoleWriteResult,
} from "./services/identity/change-platform-role.js";
export {
  createB2bCompany,
  type CreateB2bCompanyCommand,
  type CreateB2bCompanyContext,
  type CreateB2bCompanyDependencies,
  type CreateB2bCompanyResult,
} from "./services/identity/create-b2b-company.js";
export {
  createInvitation,
  inspectInvitation,
  replaceInvitation,
  revokeInvitation,
  type CreateInvitationCommand,
  type InvitationCommandContext,
  type InvitationCommandDependencies,
  type InvitationCommandResult,
  type ReplaceInvitationCommand,
  type RevokeInvitationCommand,
} from "./services/identity/manage-invitation.js";
export {
  acceptInvitation,
  type AcceptInvitationCommand,
  type AcceptInvitationContext,
  type AcceptInvitationDependencies,
  type AcceptInvitationResult,
} from "./services/identity/accept-invitation.js";
export {
  grantConsultantRole,
  removeConsultantRole,
  suspendMembership,
  type ConsultantRoleGrantResult,
  type ConsultantRoleRemoveResult,
  type GrantConsultantRoleCommand,
  type MembershipMutationResult,
  type MembershipRoleCommandContext,
  type MembershipRoleCommandDependencies,
  type RemoveConsultantRoleCommand,
  type SuspendMembershipCommand,
} from "./services/identity/change-membership-roles.js";
export {
  projectPlatformMemberships,
  type PlatformMembershipProjectionPage,
} from "./services/identity/project-platform-memberships.js";
export {
  RuntimeCommandRequestSchema,
  commandRuntime,
  getTenantRuntime,
  type CommandRuntimeDependencies,
  type CommandRuntimeResponse,
  type RuntimeCommandRequest,
} from "./services/command-runtime.js";
export {
  createConversation,
  type CreateConversationContext,
  type CreateConversationDependencies,
  type CreateConversationRequest,
} from "./services/create-conversation.js";
export {
  createAgentRun,
  getAgentRun,
  type CreateAgentRunContext,
  type CreateAgentRunDependencies,
} from "./services/create-agent-run.js";
