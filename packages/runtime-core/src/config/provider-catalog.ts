export interface ProviderConfig {
  readonly provider_config_id: string;
  readonly base_url: string;
  readonly model_ids: readonly string[];
  readonly credential_secret_ref: string;
  readonly timeout_ms: number;
  readonly max_safe_retries: number;
}

const providerConfigKeys = [
  "provider_config_id",
  "base_url",
  "model_ids",
  "credential_secret_ref",
  "timeout_ms",
  "max_safe_retries",
] as const;

type ProviderConfigKey = (typeof providerConfigKeys)[number];

type ProviderConfigInput = Record<ProviderConfigKey, unknown>;

function catalogError(reason: string): Error {
  return new Error(`Provider catalog ${reason}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum;
}

function canonicalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
}

function isLinkLocalIpv4(hostname: string): boolean {
  const ipv4 = hostname.split(".");
  if (
    ipv4.length === 4
    && ipv4.every((part) => /^\d+$/.test(part))
    && ipv4.every((part) => Number(part) <= 255)
    && Number(ipv4[0]) === 169
    && Number(ipv4[1]) === 254
  ) {
    return true;
  }

  return false;
}

function isIpv4MappedLinkLocalIpv6(hostname: string): boolean {
  const mappedIpv4 = hostname.match(/^::ffff:(.+)$/i)?.[1];
  if (mappedIpv4 === undefined) {
    return false;
  }
  if (isLinkLocalIpv4(mappedIpv4)) {
    return true;
  }

  const hextets = mappedIpv4.split(":");
  if (hextets.length !== 2 || !hextets.every((part) => /^[0-9a-f]{1,4}$/i.test(part))) {
    return false;
  }
  const firstHextet = Number.parseInt(hextets[0]!, 16);
  return (firstHextet >>> 8) === 169 && (firstHextet & 0xff) === 254;
}

function isLinkLocalHostname(hostname: string): boolean {
  const normalized = canonicalizeHostname(hostname);
  if (isLinkLocalIpv4(normalized) || isIpv4MappedLinkLocalIpv6(normalized)) {
    return true;
  }

  const firstHextet = normalized.split(":")[0];
  if (firstHextet === undefined || !/^[0-9a-f]{1,4}$/i.test(firstHextet)) {
    return false;
  }
  const firstHextetValue = Number.parseInt(firstHextet, 16);
  return firstHextetValue >= 0xfe80 && firstHextetValue <= 0xfebf;
}

function validateBaseUrl(value: unknown): string {
  if (!isNonEmptyString(value)) {
    throw catalogError("base_url must be an HTTPS URL");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw catalogError("base_url must be an HTTPS URL");
  }

  if (
    url.protocol !== "https:"
    || url.username.length > 0
    || url.password.length > 0
    || url.hash.length > 0
    || canonicalizeHostname(url.hostname) === "localhost"
    || canonicalizeHostname(url.hostname).endsWith(".localhost")
    || isLinkLocalHostname(url.hostname)
  ) {
    throw catalogError("base_url must be an HTTPS URL without unsafe routing");
  }

  return url.toString();
}

function validateInput(value: unknown): ProviderConfigInput {
  if (!isRecord(value)) {
    throw catalogError("entries must be objects");
  }

  const keys = Object.keys(value);
  if (
    keys.length !== providerConfigKeys.length
    || keys.some((key) => !providerConfigKeys.includes(key as ProviderConfigKey))
  ) {
    throw catalogError("entries must use the managed provider configuration fields");
  }

  if (!providerConfigKeys.every((key) => Object.hasOwn(value, key))) {
    throw catalogError("entries must use the managed provider configuration fields");
  }

  return value as ProviderConfigInput;
}

export function loadProviderCatalog(value: unknown): readonly ProviderConfig[] {
  if (!Array.isArray(value)) {
    throw catalogError("must be an array");
  }

  const providerIds = new Set<string>();
  return value.map((entry) => {
    const input = validateInput(entry);
    if (!isNonEmptyString(input.provider_config_id)) {
      throw catalogError("provider_config_id must be a non-empty string");
    }
    const providerConfigId = input.provider_config_id.trim();
    if (providerIds.has(providerConfigId)) {
      throw catalogError("contains a duplicate provider_config_id");
    }
    providerIds.add(providerConfigId);

    const baseUrl = validateBaseUrl(input.base_url);
    if (!Array.isArray(input.model_ids) || input.model_ids.length === 0 || !input.model_ids.every(isNonEmptyString)) {
      throw catalogError("model_ids must be a non-empty allowlist");
    }
    if (!isNonEmptyString(input.credential_secret_ref)) {
      throw catalogError("credential_secret_ref must be a non-empty string");
    }
    if (!isIntegerInRange(input.timeout_ms, 1_000, 120_000)) {
      throw catalogError("timeout_ms must be an integer from 1000 through 120000");
    }
    if (!isIntegerInRange(input.max_safe_retries, 0, 3)) {
      throw catalogError("max_safe_retries must be an integer from 0 through 3");
    }

    return {
      provider_config_id: providerConfigId,
      base_url: baseUrl,
      model_ids: input.model_ids.map((modelId) => modelId.trim()),
      credential_secret_ref: input.credential_secret_ref.trim(),
      timeout_ms: input.timeout_ms,
      max_safe_retries: input.max_safe_retries,
    };
  });
}
