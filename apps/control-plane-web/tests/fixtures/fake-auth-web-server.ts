import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";

import { buildClientGatewayApp } from "../../src/server/app.js";

const WEB_PORT = 4_175;
const IDENTITY_PORT = 4_915;
const csrfCookie = "core_agent_csrf=csrf-browser-fixture; SameSite=Lax; Path=/";

function session(reauthenticationRequired = false) {
  return {
    schema_version: 1,
    actor_id: "actor_browser_fixture",
    actor_resource_version: 2,
    session_id: "session_browser_fixture",
    session_resource_version: reauthenticationRequired ? 7 : 8,
    client_kind: "web",
    idle_expires_at: "2026-08-20T00:00:00.000Z",
    absolute_expires_at: "2026-09-18T00:00:00.000Z",
    reauthentication_required: reauthenticationRequired,
  } as const;
}

function error(reply: FastifyReply, status: number): FastifyReply {
  return reply.code(status).send({
    schema_version: 1,
    error_id: "error_browser_fixture",
    code: status === 401 ? "AUTH_INVALID" : "INVALID_REQUEST",
    category: status === 401 ? "authentication" : "validation",
    message: "无法完成验证，请检查信息后重试。",
    retryable: false,
    request_id: "request_browser_fixture",
    trace_id: "trace_browser_fixture",
  });
}

function signedIn(request: FastifyRequest): boolean {
  return /(?:^|;\s*)core_agent_session=(?:active|needs_reauth|platform|student|consultant)(?:;|$)/u.test(request.headers.cookie ?? "");
}

function sessionKind(request: FastifyRequest): "platform" | "student" | "company" | "consultant" | undefined {
  const cookie = request.headers.cookie ?? "";
  if (/(?:^|;\s*)core_agent_session=platform(?:;|$)/u.test(cookie)) return "platform";
  if (/(?:^|;\s*)core_agent_session=student(?:;|$)/u.test(cookie)) return "student";
  if (/(?:^|;\s*)core_agent_session=consultant(?:;|$)/u.test(cookie)) return "consultant";
  if (signedIn(request)) return "company";
  return undefined;
}

function setSession(reply: FastifyReply, value = "active"): void {
  reply.header("set-cookie", [`core_agent_session=${value}; HttpOnly; SameSite=Lax; Path=/`, csrfCookie]);
}

