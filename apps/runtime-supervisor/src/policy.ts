import {
  deriveManagedRuntimeNames,
  validateSupervisorRequest,
  type ProviderCatalog,
  type SupervisorRequest,
  type SupervisorRequestV1,
} from "@core-agent/runtime-core";

export interface ManagedImageLock {
  readonly schemaVersion: 1;
  readonly repository: string;
  readonly tag: string;
  readonly platforms: Readonly<Record<"linux/amd64" | "linux/arm64", { readonly reference: string }>>;
}

export interface SupervisorPolicyDependencies {
  readonly imageLock: unknown;
  readonly providerCatalog: ProviderCatalog;
}

const labelPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const hermesProfilePattern = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const immutableImagePattern = /^[A-Za-z0-9][A-Za-z0-9./:_-]{0,511}@sha256:[a-f0-9]{64}$/;

export const deriveRuntimeNames = deriveManagedRuntimeNames;

function policyError(): Error {
  return new Error("SUPERVISOR_REJECTED: Runtime policy did not match managed configuration");
}

function exactRecord(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw policyError();
  }
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length
    || !keys.every((key) => Object.hasOwn(value, key))
    || actual.some((key) => typeof key !== "string" || !keys.includes(key))
    || keys.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable;
    })
  ) {
    throw policyError();
  }
}

function parseImageLock(value: unknown): ManagedImageLock {
  exactRecord(value, ["schemaVersion", "repository", "tag", "platforms"]);
  if (value.schemaVersion !== 1 || typeof value.repository !== "string" || typeof value.tag !== "string") throw policyError();
  exactRecord(value.platforms, ["linux/amd64", "linux/arm64"]);
  for (const platform of ["linux/amd64", "linux/arm64"] as const) {
    exactRecord(value.platforms[platform], ["reference"]);
    if (typeof value.platforms[platform].reference !== "string" || !immutableImagePattern.test(value.platforms[platform].reference)) {
      throw policyError();
    }
  }
  return value as unknown as ManagedImageLock;
}

export function validateSupervisorPolicy(
  value: unknown,
  dependencies: SupervisorPolicyDependencies,
): SupervisorRequest {
  const request = validateSupervisorRequest(value);
  if (request.kind !== "provision") return request;
  const runtime = request.runtime;
  let names;
  try {
    names = deriveManagedRuntimeNames(runtime);
  } catch {
    throw policyError();
  }
  if (!labelPattern.test(runtime.volume_ref)) throw policyError();
  if (runtime.volume_ref !== names.volume) throw policyError();
  const imageLock = parseImageLock(dependencies.imageLock);
  if (runtime.image_ref !== imageLock.platforms[runtime.platform].reference) throw policyError();
  if (runtime.ingress_secret_ref.purpose !== "hermes_ingress") throw policyError();

  const profileIds = new Set<string>();
  const hermesReferences = new Set<string>();
  for (const profile of runtime.profiles) {
    if (!labelPattern.test(profile.profile_id) || !hermesProfilePattern.test(profile.hermes_profile_ref)) throw policyError();
    if (profile.description.length < 1 || profile.description.length > 2_000) throw policyError();
    if (profileIds.has(profile.profile_id) || hermesReferences.has(profile.hermes_profile_ref)) throw policyError();
    profileIds.add(profile.profile_id);
    hermesReferences.add(profile.hermes_profile_ref);

    let provider;
    try {
      provider = dependencies.providerCatalog.require(profile.provider_config_id, profile.model_id);
    } catch {
      throw policyError();
    }
    if (
      profile.provider_base_url !== provider.base_url
      || profile.provider_secret_ref.reference_id !== provider.credential_secret_ref
      || profile.provider_secret_ref.purpose !== "model_provider"
    ) throw policyError();
  }
  return request;
}
