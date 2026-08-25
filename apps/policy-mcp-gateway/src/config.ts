import { resolve } from "node:path";

export interface PolicyGatewayConfig {
  readonly databaseUrl: string; readonly host: "127.0.0.1" | "0.0.0.0"; readonly port: number;
  readonly workerTokenFile: string; readonly pluginIdentitiesFile: string; readonly runtimeIdentitiesFile: string;
  readonly proofKeyFile: string; readonly trustedContextKeysFile: string;
  readonly trustedContextIssuer: string; readonly trustedContextAudience: string;
}

const allowed = new Set([
  "POLICY_GATEWAY_DATABASE_URL", "POLICY_GATEWAY_HOST", "POLICY_GATEWAY_PORT", "POLICY_GATEWAY_CONTAINER_BIND",
  "POLICY_GATEWAY_WORKER_TOKEN_FILE", "POLICY_GATEWAY_PLUGIN_IDENTITIES_FILE", "POLICY_GATEWAY_RUNTIME_IDENTITIES_FILE",
  "POLICY_GATEWAY_PROOF_KEY_FILE", "POLICY_GATEWAY_TRUSTED_CONTEXT_KEYS_FILE", "POLICY_GATEWAY_TRUSTED_CONTEXT_ISSUER",
  "POLICY_GATEWAY_TRUSTED_CONTEXT_AUDIENCE",
]);
function invalid(): never { throw new Error("Policy Gateway configuration is invalid"); }
function required(environment: NodeJS.ProcessEnv, key: string): string {
  const value = environment[key];
  if (value === undefined || value.length < 1 || value.length > 4096 || value.trim() !== value || /[\0\r\n]/u.test(value)) invalid();
  return value;
}
function file(value: string): string {
  if (!value.startsWith("/") || resolve(value) !== value || value.includes("..")) invalid();
  return value;
}

export function loadPolicyGatewayConfig(environment: NodeJS.ProcessEnv): PolicyGatewayConfig {
  for (const key of Object.keys(environment)) if (key.startsWith("POLICY_GATEWAY_") && !allowed.has(key)) invalid();
  const host = environment.POLICY_GATEWAY_HOST ?? "127.0.0.1";
  const container = environment.POLICY_GATEWAY_CONTAINER_BIND ?? "0";
  if ((host !== "127.0.0.1" && host !== "0.0.0.0") || (host === "0.0.0.0") !== (container === "1")) invalid();
  const portValue = required(environment, "POLICY_GATEWAY_PORT");
  if (!/^[1-9]\d{0,4}$/u.test(portValue) || Number(portValue) > 65535) invalid();
  const databaseUrl = required(environment, "POLICY_GATEWAY_DATABASE_URL");
  let parsed: URL;
  try { parsed = new URL(databaseUrl); } catch { invalid(); }
  if (!new Set(["postgres:", "postgresql:"]).has(parsed.protocol) || parsed.password !== "" || parsed.pathname.length < 2) invalid();
  return Object.freeze({
    databaseUrl, host, port: Number(portValue), workerTokenFile: file(required(environment, "POLICY_GATEWAY_WORKER_TOKEN_FILE")),
    pluginIdentitiesFile: file(required(environment, "POLICY_GATEWAY_PLUGIN_IDENTITIES_FILE")),
    runtimeIdentitiesFile: file(required(environment, "POLICY_GATEWAY_RUNTIME_IDENTITIES_FILE")),
    proofKeyFile: file(required(environment, "POLICY_GATEWAY_PROOF_KEY_FILE")),
    trustedContextKeysFile: file(required(environment, "POLICY_GATEWAY_TRUSTED_CONTEXT_KEYS_FILE")),
    trustedContextIssuer: required(environment, "POLICY_GATEWAY_TRUSTED_CONTEXT_ISSUER"),
    trustedContextAudience: required(environment, "POLICY_GATEWAY_TRUSTED_CONTEXT_AUDIENCE"),
  });
}
