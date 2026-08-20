import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const STAGES = Object.freeze([
  ["PREFLIGHT", "preflight"],
  ["EMAIL_VERIFICATION", "emailVerification"],
  ["PASSWORD_SIGN_IN", "passwordSignIn"],
  ["PASSWORD_REAUTHENTICATION", "passwordReauthentication"],
  ["PASSWORD_RESET", "passwordReset"],
  ["APPLE_SAME_EMAIL_LINK", "appleSameEmailLink"],
  ["APPLE_RELAY_MANUAL_LINK", "appleRelayManualLink"],
  ["GLOBAL_LOGOUT", "globalLogout"],
]);
const STAGE_CODES = new Set([...STAGES.map(([code]) => code), "CLEANUP"]);
const REPORT_KEYS = new Set([
  "schema_version", "acceptance_mode", "started_at", "finished_at", "status",
  "cleanup_status", "known_limitations", "stages", "failure_code",
]);
const REPORT_STAGE_KEYS = new Set(["code", "status", "duration_ms"]);
const MAX_SECRET_BYTES = 65_536;
const OAUTH_TIMEOUT_MS = 5 * 60_000;

class AcceptanceFailure extends Error {
  constructor(code) {
    super(code);
    this.name = "AcceptanceFailure";
  }
}

function exactKeys(value, allowed, required) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.every((key) => allowed.has(key)) && required.every((key) => keys.includes(key));
}

function validIso(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    && Number.isFinite(Date.parse(value));
}

export function validateAcceptanceReport(report) {
  const required = [
    "schema_version", "acceptance_mode", "started_at", "finished_at", "status",
    "cleanup_status", "known_limitations", "stages",
  ];
  if (!exactKeys(report, REPORT_KEYS, required)) return false;
  if (report.schema_version !== 1 || report.acceptance_mode !== "real_supabase_apple") return false;
  if (!validIso(report.started_at) || !validIso(report.finished_at)
    || Date.parse(report.finished_at) < Date.parse(report.started_at)) return false;
  if (report.status !== "passed" && report.status !== "failed") return false;
  if (report.cleanup_status !== "passed" && report.cleanup_status !== "failed") return false;
  if (!Array.isArray(report.known_limitations)
    || report.known_limitations.length !== 1 || report.known_limitations[0] !== "MFA_NOT_ENABLED") return false;
  if (!Array.isArray(report.stages) || report.stages.length < 2 || report.stages.length > STAGES.length + 1) return false;
  if (!report.stages.every((stage) => exactKeys(stage, REPORT_STAGE_KEYS, [...REPORT_STAGE_KEYS])
    && STAGE_CODES.has(stage.code)
    && (stage.status === "passed" || stage.status === "failed")
    && Number.isSafeInteger(stage.duration_ms) && stage.duration_ms >= 0)) return false;
  const codes = report.stages.map((stage) => stage.code);
  if (new Set(codes).size !== codes.length || codes.at(-1) !== "CLEANUP") return false;
  const execution = report.stages.slice(0, -1);
  if (execution.some((stage, index) => stage.code !== STAGES[index]?.[0])) return false;
  const failedExecution = execution.findIndex((stage) => stage.status === "failed");
  if (failedExecution !== -1 && (failedExecution !== execution.length - 1
    || execution.slice(0, failedExecution).some((stage) => stage.status !== "passed"))) return false;
  if (report.status === "passed") {
    if ("failure_code" in report || report.cleanup_status !== "passed") return false;
    if (codes.length !== STAGES.length + 1 || report.stages.some((stage) => stage.status !== "passed")) return false;
  } else {
    if (typeof report.failure_code !== "string"
      || !/^(?:PREFLIGHT|EMAIL_VERIFICATION|PASSWORD_SIGN_IN|PASSWORD_REAUTHENTICATION|PASSWORD_RESET|APPLE_SAME_EMAIL_LINK|APPLE_RELAY_MANUAL_LINK|GLOBAL_LOGOUT|CLEANUP)_FAILED$/u.test(report.failure_code)) return false;
    if (!report.stages.some((stage) => stage.status === "failed")) return false;
    if (failedExecution === -1 && report.stages.at(-1)?.status !== "failed") return false;
  }
  return true;
}

async function safeExistingReport(path) {
  try {
    const metadata = await lstat(path);
    return metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1
      && metadata.uid === process.getuid?.() && (metadata.mode & 0o7777) === 0o600;
  } catch (error) {
    return error?.code === "ENOENT";
  }
}