async function start(): Promise<void> {
  const identity = Fastify({ logger: false, bodyLimit: 64 * 1_024 });
  let pendingVerificationRole: "consultant" | undefined;
  identity.all("/auth/v1/*", async (request, reply) => {
    const path = request.url;
    if (path === "/auth/v1/session" && request.method === "GET") {
      if (!signedIn(request)) return error(reply, 401);
      return { schema_version: 1, session: session((request.headers.cookie ?? "").includes("core_agent_session=needs_reauth")) };
    }
    if (path === "/auth/v1/email/sign-up") {
      pendingVerificationRole = undefined;
      return { schema_version: 1, verification_id: "verification_browser", status: "verification_pending" };
    }
    if (path === "/auth/v1/email/verification") {
      setSession(reply, pendingVerificationRole ?? "active");
      pendingVerificationRole = undefined;
      return { schema_version: 1, transport: "web_cookie", session: session(false) };
    }
    if (path === "/auth/v1/email/sign-in") {
      const body = request.body as { email?: string };
      const value = body.email === "platform@example.com" ? "platform" : body.email === "student@example.com" ? "student" : "needs_reauth";
      setSession(reply, value);
      return { schema_version: 1, transport: "web_cookie", session: session(value === "needs_reauth") };
    }
    if (path === "/auth/v1/apple/start") {
      return { schema_version: 1, authorization_url: "https://appleid.apple.com/auth/authorize?opaque=browser-fixture" };
    }
    if (path === "/auth/v1/invitations/inspect") {
      const body = request.body as { invitation_secret?: string };
      if (body.invitation_secret?.startsWith("z") === true) return error(reply, 400);
      return {
        schema_version: 1,
        invitation_id: "invitation_browser",
        tenant_id: "tenant_browser",
        role: body.invitation_secret?.startsWith("a") === true ? "admin" : "consultant",
        status: "pending",
        expires_at: "2026-08-20T00:00:00.000Z",
        resource_version: 1,
      };
    }
    if (path === "/auth/v1/invitations/register") {
      pendingVerificationRole = "consultant";
      return { schema_version: 1, verification_id: "verification_invited_browser", status: "verification_pending" };
    }
    if (path === "/auth/v1/invitations/accept") {
      if (!signedIn(request)) return error(reply, 401);
      setSession(reply);
      return {
        schema_version: 1, transport: "web_cookie", tenant_id: "tenant_browser",
        invitation_resource_version: 2, membership_id: "membership_accepted",
        membership_resource_version: 1, role: "admin", session: session(false),
      };
    }
    if (path === "/auth/v1/reauthenticate") {
      setSession(reply);
      return {
        schema_version: 1,
        reauthenticated_at: "2026-08-19T12:00:00.000Z",
        valid_until: "2026-08-19T12:10:00.000Z",
        session_resource_version: 8,
      };
    }
    if (path === "/auth/v1/companies/members/list") {
      return {
        schema_version: 1,
        tenant_id: "tenant_browser",
        members: [
          { schema_version: 1, membership_id: "membership_platform", actor_id: "actor_platform", membership_resource_version: 1, source: "platform", status: "active", roles: ["admin"] },
          { schema_version: 1, membership_id: "membership_company", actor_id: "actor_company", membership_resource_version: 2, source: "company", status: "active", roles: ["admin"] },
          { schema_version: 1, membership_id: "membership_consultant", actor_id: "actor_consultant", membership_resource_version: 1, source: "company", status: "active", roles: ["consultant"], profile_id: "profile_consultant", profile_resource_version: 1, profile_status: "active" },
        ],
        page_info: { schema_version: 1, has_more: false },
      };
    }
    if (path === "/auth/v1/account/deletion/request") {
      return { schema_version: 1, account_deletion_id: "deletion_browser", status: "deletion_pending", scheduled_for: "2026-09-18T00:00:00.000Z", resource_version: 1 };
    }
    if (path === "/auth/v1/account/deletion/cancel") {
      return { schema_version: 1, account_deletion_id: "deletion_browser", status: "cancelled", resource_version: 2 };
    }
    if (path === "/auth/v1/sessions/revoke") {
      return { schema_version: 1, session_id: "session_browser_fixture", status: "revoked", resource_version: 9 };
    }
    if (path === "/auth/v1/companies/members") {
      return {
        schema_version: 1, membership_id: "membership_invited", membership_resource_version: 1,
        invitation_id: "invitation_member", invitation_resource_version: 1,
        invitation_secret: "I_6SJkpt7IwWV5ZzKg_Z3H6hPqLvh7sLNIdUoS7K4fA",
      };
    }
    if (path === "/auth/v1/companies/members/suspend") {
      return error(reply, 401);
    }
    if (path === "/auth/v1/companies/members/revoke") {
      return { schema_version: 1, membership_id: "membership_company", status: "revoked", resource_version: 3 };
    }
    if (path === "/auth/v1/session/sign-out") {
      reply.header("set-cookie", ["core_agent_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0", "core_agent_csrf=; SameSite=Lax; Path=/; Max-Age=0"]);
      return { schema_version: 1, signed_out: true };
    }
    return error(reply, 404);
  });
  identity.all("/app/v1/*", async (request, reply) => {
    const path = new URL(request.url, "http://identity.invalid").pathname;
    const role = sessionKind(request);
    if (role === undefined) return error(reply, 401);
    if (path === "/app/v1/platform/catalog") {
      if (role !== "platform") return error(reply, 403);
      if (request.method === "POST") return { schema_version: 1, accepted: true };
      return {
        schema_version: 1,
        capabilities: [{ schema_version: 1, capability_id: "capability_browser", capability_version_id: "capability_version_browser", version: "1.0.0", display_name: "资料读取", kind: "mcp", status: "reviewed", resource_version: 2 }],
        packs: [{ schema_version: 1, pack_product_id: "pack_browser", pack_version_id: "pack_version_browser", version: "1.0.0", display_name: "学生全能服务", tenant_modes: ["b2c"], status: "published", resource_version: 3 }],
      };
    }
    if (path === "/app/v1/platform/entitlements") {
      if (role !== "platform") return error(reply, 403);
      if (request.method === "POST") return { schema_version: 1, accepted: true };
      return {
        schema_version: 1,
        entitlements: [{ schema_version: 1, entitlement_id: "entitlement_browser", tenant_id: "tenant_browser", display_name: "学生全能服务", tenant_mode: "b2c", status: "active", valid_from: "2026-08-25T00:00:00.000Z", resource_version: 1 }],
      };
    }
    if (path === "/app/v1/company/services") {
      if (role !== "company") return error(reply, 403);
      return {
        schema_version: 1,
        services: [{ schema_version: 1, service_id: "entitlement_company_browser", entitlement_resource_version: 1, display_name: "顾问工作台", valid_from: "2026-08-25T00:00:00.000Z", service_state: "available", used_seats: 1, total_seats: 3, available_seats: 2 }],
      };
    }
    if (path === "/app/v1/company/assignments") {
      if (role !== "company") return error(reply, 403);
      if (request.method === "POST") return { schema_version: 1, accepted: true };
      return { schema_version: 1, assignments: [] };
    }
    if (path === "/app/v1/student/services") {
      if (role !== "student") return error(reply, 403);
      return {
        schema_version: 1,
        services: [{ schema_version: 1, service_id: "entitlement_student_browser", display_name: "学生全能服务", valid_from: "2026-08-25T00:00:00.000Z", service_state: "preparing" }],
      };
    }
    return error(reply, 404);
  });
  await identity.listen({ host: "127.0.0.1", port: IDENTITY_PORT });

  const packageRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const web = await buildClientGatewayApp({
    authProxy: {
      origin: `http://127.0.0.1:${IDENTITY_PORT}`,
      publicOrigin: `http://127.0.0.1:${WEB_PORT}`,
    },
    staticRoot: resolve(packageRoot, "dist/client"),
  });
  const stop = (): void => { void web.close().then(() => identity.close()).finally(() => process.exit(0)); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await web.listen({ host: "127.0.0.1", port: WEB_PORT });
  process.stdout.write("FAKE_AUTH_WEB_READY\n");
}

void start().catch(() => {
  process.stderr.write("FAKE_AUTH_WEB_FAILED\n");
  process.exitCode = 1;
});
