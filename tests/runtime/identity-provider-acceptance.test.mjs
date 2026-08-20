import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const acceptanceScript = resolve(repositoryRoot, "scripts/accept-supabase-auth.mjs");
const scannerScript = resolve(repositoryRoot, "scripts/verify-no-secret.mjs");

async function loadAcceptance() {
  return import(new URL("../../scripts/accept-supabase-auth.mjs", import.meta.url));
}

function fakeDriver(overrides = {}) {
  const calls = [];
  const driver = {};
  for (const name of [
    "preflight",
    "emailVerification",
    "passwordSignIn",
    "passwordReauthentication",
    "passwordReset",
    "appleSameEmailLink",
    "appleRelayManualLink",
    "globalLogout",
    "cleanup",
  ]) {
    driver[name] = async () => {
      calls.push(name);
      return overrides[name]?.();
    };
  }
  return { driver, calls };
}

test("provider acceptance is opt-in and its CLI failure is closed", () => {
  const result = spawnSync(process.execPath, [acceptanceScript], {
    cwd: repositoryRoot,
    env: { PATH: process.env.PATH },
  });
  assert.equal(result.status, 2);
  assert.equal(result.stdout.toString("utf8"), "");
  assert.equal(result.stderr.toString("utf8"), "IDENTITY_PROVIDER_ACCEPTANCE NOT_ENABLED\n");
});

test("provider acceptance records only closed stages and always cleans up", async () => {
  const { runProviderAcceptance, validateAcceptanceReport } = await loadAcceptance();
  const directory = await mkdtemp(join(tmpdir(), "identity-provider-acceptance-"));
  const reportPath = join(directory, "report.json");
  const { driver, calls } = fakeDriver();
  const report = await runProviderAcceptance({ driver, reportPath });

  assert.equal(report.status, "passed");
  assert.equal(report.cleanup_status, "passed");
  assert.deepEqual(calls, [
    "preflight",
    "emailVerification",
    "passwordSignIn",
    "passwordReauthentication",
    "passwordReset",
    "appleSameEmailLink",
    "appleRelayManualLink",
    "globalLogout",
    "cleanup",
  ]);
  assert.equal(validateAcceptanceReport(report), true);
  assert.deepEqual(Object.keys(report).sort(), [
    "acceptance_mode",
    "cleanup_status",
    "finished_at",
    "known_limitations",
    "schema_version",
    "stages",
    "started_at",
    "status",
  ]);
  assert.equal((await readFile(reportPath, "utf8")).endsWith("\n"), true);
});

test("provider acceptance redacts thrown values and cleans up after failure", async () => {
  const { runProviderAcceptance } = await loadAcceptance();
  const directory = await mkdtemp(join(tmpdir(), "identity-provider-acceptance-failure-"));
  const reportPath = join(directory, "report.json");
  const sentinel = "private-provider-token@example.test";
  const { driver, calls } = fakeDriver({
    passwordSignIn() {
      throw new Error(sentinel);
    },
  });
  const report = await runProviderAcceptance({ driver, reportPath });
  const bytes = await readFile(reportPath);

  assert.equal(report.status, "failed");
  assert.equal(report.failure_code, "PASSWORD_SIGN_IN_FAILED");
  assert.equal(report.cleanup_status, "passed");
  assert.equal(bytes.includes(Buffer.from(sentinel)), false);
  assert.deepEqual(calls, ["preflight", "emailVerification", "passwordSignIn", "cleanup"]);
});

test("acceptance report scanner rejects extra or secret-bearing fields", async () => {
  const directory = await mkdtemp(join(tmpdir(), "identity-provider-report-scan-"));
  const cleanPath = join(directory, "clean.json");
  const unsafePath = join(directory, "unsafe.json");
  const { runProviderAcceptance } = await loadAcceptance();
  const { driver } = fakeDriver();
  await runProviderAcceptance({ driver, reportPath: cleanPath });
  await writeFile(unsafePath, JSON.stringify({
    ...(JSON.parse(await readFile(cleanPath, "utf8"))),
    provider_url: "private-provider-url",
  }), { mode: 0o600 });
  await chmod(unsafePath, 0o600);

  const clean = spawnSync(process.execPath, [scannerScript, "--identity-acceptance-report", cleanPath], {
    cwd: repositoryRoot,
  });
  assert.equal(clean.status, 0, clean.stderr.toString("utf8"));
  assert.equal(Buffer.concat([clean.stdout, clean.stderr]).length, 0);

  const unsafe = spawnSync(process.execPath, [scannerScript, "--identity-acceptance-report", unsafePath], {
    cwd: repositoryRoot,
  });
  assert.equal(unsafe.status, 1);
  assert.equal(Buffer.concat([unsafe.stdout, unsafe.stderr]).includes(Buffer.from("private-provider-url")), false);
});

