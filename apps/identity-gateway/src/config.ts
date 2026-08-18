import { resolve } from "node:path";
import { isIP } from "node:net";

export interface IdentityGatewayConfig {
  readonly databaseUrl: string;
  readonly publicOrigins: ReadonlySet<string>;
  readonly cookieHost: string;
  readonly publicBaseUrl: string;
  readonly providerUrl: string;
  readonly providerPublishableKeyRef: string;
  readonly providerServiceRoleKeyRef: string;
  readonly appleWebRedirectUris: ReadonlySet<string>;
  readonly appleNativeRedirectUris: ReadonlySet<string>;
  readonly passwordResetRedirectUri: string;
  readonly emailVerificationRedirectUri: string;
  readonly sessionHmacKeyRef: string;
  readonly piiHmacKeyRef: string;
  readonly signingKeyRef: string;
  readonly host: "127.0.0.1" | "0.0.0.0";
  readonly port: number;
  readonly publicAuthEnabled: boolean;
  readonly trustedProxyAddresses: ReadonlySet<string>;
}

const allowedIdentityKeys = new Set([
  "IDENTITY_DATABASE_URL",
  "IDENTITY_PUBLIC_ORIGINS",
  "IDENTITY_COOKIE_HOST",
  "IDENTITY_PUBLIC_BASE_URL",
  "IDENTITY_PROVIDER_URL",
  "IDENTITY_PROVIDER_PUBLISHABLE_KEY_REF",
  "IDENTITY_PROVIDER_SERVICE_ROLE_KEY_REF",
  "IDENTITY_APPLE_WEB_REDIRECT_URIS",
  "IDENTITY_APPLE_NATIVE_REDIRECT_URIS",
  "IDENTITY_PASSWORD_RESET_REDIRECT_URI",
  "IDENTITY_EMAIL_VERIFICATION_REDIRECT_URI",
  "IDENTITY_SESSION_HMAC_KEY_REF",
  "IDENTITY_PII_HMAC_KEY_REF",
  "IDENTITY_SIGNING_KEY_REF",
  "IDENTITY_GATEWAY_HOST",
  "IDENTITY_GATEWAY_PORT",
  "IDENTITY_GATEWAY_CONTAINER_BIND",
  "IDENTITY_PUBLIC_AUTH_ENABLED",
  "IDENTITY_TRUSTED_PROXY_ADDRESSES",
]);

function invalidConfiguration(): never {
  throw new Error("Identity Gateway configuration is invalid");
}

function required(environment: NodeJS.ProcessEnv, key: string): string {
  const value = environment[key];
  if (value === undefined || value.trim() !== value || value.length < 1 || value.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(value)) invalidConfiguration();
  return value;
}

function exactBoolean(value: string): boolean {
  if (value === "1") return true;
  if (value === "0") return false;
  invalidConfiguration();
}

function exactUrl(value: string, protocols: ReadonlySet<string>, production: boolean): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    invalidConfiguration();
  }
  if (!protocols.has(parsed.protocol) || parsed.username !== "" || parsed.password !== "" || parsed.hash !== "") invalidConfiguration();
  if (production && parsed.protocol === "http:") invalidConfiguration();
  return parsed;
}

function exactOrigin(value: string, production: boolean): string {
  const parsed = exactUrl(value, new Set(["https:", "http:"]), production);
  if (parsed.origin !== value || parsed.pathname !== "/" || parsed.search !== "") invalidConfiguration();
  return value;
}

function exactUrlList(value: string, protocols: ReadonlySet<string>, production: boolean): ReadonlySet<string> {
  const entries = value.split(",");
  if (entries.length < 1 || entries.length > 128 || entries.some((entry) => entry.length < 1 || entry.trim() !== entry)) invalidConfiguration();
  const unique = new Set<string>();
  for (const entry of entries) {
    const parsed = exactUrl(entry, protocols, production);
    if ((parsed.toString() !== entry && parsed.href !== entry) || parsed.search !== "") invalidConfiguration();
    unique.add(entry);
  }
  if (unique.size !== entries.length) invalidConfiguration();
  return unique;
}

function reference(value: string): string {
  if (!/^(?:\/[A-Za-z0-9]|[A-Za-z0-9])[A-Za-z0-9._:/-]{0,1023}$/u.test(value) || value === "." || value === "..") invalidConfiguration();
  return value;
}

function databaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    invalidConfiguration();
  }
  if ((parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:")
    || parsed.password !== "" || parsed.hash !== "" || parsed.pathname.length < 2
    || parsed.username.length > 255) invalidConfiguration();
  return value;
}

function publicBaseUrl(value: string, production: boolean): string {
  const parsed = exactUrl(value, new Set(["https:", "http:"]), production);
  if (parsed.pathname !== "/" || parsed.search !== "" || parsed.toString() !== `${value}/`) {
    if (parsed.pathname !== "/" || parsed.search !== "" || parsed.origin !== value) invalidConfiguration();
  }
  return parsed.origin;
}