async function assertSafeReportDestination(path) {
  const target = resolve(path);
  const directory = await lstat(dirname(target));
  if (!directory.isDirectory() || directory.isSymbolicLink()
    || directory.uid !== process.getuid?.() || (directory.mode & 0o022) !== 0) {
    throw new AcceptanceFailure("UNSAFE_REPORT_DIRECTORY");
  }
  if (!(await safeExistingReport(target))) throw new AcceptanceFailure("UNSAFE_REPORT_TARGET");
  return target;
}

async function writeAcceptanceReport(path, report) {
  if (!validateAcceptanceReport(report)) throw new AcceptanceFailure("INVALID_REPORT");
  const target = await assertSafeReportDestination(path);
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(report)}\n`, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function duration(started) {
  return Math.max(0, Math.round(performance.now() - started));
}

export async function runProviderAcceptance({ driver, reportPath, now = () => new Date() }) {
  if (driver === null || typeof driver !== "object" || typeof reportPath !== "string" || reportPath.length === 0) {
    throw new AcceptanceFailure("INVALID_CONFIGURATION");
  }
  await assertSafeReportDestination(reportPath);
  const report = {
    schema_version: 1,
    acceptance_mode: "real_supabase_apple",
    started_at: now().toISOString(),
    finished_at: "",
    status: "passed",
    cleanup_status: "passed",
    known_limitations: ["MFA_NOT_ENABLED"],
    stages: [],
  };
  for (const [code, method] of STAGES) {
    const started = performance.now();
    try {
      if (typeof driver[method] !== "function") throw new AcceptanceFailure("INVALID_DRIVER");
      await driver[method]();
      report.stages.push({ code, status: "passed", duration_ms: duration(started) });
    } catch {
      report.status = "failed";
      report.failure_code = `${code}_FAILED`;
      report.stages.push({ code, status: "failed", duration_ms: duration(started) });
      break;
    }
  }
  const cleanupStarted = performance.now();
  try {
    if (typeof driver.cleanup !== "function") throw new AcceptanceFailure("INVALID_DRIVER");
    await driver.cleanup();
    report.stages.push({ code: "CLEANUP", status: "passed", duration_ms: duration(cleanupStarted) });
  } catch {
    report.status = "failed";
    report.cleanup_status = "failed";
    report.failure_code ??= "CLEANUP_FAILED";
    report.stages.push({ code: "CLEANUP", status: "failed", duration_ms: duration(cleanupStarted) });
  }
  report.finished_at = now().toISOString();
  await writeAcceptanceReport(reportPath, report);
  return report;
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink
    && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function readProtectedText(path) {
  const resolved = resolve(path);
  const namedBefore = await lstat(resolved);
  const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  const scratch = Buffer.alloc(MAX_SECRET_BYTES + 1);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.()
      || ![0o400, 0o600].includes(before.mode & 0o7777) || before.size < 1 || before.size > MAX_SECRET_BYTES
      || !sameFile(namedBefore, before)) throw new AcceptanceFailure("UNSAFE_INPUT_FILE");
    const { bytesRead } = await handle.read(scratch, 0, scratch.length, 0);
    const [after, namedAfter] = await Promise.all([handle.stat(), lstat(resolved)]);
    if (bytesRead !== before.size || !sameFile(before, after) || !sameFile(after, namedAfter)) {
      throw new AcceptanceFailure("UNSTABLE_INPUT_FILE");
    }
    const value = scratch.subarray(0, bytesRead).toString("utf8").trim();
    if (value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) throw new AcceptanceFailure("INVALID_INPUT_FILE");
    return value;
  } finally {
    scratch.fill(0);
    await handle.close().catch(() => undefined);
  }
}

function required(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0) throw new AcceptanceFailure("INVALID_CONFIGURATION");
  return value;
}

function email(value) {
  if (value.length > 254 || value !== value.toLowerCase()
    || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/u.test(value)) {
    throw new AcceptanceFailure("INVALID_TEST_IDENTITY");
  }
  return value;
}

function loopbackRedirect(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || parsed.username !== ""
    || parsed.password !== "" || parsed.port === "" || parsed.search !== "" || parsed.hash !== ""
    || parsed.pathname !== "/identity-provider-acceptance/callback") {
    throw new AcceptanceFailure("INVALID_REDIRECT");
  }
  return parsed;
}

async function loadLiveConfiguration(environment) {
  if (environment.CORE_AGENT_SUPABASE_ACCEPTANCE !== "1") throw new AcceptanceFailure("NOT_ENABLED");
  if (environment.CORE_AGENT_ACCEPTANCE_CONFIRM_DISPOSABLE !== "1"
    || environment.CORE_AGENT_ACCEPTANCE_CONFIRM_SYNTHETIC !== "1") {
    throw new AcceptanceFailure("INVALID_CONFIGURATION");
  }
  const [supabaseUrlText, publishableKey, serviceRoleKey, sameEmailText, relayEmailText] = await Promise.all([
    readProtectedText(required(environment, "CORE_AGENT_SUPABASE_URL_FILE")),
    readProtectedText(required(environment, "CORE_AGENT_SUPABASE_PUBLISHABLE_KEY_FILE")),
    readProtectedText(required(environment, "CORE_AGENT_SUPABASE_SERVICE_ROLE_KEY_FILE")),
    readProtectedText(required(environment, "CORE_AGENT_APPLE_SAME_EMAIL_FILE")),
    readProtectedText(required(environment, "CORE_AGENT_APPLE_RELAY_EMAIL_FILE")),
  ]);
  const supabaseUrl = new URL(supabaseUrlText);
  if (supabaseUrl.protocol !== "https:" || !supabaseUrl.hostname.endsWith(".supabase.co")
    || supabaseUrl.username !== "" || supabaseUrl.password !== "" || supabaseUrl.search !== ""
    || supabaseUrl.hash !== "") throw new AcceptanceFailure("INVALID_SUPABASE_PROJECT");
  const sameEmail = email(sameEmailText);
  const relayEmail = email(relayEmailText);
  if (sameEmail === relayEmail || !relayEmail.endsWith("@privaterelay.appleid.com")) {
    throw new AcceptanceFailure("INVALID_TEST_IDENTITY");
  }
  const syntheticDomain = required(environment, "CORE_AGENT_ACCEPTANCE_SYNTHETIC_DOMAIN").toLowerCase();
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/u.test(syntheticDomain)
    || sameEmail.endsWith(`@${syntheticDomain}`) === false) throw new AcceptanceFailure("INVALID_TEST_IDENTITY");
  if (publishableKey.length < 20 || serviceRoleKey.length < 20 || publishableKey === serviceRoleKey) {
    throw new AcceptanceFailure("INVALID_CONFIGURATION");
  }
  return {
    supabaseUrl: supabaseUrl.toString().replace(/\/$/u, ""), publishableKey, serviceRoleKey,
    sameEmail, relayEmail, syntheticDomain,
    redirect: loopbackRedirect(required(environment, "CORE_AGENT_APPLE_REDIRECT_URI")),
    reportPath: required(environment, "CORE_AGENT_ACCEPTANCE_REPORT_PATH"),
  };
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => values.set(key, value),
    removeItem: async (key) => values.delete(key),
    clear: () => values.clear(),
  };
}

function providerError(result) {
  if (result?.error !== null && result?.error !== undefined) throw new AcceptanceFailure("PROVIDER_REJECTED");
  return result?.data;
}

function exactUser(data, expectedId) {
  if (typeof data?.user?.id !== "string" || data.user.id !== expectedId) throw new AcceptanceFailure("SUBJECT_MISMATCH");
  return data.user;
}

function password() {
  return `${randomBytes(24).toString("base64url")}aA7!`;
}

function identityEmail(user, provider) {
  const identity = user.identities?.find((candidate) => candidate.provider === provider);
  const value = identity?.identity_data?.email;
  return typeof value === "string" ? value.toLowerCase() : undefined;
}

async function openBrowser(url) {
  const command = process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : undefined;
  if (command === undefined) throw new AcceptanceFailure("BROWSER_UNAVAILABLE");
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, [url], { stdio: "ignore" });
    child.once("error", () => reject(new AcceptanceFailure("BROWSER_UNAVAILABLE")));
    child.once("exit", (code) => code === 0 ? resolvePromise() : reject(new AcceptanceFailure("BROWSER_UNAVAILABLE")));
  });
}

async function receiveOAuth(redirect, start) {
  let resolveCallback;
  let rejectCallback;
  const callback = new Promise((resolvePromise, reject) => {
    resolveCallback = resolvePromise;
    rejectCallback = reject;
  });
  const server = createServer((request, response) => {
    try {
      const received = new URL(request.url ?? "", redirect.origin);
      if (request.method !== "GET" || received.pathname !== redirect.pathname
        || received.searchParams.has("error") || received.searchParams.getAll("code").length !== 1) {
        throw new AcceptanceFailure("OAUTH_CALLBACK_INVALID");
      }
      const code = received.searchParams.get("code");
      if (code === null || code.length < 8 || code.length > 16_384) throw new AcceptanceFailure("OAUTH_CALLBACK_INVALID");
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      response.end("Core-Agent provider acceptance received. Return to the terminal.");
      resolveCallback(code);
    } catch {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      response.end("Core-Agent provider acceptance rejected the callback.");
      rejectCallback(new AcceptanceFailure("OAUTH_CALLBACK_INVALID"));
    }
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", () => reject(new AcceptanceFailure("CALLBACK_LISTENER_FAILED")));
    server.listen(Number(redirect.port), redirect.hostname, resolvePromise);
  });
  let timer;
  try {
    const started = await start();
    const authorizationUrl = new URL(started.url);
    if (authorizationUrl.protocol !== "https:" || started.url.length > 2_048
      || typeof started.flowId !== "string" || started.flowId.length < 8) {
      throw new AcceptanceFailure("OAUTH_START_INVALID");
    }
    await openBrowser(started.url);
    const code = await Promise.race([
      callback,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new AcceptanceFailure("OAUTH_CALLBACK_TIMEOUT")), OAUTH_TIMEOUT_MS);
      }),
    ]);
    return { code, flowId: started.flowId };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
}

export async function createLiveDriver(config, dependencies = {}) {
  const { createClient: installedCreateClient } = await import("@supabase/supabase-js");
  const createClient = dependencies.createClient ?? installedCreateClient;
  const oauthReceiver = dependencies.receiveOAuth ?? receiveOAuth;
  const storages = [];
  const newClient = () => {
    const storage = memoryStorage();
    storages.push(storage);
    return createClient(config.supabaseUrl, config.publishableKey, {
      auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: true, flowType: "pkce", storage },
    });
  };
  const admin = createClient(config.supabaseUrl, config.serviceRoleKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
  const state = {
    createdUserIds: [],
    sameUserId: undefined,
    manualUserId: undefined,
    currentPassword: password(),
    sessions: new Map(),
  };

  async function generatedUser(emailAddress, selectedPassword) {
    const data = providerError(await admin.auth.admin.generateLink({
      type: "signup", email: emailAddress, password: selectedPassword,
    }));
    if (typeof data?.properties?.hashed_token !== "string" || data.properties.hashed_token.length < 8
      || typeof data?.user?.id !== "string") throw new AcceptanceFailure("GENERATED_LINK_INVALID");
    state.createdUserIds.push(data.user.id);
    const client = newClient();
    const verified = providerError(await client.auth.verifyOtp({
      token_hash: data.properties.hashed_token, type: "email",
    }));
    exactUser(verified, data.user.id);
    return { id: data.user.id, client };
  }

  async function appleCallback(client, start) {
    const received = await oauthReceiver(config.redirect, start);
    return providerError(await client.auth.exchangeCodeForSession(received.code, { flowId: received.flowId }));
  }

  return {
    async preflight() {
      const data = providerError(await admin.auth.admin.listUsers({ page: 1, perPage: 1 }));
      if (!Array.isArray(data?.users) || data.users.length !== 0) throw new AcceptanceFailure("PROJECT_NOT_EMPTY");
    },
    async emailVerification() {
      const created = await generatedUser(config.sameEmail, state.currentPassword);
      state.sameUserId = created.id;
    },
    async passwordSignIn() {
      const client = newClient();
      const data = providerError(await client.auth.signInWithPassword({ email: config.sameEmail, password: state.currentPassword }));
      exactUser(data, state.sameUserId);
      if (typeof data.session?.access_token !== "string") throw new AcceptanceFailure("SESSION_MISSING");
      state.sessions.set(state.sameUserId, data.session.access_token);
    },
    async passwordReauthentication() {
      const client = newClient();
      const data = providerError(await client.auth.signInWithPassword({ email: config.sameEmail, password: state.currentPassword }));
      exactUser(data, state.sameUserId);
      if (typeof data.session?.access_token !== "string") throw new AcceptanceFailure("SESSION_MISSING");
      state.sessions.set(state.sameUserId, data.session.access_token);
    },
    async passwordReset() {
      const oldPassword = state.currentPassword;
      const nextPassword = password();
      const generated = providerError(await admin.auth.admin.generateLink({ type: "recovery", email: config.sameEmail }));
      if (typeof generated?.properties?.hashed_token !== "string") throw new AcceptanceFailure("GENERATED_LINK_INVALID");
      const recovery = newClient();
      const verified = providerError(await recovery.auth.verifyOtp({
        token_hash: generated.properties.hashed_token, type: "recovery",
      }));
      exactUser(verified, state.sameUserId);
      exactUser(providerError(await recovery.auth.updateUser({ password: nextPassword })), state.sameUserId);
      const oldAttempt = await newClient().auth.signInWithPassword({ email: config.sameEmail, password: oldPassword });
      if (oldAttempt.error === null || oldAttempt.data.session !== null) throw new AcceptanceFailure("OLD_PASSWORD_ACCEPTED");
      const signedIn = providerError(await newClient().auth.signInWithPassword({ email: config.sameEmail, password: nextPassword }));
      exactUser(signedIn, state.sameUserId);
      if (typeof signedIn.session?.access_token !== "string") throw new AcceptanceFailure("SESSION_MISSING");
      state.sessions.set(state.sameUserId, signedIn.session.access_token);
      state.currentPassword = nextPassword;
    },
    async appleSameEmailLink() {
      const client = newClient();
      const data = await appleCallback(client, async () => {
        const started = providerError(await client.auth.signInWithOAuth({
          provider: "apple",
          options: { redirectTo: config.redirect.toString(), skipBrowserRedirect: true, queryParams: { prompt: "login" } },
        }));
        return { url: started?.url, flowId: started?.flowId };
      });
      const user = exactUser(data, state.sameUserId);
      if (identityEmail(user, "apple") !== config.sameEmail || typeof data.session?.access_token !== "string") {
        throw new AcceptanceFailure("AUTOMATIC_LINK_MISSING");
      }
      state.sessions.set(state.sameUserId, data.session.access_token);
    },
    async appleRelayManualLink() {
      const manualPassword = password();
      const manualEmail = `core-agent-acceptance+${randomUUID()}@${config.syntheticDomain}`;
      const created = await generatedUser(manualEmail, manualPassword);
      state.manualUserId = created.id;
      const client = newClient();
      exactUser(providerError(await client.auth.signInWithPassword({ email: manualEmail, password: manualPassword })), created.id);
      const data = await appleCallback(client, async () => {
        const started = providerError(await client.auth.linkIdentity({
          provider: "apple",
          options: { redirectTo: config.redirect.toString(), skipBrowserRedirect: true, queryParams: { prompt: "login" } },
        }));
        return { url: started?.url, flowId: started?.flowId };
      });
      const user = exactUser(data, created.id);
      if (identityEmail(user, "apple") !== config.relayEmail || identityEmail(user, "apple") === manualEmail
        || typeof data.session?.access_token !== "string") throw new AcceptanceFailure("MANUAL_LINK_MISSING");
      state.sessions.set(created.id, data.session.access_token);
    },
    async globalLogout() {
      const unique = [...state.sessions.values()];
      if (unique.length < 2) throw new AcceptanceFailure("SESSION_MISSING");
      for (const token of unique) {
        providerError(await admin.auth.admin.signOut(token, "global"));
        const checked = await admin.auth.getUser(token);
        if (checked.error === null || checked.data.user !== null) throw new AcceptanceFailure("LOGOUT_NOT_ENFORCED");
      }
    },
    async cleanup() {
      let failed = false;
      for (const id of [...new Set(state.createdUserIds)].reverse()) {
        const result = await admin.auth.admin.deleteUser(id);
        if (result.error !== null) failed = true;
      }
      for (const storage of storages) storage.clear();
      state.sessions.clear();
      state.currentPassword = "";
      if (failed) throw new AcceptanceFailure("CLEANUP_FAILED");
    },
  };
}

async function main(environment = process.env) {
  if (environment.CORE_AGENT_SUPABASE_ACCEPTANCE !== "1") {
    process.stderr.write("IDENTITY_PROVIDER_ACCEPTANCE NOT_ENABLED\n");
    return 2;
  }
  let config;
  try {
    config = await loadLiveConfiguration(environment);
  } catch {
    process.stderr.write("IDENTITY_PROVIDER_ACCEPTANCE INVALID_CONFIGURATION\n");
    return 2;
  }
  try {
    const driver = await createLiveDriver(config);
    const report = await runProviderAcceptance({ driver, reportPath: config.reportPath });
    process.stdout.write(`IDENTITY_PROVIDER_ACCEPTANCE ${report.status === "passed" ? "PASSED" : "FAILED"}\n`);
    return report.status === "passed" ? 0 : 1;
  } catch {
    process.stderr.write("IDENTITY_PROVIDER_ACCEPTANCE FAILED\n");
    return 1;
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = await main();
}
