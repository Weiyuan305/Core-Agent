export const secretPurposes = [
  "model_provider",
  "hermes_ingress",
  "bootstrap_service",
  "identity_signing",
  "policy_runtime",
  "policy_plugin",
] as const;

export type SecretPurpose = (typeof secretPurposes)[number];

export interface SecretReference {
  readonly reference_id: string;
  readonly version: number;
  readonly purpose: SecretPurpose;
}

export interface SecretMaterial {
  readonly reference: SecretReference;
  withBytes<T>(consumer: (bytes: Uint8Array) => T): T;
  text(): string;
  release(): void;
}

export interface SecretStore {
  get(reference: SecretReference): Promise<SecretMaterial>;
}

const secretReferenceIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function assertSecretReferenceId(referenceId: string): void {
  if (!secretReferenceIdPattern.test(referenceId)) {
    throw new Error("Invalid secret reference ID");
  }
}

export function assertSecretReference(reference: SecretReference): void {
  assertSecretReferenceId(reference.reference_id);
  if (!Number.isSafeInteger(reference.version) || reference.version < 1) {
    throw new Error("Secret reference version must be a positive safe integer");
  }
  if (!secretPurposes.includes(reference.purpose)) {
    throw new Error("Invalid secret reference purpose");
  }
}
