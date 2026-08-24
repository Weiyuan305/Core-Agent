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
  MAX_CAPABILITY_RUNTIME_MANIFEST_BYTES,
  MAX_CAPABILITY_RUNTIME_MANIFEST_ENTRIES,
  createCapabilityRuntimeManifest,
  validateCapabilityRuntimeManifest,
  type CapabilityRuntimeManifestInput,
  type CapabilityRuntimeManifestKind,
  type CapabilityRuntimeManifestV1,
  type CreatedCapabilityRuntimeManifest,
} from "./runtime/capability-manifest.js";
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
  EmailVerificationTransactionTable,
  IdentityAuthorityTables,
  IdentityInvitationTable,
  OauthTransactionTable,
  PlatformRoleAssignmentTable,
  PrivateIdentityPiiTable,
  PublicRateLimitTable,
} from "./db/identity-tables.js";
export type {
  ApprovalRequirement,
  AssignmentStatus,
  CapabilityKind,
  CapabilityRiskClass,
  CapabilityRuntimeProjectionTable,
  CapabilityTable,
  CapabilityVersionStatus,
  CapabilityVersionTable,
  EntitlementAssignmentTable,
  EntitlementAuthorityTables,
  EntitlementSnapshotCapabilityTable,
  EntitlementSnapshotSourceTable,
  EntitlementSnapshotTable,
  EntitlementStatus,
  EntitlementTable,
  PackMemberTable,
  PackProductTable,
  PackVersionStatus,
  PackVersionTable,
  PlatformAuthorityAuditTable,
  ProfileSnapshotPointerTable,
  ProjectionStatus,
  RuntimeActivityTable,
  TenantPackReleaseStatus,
  TenantPackReleaseTable,
} from "./db/entitlement-tables.js";
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
  markJobEffectDispatched,
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
  CapabilityProjectionRepository,
  capabilityProjectionJobId,
  type CapabilityProjectionCompletionResult,
  type CapabilityProjectionFailureResult,
  type CapabilityProjectionPreparationResult,
  type CapabilityProjectionWorkerJobRef,
  type StoredCapabilityProjectionFacts,
} from "./repositories/entitlements/projections.js";
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
export { strictUtcTimestampMilliseconds } from "./domain/utc-timestamp.js";
export {
  validateCatalogCommandInput,
  validateCatalogTransition,
  validateImmutableArtifactRef,
  canonicalCompatibility,
  type CatalogCompatibility,
  type CatalogMemberInput,
} from "./services/entitlements/catalog-validation.js";
export {
  createCapabilityVersion,
  reviewCapabilityVersion,
  retireCapabilityVersion,
  blockCapabilityVersion,
  type CapabilityWriteResult,
  type CatalogCommandContext,
  type CatalogCommandDependencies,
} from "./services/entitlements/manage-capability.js";
export {
  createPackVersion,
  reviewPackVersion,
  publishPackVersion,
  retirePackVersion,
  blockPackVersion,
  type PackWriteResult,
} from "./services/entitlements/manage-pack.js";
export {
  selectTenantPackRelease,
  type SelectTenantPackReleaseDependencies,
  type TenantPackReleaseSelectionResult,
} from "./services/entitlements/select-pack-release.js";
export {
  grantEntitlement,
  changeEntitlementStatus,
  type EntitlementWriteResult,
  type ManageEntitlementDependencies,
} from "./services/entitlements/manage-entitlement.js";
export {
  expireEntitlements,
  type ExpireEntitlementsDependencies,
} from "./services/entitlements/expire-entitlements.js";
export type { EntitlementCommandContext } from "./services/entitlements/authority.js";
export {
  assignPackSeat,
  type AssignPackSeatDependencies,
  type PackSeatAssignmentResult,
} from "./services/entitlements/assign-pack-seat.js";
export {
  revokePackSeat,
  type RevokePackSeatDependencies,
} from "./services/entitlements/revoke-pack-seat.js";
export type {
  AssignmentCommandDependencies,
  AssignmentResolverInput,
} from "./services/entitlements/assignment-authority.js";
export {
  resolveEffectiveCapabilities,
  type EffectiveCapabilitySet,
  type EffectiveCapabilitySource,
  type EffectiveCapabilityTriple,
} from "./services/entitlements/effective-capabilities.js";
export {
  resolveProfileSnapshot,
  resolveProfileSnapshotInTransaction,
  type ResolveProfileSnapshotDependencies,
  type ResolveProfileSnapshotInput,
  type ResolveProfileSnapshotTransactionInput,
  type ResolvedProfileSnapshot,
  type SnapshotResolutionEvidence,
} from "./services/entitlements/resolve-profile-snapshot.js";
export { assertAutomaticB2cProfile } from "./services/entitlements/automatic-b2c-assignment.js";
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
  type CapabilityInspectRuntimeCommandDataV2,
  type CapabilityProvisionRuntimeCommandDataV2,
  type CapabilityProvisionRuntimeCommandV2,
  type CapabilityRuntimeObservation,
  type LifecycleRuntimeCommandDataV1,
  type ProvisionRuntimeCommandDataV1,
  type RuntimeObservation,
  type SupervisorRequestDataV1,
  type SupervisorRequestV1,
  type SupervisorRequestV2,
  type SupervisorRequest,
  type SupervisorResponseV1,
  type SupervisorResponseV2,
  type SupervisorResponse,
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
  registerInvitedIdentityForVerifiedInvitation,
  type InvitedIdentityRegistrationResult,
  type RegisterInvitedIdentityCommand,
  type RegisterInvitedIdentityDependencies,
} from "./services/identity/register-invited-identity.js";
export {
  replaceAuthProviderSubject,
  type ReplacementAuthSubjectInput,
  type ReplaceAuthProviderSubjectCommand,
  type ReplaceAuthProviderSubjectContext,
  type ReplaceAuthProviderSubjectDependencies,
  type ReplaceAuthProviderSubjectResult,
} from "./services/identity/replace-auth-provider.js";
export {
  loadActorIdentityAuthority,
  type ActorIdentityAuthority,
} from "./repositories/identity/identity-authority.js";
export {
  type CoreSessionRandomBytes,
  type CoreSessionRevocationReason,
} from "./repositories/identity/core-sessions.js";
export {
  consumePublicRateLimit,
  type ConsumePublicRateLimitDependencies,
  type ConsumePublicRateLimitInput,
  type PublicRateLimitBucketKind,
} from "./repositories/identity/public-rate-limits.js";
export { canonicalJson } from "./services/identity/canonical-json.js";
export {
  decodeSignedTrustedContext,
  encodeSignedTrustedContext,
  assertTrustedContextAgentRunAdmission,
  createIdentityBootstrapEntitlementSnapshotAuthorityPort,
  issueTrustedContext,
  loadIdentitySigningPrivateKey,
  resolveTrustedContextPublicKey,
  verifyTrustedContextSignature,
  type ResolveTrustedContextPublicKeyInput,
  type CurrentEntitlementSnapshotAuthority,
  type EntitlementSnapshotAuthorityPort,
  type IssueTrustedContextDependencies,
  type IssueTrustedContextInput,
  type TrustedContextPublicKey,
  type VerifyTrustedContextSignatureInput,
} from "./services/identity/trusted-context.js";
export {
  createEntitlementSnapshotAuthorityPort,
  loadCurrentSnapshotAuthority,
  requireCurrentSnapshot,
  recheckCapabilityBeforeEffect,
  requireCurrentSnapshotAuthority,
  type CurrentSnapshotAuthority,
  type LoadCurrentSnapshotAuthorityInput,
  type RequireCurrentSnapshotAuthorityInput,
} from "./services/entitlements/current-authority.js";
export {
  beginEmailVerificationTransaction,
  admitEmailVerificationProviderAttempt,
  canonicalEmailVerificationStartPayloadHash,
  checkpointEmailVerificationTransaction,
  consumeEmailVerificationTransaction,
  finalizeEmailVerificationTransactionStart,
  prepareEmailVerificationTransaction,
  releaseEmailVerificationProviderAttempt,
  terminalizeEmailVerificationProviderAttempt,
  type AdmittedEmailVerificationProviderAttempt,
  type BeginEmailVerificationTransactionInput,
  type BegunEmailVerificationTransaction,
  type ExpiredEmailVerificationTransaction,
  type ConsumedEmailVerificationBinding,
  type PreparedEmailVerificationBinding,
  type EmailVerificationProtector,
  type EmailVerificationStartPayloadFacts,
  type EmailVerificationTransactionDependencies,
} from "./repositories/identity/email-verification-transactions.js";
export {
  authenticateCoreSession,
  issueCoreSession,
  revokeCoreSession,
  revokeCoreSessionInTransaction,
  revokeCoreSessions,
  revokeCoreSessionsInTransaction,
  type AuthenticateCoreSessionInput,
  type AuthenticatedCoreSession,
  type CoreSessionAuthSubjectAuthority,
  type CoreSessionDependencies,
  type CoreSessionTransactionDependencies,
  type IssueCoreSessionInput,
  type IssuedCoreSession,
  type RevokeCoreSessionInput,
  type RevokeCoreSessionsInput,
} from "./services/identity/core-session.js";
export {
  establishRecentReauthentication,
  establishRecentReauthenticationInTransaction,
  requireRecentReauthentication,
  type CurrentCoreSessionAuthorityInput,
  type EstablishedReauthentication,
  type EstablishRecentReauthenticationInput,
  type ReauthenticationDependencies,
  type ReauthenticationTransactionContext,
  type RecentReauthenticationAuthority,
} from "./services/identity/reauthentication.js";
export {
  constantTimeDigestMatches,
  deriveIdentityCommandId,
  invitationEmailHmac,
  issueInvitationSecret,
  lockInvitationByDigest,
  lockInvitationBySecret,
  publicInvitationNotFound,
  readInvitationBySecret,
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
  accountDeletionPseudonym,
  authenticateAccountDeletionRecoverySession,
  cancelAccountDeletion,
  establishAccountDeletionRecoveryReauthentication,
  finalizeAccountDeletion,
  loadAccountDeletionFinalization,
  requestAccountDeletion,
  type AccountDeletionCancellationContext,
  type AccountDeletionCancellationResult,
  type AccountDeletionCommandContext,
  type AccountDeletionDependencies,
  type AccountDeletionEntitlementRevocationPort,
  type AccountDeletionFinalizationFacts,
  type AccountDeletionFinalizationResult,
  type AccountDeletionRequestResult,
  type AccountDeletionRuntimeStopIntentPort,
  type AuthenticateAccountDeletionRecoveryInput,
  type AuthenticatedAccountDeletionRecovery,
  type EstablishAccountDeletionRecoveryReauthenticationInput,
} from "./services/identity/manage-account-deletion.js";
export {
  createAccountDeletionEntitlementRevocationPort,
  type CreateAccountDeletionEntitlementRevocationPortDependencies,
} from "./services/entitlements/revoke-actor-entitlements.js";
export {
  readAccountDeletionFinalizationFacts,
  type StoredAccountDeletionFinalizationFacts,
} from "./repositories/identity/account-deletions.js";
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
  deriveConversationId,
  type CreateConversationContext,
  type CreateConversationDependencies,
  type CreateConversationRequest,
} from "./services/create-conversation.js";
export {
  createAgentRun,
  deriveAgentRunId,
  getAgentRun,
  type CreateAgentRunContext,
  type CreateAgentRunDependencies,
} from "./services/create-agent-run.js";
export {
  enqueueIdleB2cRuntimeStopJobs,
  queueRuntimeLifecycleCommand,
  RuntimeActivityRepository,
  touchRuntimeActivity,
  type StopIdleRuntimeResult,
} from "./repositories/entitlements/runtime-activity.js";
export { ensureRuntimeWakeIntent } from "./services/entitlements/runtime-lifecycle.js";
