export interface ManagedImageLock {
  readonly schemaVersion: 1;
  readonly repository: string;
  readonly tag: string;
  readonly platforms: Readonly<Record<"linux/amd64" | "linux/arm64", { readonly reference: string }>>;
}

const repositoryPattern = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]{1,5})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;
const imageTagPattern = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const imageDigestPattern = /^[a-f0-9]{64}$/;

function invalid(): never {
  throw new Error("Managed image lock is invalid");
}

function exactRecord(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    invalid();
  }
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length
    || actual.some((key) => typeof key !== "string" || !keys.includes(key))
    || keys.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable;
    })
  ) invalid();
}

export function loadRuntimeImageLock(value: unknown): ManagedImageLock {
  exactRecord(value, ["schemaVersion", "repository", "tag", "platforms"]);
  if (
    value.schemaVersion !== 1
    || typeof value.repository !== "string"
    || !repositoryPattern.test(value.repository)
    || typeof value.tag !== "string"
    || !imageTagPattern.test(value.tag)
  ) invalid();
  const repository = value.repository;
  const tag = value.tag;
  const expectedReferencePrefix = `${repository}:${tag}@sha256:`;
  exactRecord(value.platforms, ["linux/amd64", "linux/arm64"]);
  const platforms = {} as Record<"linux/amd64" | "linux/arm64", { readonly reference: string }>;
  for (const platform of ["linux/amd64", "linux/arm64"] as const) {
    exactRecord(value.platforms[platform], ["reference"]);
    const reference = value.platforms[platform].reference;
    if (
      typeof reference !== "string"
      || !reference.startsWith(expectedReferencePrefix)
      || !imageDigestPattern.test(reference.slice(expectedReferencePrefix.length))
    ) invalid();
    platforms[platform] = Object.freeze({ reference });
  }
  return Object.freeze({
    schemaVersion: 1,
    repository,
    tag,
    platforms: Object.freeze(platforms),
  });
}