function cookieHost(value: string): string {
  if (value !== value.toLowerCase() || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/u.test(value)) invalidConfiguration();
  return value;
}

function trustedProxyAddresses(value: string | undefined): ReadonlySet<string> {
  if (value === undefined || value === "") return new Set();
  const entries = value.split(",");
  if (entries.length > 128 || entries.some((entry) => entry.length < 1 || entry.trim() !== entry || isIP(entry) === 0)) {
    invalidConfiguration();
  }
  const unique = new Set(entries);
  if (unique.size !== entries.length) invalidConfiguration();
  return unique;
}

function port(value: string): number {
  if (!/^[1-9]\d{0,4}$/u.test(value)) invalidConfiguration();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 65_535) invalidConfiguration();
  return parsed;
}

export function loadIdentityGatewayConfig(environment: NodeJS.ProcessEnv): IdentityGatewayConfig {
  for (const key of Object.keys(environment)) {
    if (key.startsWith("IDENTITY_") && !allowedIdentityKeys.has(key)) invalidConfiguration();
  }
  const production = environment.NODE_ENV === "production";
  const publicOrigins = new Set(required(environment, "IDENTITY_PUBLIC_ORIGINS").split(",").map((value) => exactOrigin(value, production)));
  if (publicOrigins.size < 1) invalidConfiguration();
  const configuredCookieHost = cookieHost(required(environment, "IDENTITY_COOKIE_HOST"));
  const configuredPublicBaseUrl = publicBaseUrl(required(environment, "IDENTITY_PUBLIC_BASE_URL"), production);
  const providerUrl = publicBaseUrl(required(environment, "IDENTITY_PROVIDER_URL"), production);
  if (new URL(configuredPublicBaseUrl).hostname !== configuredCookieHost || configuredPublicBaseUrl === providerUrl) invalidConfiguration();
  const hostValue = environment.IDENTITY_GATEWAY_HOST ?? "127.0.0.1";
  if (hostValue !== "127.0.0.1" && hostValue !== "0.0.0.0") invalidConfiguration();
  const containerBind = exactBoolean(environment.IDENTITY_GATEWAY_CONTAINER_BIND ?? "0");
  if ((hostValue === "0.0.0.0") !== containerBind) invalidConfiguration();

  return Object.freeze({
    databaseUrl: databaseUrl(required(environment, "IDENTITY_DATABASE_URL")),
    publicOrigins,
    cookieHost: configuredCookieHost,
    publicBaseUrl: configuredPublicBaseUrl,
    providerUrl,
    providerPublishableKeyRef: reference(required(environment, "IDENTITY_PROVIDER_PUBLISHABLE_KEY_REF")),
    providerServiceRoleKeyRef: reference(required(environment, "IDENTITY_PROVIDER_SERVICE_ROLE_KEY_REF")),
    appleWebRedirectUris: exactUrlList(required(environment, "IDENTITY_APPLE_WEB_REDIRECT_URIS"), new Set(["https:", "http:"]), production),
    appleNativeRedirectUris: exactUrlList(required(environment, "IDENTITY_APPLE_NATIVE_REDIRECT_URIS"), new Set(["coreagent:"]), false),
    passwordResetRedirectUri: (() => {
      const value = required(environment, "IDENTITY_PASSWORD_RESET_REDIRECT_URI");
      const parsed = exactUrl(value, new Set(["https:", "http:"]), production);
      if (parsed.search !== "" || parsed.toString() !== value) invalidConfiguration();
      return value;
    })(),
    emailVerificationRedirectUri: (() => {
      const value = required(environment, "IDENTITY_EMAIL_VERIFICATION_REDIRECT_URI");
      const parsed = exactUrl(value, new Set(["https:", "http:"]), production);
      if (parsed.origin !== configuredPublicBaseUrl || parsed.search !== ""
        || parsed.pathname !== "/auth/v1/email/verification" || parsed.toString() !== value) invalidConfiguration();
      return value;
    })(),
    sessionHmacKeyRef: reference(required(environment, "IDENTITY_SESSION_HMAC_KEY_REF")),
    piiHmacKeyRef: reference(required(environment, "IDENTITY_PII_HMAC_KEY_REF")),
    signingKeyRef: reference(required(environment, "IDENTITY_SIGNING_KEY_REF")),
    host: hostValue,
    port: port(required(environment, "IDENTITY_GATEWAY_PORT")),
    publicAuthEnabled: exactBoolean(required(environment, "IDENTITY_PUBLIC_AUTH_ENABLED")),
    trustedProxyAddresses: trustedProxyAddresses(environment.IDENTITY_TRUSTED_PROXY_ADDRESSES),
  });
}

export function assertManagedSecretFile(path: string): string {
  if (path.length < 1 || path.length > 4_096 || resolve(path) !== path || /[\u0000-\u001f\u007f]/u.test(path)) invalidConfiguration();
  return path;
}
