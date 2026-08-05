import { canonicalPayloadHash, loadProviderCatalog } from "@core-agent/runtime-core";

export const SYNTHETIC_BOOTSTRAP_KEY =
  "synthetic-bootstrap-key-task16-00000001";
export const SYNTHETIC_INGRESS_KEY =
  "synthetic-ingress-key-task16-00000001";
export const SYNTHETIC_PROVIDER_ID = "provider_task16";
export const SYNTHETIC_MODEL_ID = "model_task16";
export const SYNTHETIC_PROVIDER_SECRET_REF = "provider_secret_task16";
export const SYNTHETIC_IMAGE_REF =
  `managed/runtime-task16:v1@sha256:${"a".repeat(64)}`;

export const syntheticImageLock = Object.freeze({
  schemaVersion: 1 as const,
  repository: "managed/runtime-task16",
  tag: "v1",
  platforms: Object.freeze({
    "linux/amd64": Object.freeze({ reference: SYNTHETIC_IMAGE_REF }),
    "linux/arm64": Object.freeze({
      reference: `managed/runtime-task16:v1@sha256:${"b".repeat(64)}`,
    }),
  }),
});

export const syntheticProviderCatalog = loadProviderCatalog([
  {
    provider_config_id: SYNTHETIC_PROVIDER_ID,
    base_url: "https://provider.task16.example/v1/",
    model_ids: [SYNTHETIC_MODEL_ID],
    credential_secret_ref: SYNTHETIC_PROVIDER_SECRET_REF,
    timeout_ms: 1_000,
    max_safe_retries: 2,
  },
]);

export function withPayloadHash<T extends Record<string, unknown>>(
  payload: T,
): T & { readonly payload_hash: string } {
  return { ...payload, payload_hash: canonicalPayloadHash(payload) };
}

export function rehash<T extends { readonly payload_hash: string }>(
  value: T,
): Omit<T, "payload_hash"> & { readonly payload_hash: string } {
  const { payload_hash: _payloadHash, ...payload } = value;
  return withPayloadHash(payload);
}

export function syntheticB2BProvisioningRequest(tenantId: string) {
  const timestamp = "2026-08-05T03:00:00.000Z";
  const actorId = `actor_${tenantId}`;
  const profileId = `profile_${tenantId}`;
  return withPayloadHash({
    schema_version: 1 as const,
    idempotency_key: `idem_provision_${tenantId}`,
    client_request_id: `client_provision_${tenantId}`,
    identity_graph: {
      schema_version: 1 as const,
      tenant: {
        schema_version: 1 as const,
        resource_version: 1,
        tenant_id: tenantId,
        tenant_mode: "b2b" as const,
        display_name: "Synthetic Task 16 tenant",
        status: "provisioning" as const,
        created_at: timestamp,
        updated_at: timestamp,
      },
      actors: [
        {
          schema_version: 1 as const,
          resource_version: 1,
          actor_id: actorId,
          actor_kind: "human" as const,
          display_name: "Synthetic consultant",
          status: "active" as const,
          created_at: timestamp,
          updated_at: timestamp,
        },
      ],
      memberships: [
        {
          schema_version: 1 as const,
          resource_version: 1,
          membership_id: `membership_${tenantId}`,
          tenant_id: tenantId,
          actor_id: actorId,
          roles: ["consultant" as const],
          status: "active" as const,
          created_at: timestamp,
          updated_at: timestamp,
        },
      ],
      profiles: [
        {
          schema_version: 1 as const,
          resource_version: 1,
          profile_id: profileId,
          tenant_id: tenantId,
          owner_actor_id: actorId,
          profile_kind: "consultant" as const,
          status: "provisioning" as const,
          hermes_profile_ref: `hermes_${tenantId}`,
          created_at: timestamp,
          updated_at: timestamp,
        },
      ],
    },
    provider_config_id: SYNTHETIC_PROVIDER_ID,
    model_id: SYNTHETIC_MODEL_ID,
    runtime: {
      image_ref: SYNTHETIC_IMAGE_REF,
      platform: "linux/amd64" as const,
      ingress_secret_ref: `ingress_${tenantId}`,
    },
    profile_runtime_config: [
      {
        profile_id: profileId,
        description: "Synthetic Task 16 consultant profile",
      },
    ],
  });
}

export function syntheticConversationRequest(
  tenantId: string,
  profileId: string,
  suffix: string,
) {
  return withPayloadHash({
    schema_version: 1 as const,
    idempotency_key: `idem_conversation_${suffix}`,
    tenant_id: tenantId,
    profile_id: profileId,
  });
}

export function syntheticRunRequest(
  suffix: string,
  content: string,
  parentRunId?: string,
) {
  return withPayloadHash({
    schema_version: 1 as const,
    idempotency_key: `idem_run_${suffix}`,
    client_request_id: `client_run_${suffix}`,
    input_message: {
      client_message_id: `client_message_${suffix}`,
      content,
    },
    ...(parentRunId === undefined ? {} : { parent_run_id: parentRunId }),
  });
}

export function syntheticRuntimeCommand(
  suffix: string,
  command: "start" | "stop" | "restart" | "delete",
  expectedResourceVersion: number,
) {
  return withPayloadHash({
    schema_version: 1 as const,
    idempotency_key: `idem_runtime_command_${suffix}`,
    expected_resource_version: expectedResourceVersion,
    command,
  });
}