test("acceptance report writer rejects symlink and permissive destinations", async () => {
  const { runProviderAcceptance } = await loadAcceptance();
  const directory = await mkdtemp(join(tmpdir(), "identity-provider-report-mode-"));
  const reportPath = join(directory, "report.json");
  const { driver, calls } = fakeDriver();
  await writeFile(reportPath, "{}", { mode: 0o644 });
  await assert.rejects(runProviderAcceptance({ driver, reportPath }));
  assert.deepEqual(calls, []);
});

test("installed Supabase 2.112.2 executes the complete provider acceptance sequence", async () => {
  const { createLiveDriver } = await loadAcceptance();
  const sameEmail = "apple-same@acceptance.example.test";
  const relayEmail = "relay@privaterelay.appleid.com";
  const sameUserId = "11111111-1111-4111-8111-111111111111";
  const manualUserId = "22222222-2222-4222-8222-222222222222";
  const users = new Map();
  const tokenUsers = new Map();
  const revokedUsers = new Set();
  const generatedTokens = new Map();
  const requests = [];
  let tokenSequence = 0;
  let oauthStarts = 0;

  const jwt = (userId) => {
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const value = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: userId, exp: Math.floor(Date.now() / 1000) + 3600 })}.signature`;
    tokenUsers.set(value, userId);
    return value;
  };
  const identity = (userId, provider, emailAddress) => ({
    identity_id: `${provider}-${userId}`, id: userId, user_id: userId, provider,
    identity_data: { email: emailAddress, sub: userId, email_verified: true, phone_verified: false },
    created_at: "2026-08-20T00:00:00Z", updated_at: "2026-08-20T00:00:00Z",
    last_sign_in_at: "2026-08-20T00:00:00Z", email: emailAddress,
  });
  const user = (id, emailAddress, providers = ["email"]) => ({
    id, aud: "authenticated", role: "authenticated", email: emailAddress,
    email_confirmed_at: "2026-08-20T00:00:00Z", confirmed_at: "2026-08-20T00:00:00Z",
    created_at: "2026-08-20T00:00:00Z", updated_at: "2026-08-20T00:00:00Z",
    app_metadata: { provider: providers.at(-1), providers }, user_metadata: {},
    identities: providers.map((provider) => identity(id, provider, provider === "apple" && id === manualUserId ? relayEmail : emailAddress)),
    is_anonymous: false,
  });
  const session = (selectedUser) => {
    const accessToken = jwt(selectedUser.id);
    return {
      access_token: accessToken, refresh_token: `refresh-${++tokenSequence}`, token_type: "bearer",
      expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: selectedUser,
    };
  };
  const json = (response, status, value) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "", "http://127.0.0.1");
    let bodyText = "";
    for await (const chunk of request) bodyText += chunk.toString("utf8");
    const body = bodyText.length === 0 ? {} : JSON.parse(bodyText);
    requests.push(`${request.method} ${url.pathname}${url.search}`);
    const bearer = request.headers.authorization?.replace(/^Bearer /u, "");
    const bearerUser = bearer === undefined ? undefined : tokenUsers.get(bearer);
    if (request.method === "GET" && url.pathname === "/auth/v1/admin/users") {
      json(response, 200, { users: [...users.values()] });
      return;
    }
    if (request.method === "POST" && url.pathname === "/auth/v1/admin/generate_link") {
      const emailAddress = body.email;
      let selectedUser = [...users.values()].find((candidate) => candidate.email === emailAddress);
      if (body.type === "signup") {
        const id = emailAddress === sameEmail ? sameUserId : manualUserId;
        selectedUser = user(id, emailAddress);
        selectedUser.password = body.password;
        users.set(id, selectedUser);
      }
      const hashedToken = `${body.type}-hashed-token-${generatedTokens.size + 1}`;
      generatedTokens.set(hashedToken, { id: selectedUser.id, type: body.type });
      json(response, 200, {
        action_link: "https://provider.invalid/action", email_otp: "000000", hashed_token: hashedToken,
        redirect_to: "https://provider.invalid/redirect", verification_type: body.type, ...selectedUser,
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/auth/v1/verify") {
      const generated = generatedTokens.get(body.token_hash);
      if (generated === undefined) return json(response, 400, { code: "otp_expired", message: "invalid" });
      json(response, 200, session(users.get(generated.id)));
      return;
    }
    if (request.method === "POST" && url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "password") {
      const selectedUser = [...users.values()].find((candidate) => candidate.email === body.email);
      if (selectedUser === undefined || selectedUser.password !== body.password) {
        return json(response, 400, { code: "invalid_credentials", message: "invalid" });
      }
      json(response, 200, session(selectedUser));
      return;
    }
    if (request.method === "PUT" && url.pathname === "/auth/v1/user" && bearerUser !== undefined) {
      const selectedUser = users.get(bearerUser);
      selectedUser.password = body.password;
      json(response, 200, { user: selectedUser });
      return;
    }
    if (request.method === "GET" && url.pathname === "/auth/v1/user/identities/authorize" && bearerUser === manualUserId) {
      json(response, 200, { url: "https://appleid.apple.com/auth/authorize?acceptance=relay" });
      return;
    }
    if (request.method === "POST" && url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "pkce") {
      const selectedUser = body.auth_code === "same-apple-code"
        ? user(sameUserId, sameEmail, ["email", "apple"])
        : user(manualUserId, users.get(manualUserId).email, ["email", "apple"]);
      selectedUser.password = users.get(selectedUser.id).password;
      users.set(selectedUser.id, selectedUser);
      json(response, 200, session(selectedUser));
      return;
    }
    if (request.method === "POST" && url.pathname === "/auth/v1/logout" && bearerUser !== undefined) {
      revokedUsers.add(bearerUser);
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method === "GET" && url.pathname === "/auth/v1/user" && bearerUser !== undefined) {
      if (revokedUsers.has(bearerUser)) return json(response, 401, { code: "bad_jwt", message: "invalid" });
      json(response, 200, { user: users.get(bearerUser) });
      return;
    }
    if (request.method === "DELETE" && url.pathname.startsWith("/auth/v1/admin/users/")) {
      const id = decodeURIComponent(url.pathname.split("/").at(-1));
      const selectedUser = users.get(id);
      users.delete(id);
      json(response, 200, { user: selectedUser });
      return;
    }
    json(response, 404, { code: "not_found", message: "not found" });
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  assert(address !== null && typeof address === "object");
  const config = {
    supabaseUrl: `http://127.0.0.1:${address.port}`,
    publishableKey: "publishable-acceptance-key",
    serviceRoleKey: "service-role-acceptance-key",
    sameEmail,
    relayEmail,
    syntheticDomain: "acceptance.example.test",
    redirect: new URL("http://127.0.0.1:54329/identity-provider-acceptance/callback"),
  };
  try {
    const driver = await createLiveDriver(config, {
      receiveOAuth: async (_redirect, start) => {
        const started = await start();
        oauthStarts += 1;
        assert.equal(typeof started.flowId, "string");
        return {
          code: started.url.includes("acceptance=relay") ? "relay-apple-code" : "same-apple-code",
          flowId: started.flowId,
        };
      },
    });
    for (const method of [
      "preflight", "emailVerification", "passwordSignIn", "passwordReauthentication", "passwordReset",
      "appleSameEmailLink", "appleRelayManualLink", "globalLogout", "cleanup",
    ]) await driver[method]();
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
  assert.equal(oauthStarts, 2);
  assert.equal(users.size, 0);
  assert.equal(requests.filter((entry) => entry.startsWith("POST /auth/v1/logout?scope=global")).length, 2);
  assert.equal(requests.filter((entry) => entry.startsWith("DELETE /auth/v1/admin/users/")).length, 2);
});

test("identity release documents pin exact gates, rollback, rotations, and deployment prohibitions", async () => {
  const [operations, testing, threat, adr, design] = await Promise.all([
    readFile(resolve(repositoryRoot, "docs/operations/identity-runtime-public-auth-v1.md"), "utf8"),
    readFile(resolve(repositoryRoot, "docs/testing/identity-runtime-public-auth-v1.md"), "utf8"),
    readFile(resolve(repositoryRoot, "docs/security/runtime-v1-threat-model.md"), "utf8"),
    readFile(resolve(repositoryRoot, "docs/architecture/0009-shared-identity-gateway-and-provider-independent-authority.md"), "utf8"),
    readFile(resolve(repositoryRoot, "docs/superpowers/specs/2026-08-10-identity-runtime-public-auth-v1-design.md"), "utf8"),
  ]);
  for (const phrase of [
    "IDENTITY_PUBLIC_AUTH_ENABLED=0", "npm run db:migrate", "0600", "publish → activate → retire",
    "Supabase redirect allowlist", "six months", "Control Plane ports remain private", "Session revocation",
  ]) assert.match(operations, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  for (const command of [
    "node scripts/verify-no-secret.mjs identity-auth-private-sentinel",
    "npm run contracts:check", "npm run check", "npm run test:postgres", "npm run test:integration",
    "npm run test:browser -w @core-agent/control-plane-web",
    "CORE_AGENT_SUPABASE_ACCEPTANCE=1 node scripts/accept-supabase-auth.mjs",
  ]) assert.match(testing, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.match(testing, /NOT_RUN.*real provider|real provider.*NOT_RUN/isu);
  assert.match(threat, /MFA.*not enabled/isu);
  assert.match(threat, /student data.*prohibited/isu);
  assert.match(adr, /operational acceptance/iu);
  assert.match(design, /implementation complete.*provider acceptance pending/iu);
});
