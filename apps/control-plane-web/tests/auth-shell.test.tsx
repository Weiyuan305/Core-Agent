// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthSessionView, CompanyMemberView } from "@core-agent/contracts";

import { AuthClientError, type AuthApi } from "../src/client/features/auth/auth-api.js";
import { AuthShell } from "../src/client/features/auth/auth-shell.js";

const session: AuthSessionView = Object.freeze({
  schema_version: 1,
  actor_id: "actor_auth_shell",
  actor_resource_version: 2,
  session_id: "session_auth_shell",
  session_resource_version: 7,
  client_kind: "web",
  idle_expires_at: "2026-08-20T00:00:00.000Z",
  absolute_expires_at: "2026-09-18T00:00:00.000Z",
  reauthentication_required: false,
});

afterEach(cleanup);

function fakeApi(overrides: Partial<AuthApi> = {}): AuthApi {
  return {
    inspectSession: vi.fn(async () => { throw new AuthClientError("anonymous", false); }),
    signIn: vi.fn(async () => session),
    signUp: vi.fn(async () => ({ verificationId: "verification_shell", status: "verification_pending" as const })),
    verifyEmail: vi.fn(async () => session),
    startAppleSignIn: vi.fn(async () => "https://appleid.apple.com/auth/authorize?opaque=1"),
    inspectInvitation: vi.fn(async () => ({
      invitation_id: "invitation_shell", tenant_id: "tenant_shell", role: "consultant" as const,
      status: "pending" as const, expires_at: "2026-08-20T00:00:00.000Z", resource_version: 1,
    })),
    registerInvitation: vi.fn(async () => ({ verificationId: "verification_invited", status: "verification_pending" as const })),
    acceptInvitation: vi.fn(async () => ({ session, tenantId: "tenant_shell", role: "consultant" as const })),
    signOut: vi.fn(async () => undefined),
    revokeCurrentSession: vi.fn(async () => undefined),
    reauthenticate: vi.fn(async () => ({ ...session, reauthentication_required: false, session_resource_version: 8 })),
    listCompanyMembers: vi.fn(async () => []),
    inviteCompanyMember: vi.fn(async () => undefined),
    suspendCompanyMember: vi.fn(async () => undefined),
    revokeCompanyMember: vi.fn(async () => undefined),
    requestAccountDeletion: vi.fn(async () => ({
      accountDeletionId: "deletion_shell", scheduledFor: "2026-09-18T00:00:00.000Z", resourceVersion: 1,
    })),
    cancelAccountDeletion: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("production auth shell", () => {
  it("moves from anonymous sign-up through verification to the empty service state", async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    render(<AuthShell api={api} />);
    await screen.findByRole("heading", { name: "登录 Core Agent" });
    await user.click(screen.getByRole("button", { name: "创建账户" }));
    await user.type(screen.getByLabelText("邮箱"), "student@example.com");
    await user.type(screen.getByLabelText("密码"), "password-long-enough");
    await user.type(screen.getByLabelText("确认密码"), "password-long-enough");
    await user.click(screen.getByRole("button", { name: "继续注册" }));
    await screen.findByRole("heading", { name: "验证邮箱" });
    await user.type(screen.getByLabelText("验证码"), "verification-code");
    await user.click(screen.getByRole("button", { name: "完成验证" }));
    await screen.findByText("服务尚未开通");
    expect(api.signUp).toHaveBeenCalledWith({ email: "student@example.com", password: "password-long-enough" });
    expect(api.verifyEmail).toHaveBeenCalledWith({ verificationId: "verification_shell", verificationCode: "verification-code" });
    expect(screen.queryByText(/(?:checkout|购买|支付|自动创建)/iu)).toBeNull();
  });

  it("starts Apple redirect without rendering provider parameters", async () => {
    const assign = vi.fn();
    const api = fakeApi();
    const user = userEvent.setup();
    render(<AuthShell api={api} navigate={assign} />);
    await screen.findByRole("heading", { name: "登录 Core Agent" });
    await user.click(screen.getByRole("button", { name: "使用 Apple 登录" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://appleid.apple.com/auth/authorize?opaque=1"));
    expect(document.body.textContent).not.toMatch(/(?:transaction_id|state=|nonce|pkce|supabase)/iu);
  });

  it("uses identical calm invitation copy for expired and unknown invitations", async () => {
    const user = userEvent.setup();
    const api = fakeApi({ inspectInvitation: vi.fn(async () => { throw new AuthClientError("invalid", false); }) });
    render(<AuthShell api={api} invitationSecret={"a".repeat(43)} />);
    const calm = await screen.findByRole("alert");
    expect(calm.textContent).toBe("这个邀请暂时无法使用，请向邀请人确认。");
    expect(calm.textContent).not.toMatch(/(?:expired|unknown|404|AUTH_|tenant|provider)/iu);
    await user.click(screen.getByRole("button", { name: "返回登录" }));
    expect(await screen.findByRole("heading", { name: "登录 Core Agent" })).not.toBeNull();
  });

  it("requires a recent password check before account deletion", async () => {
    const api = fakeApi({ inspectSession: vi.fn(async () => ({ ...session, reauthentication_required: true })) });
    const user = userEvent.setup();
    render(<AuthShell api={api} />);
    await screen.findByText("服务尚未开通");
    await user.click(screen.getByRole("button", { name: "账户与安全" }));
    await user.click(screen.getByRole("button", { name: "申请删除账户" }));
    const dialog = screen.getByRole("dialog", { name: "确认当前密码" });
    expect(api.requestAccountDeletion).not.toHaveBeenCalled();
    await user.type(within(dialog).getByLabelText("当前密码"), "password-long-enough");
    await user.click(within(dialog).getByRole("button", { name: "继续" }));
    await waitFor(() => expect(api.reauthenticate).toHaveBeenCalledOnce());
    await waitFor(() => expect(api.requestAccountDeletion).toHaveBeenCalledOnce());
    expect(api.requestAccountDeletion).toHaveBeenCalledWith(8);
    expect(await screen.findByText(/账户将在/u)).not.toBeNull();
  });

  it("revokes the inspected current Session and returns to sign-in", async () => {
    const api = fakeApi({ inspectSession: vi.fn(async () => session) });
    const user = userEvent.setup();
    render(<AuthShell api={api} />);
    await screen.findByText("服务尚未开通");
    await user.click(screen.getByRole("button", { name: "账户与安全" }));
    await user.click(screen.getByRole("button", { name: "撤销当前会话" }));
    await screen.findByRole("heading", { name: "登录 Core Agent" });
    expect(api.revokeCurrentSession).toHaveBeenCalledWith({
      sessionId: session.session_id,
      expectedResourceVersion: session.session_resource_version,
    });
  });

  it("shows platform-origin members without edit controls", async () => {
    const platformMember: CompanyMemberView = {
      schema_version: 1,
      membership_id: "membership_platform",
      actor_id: "actor_platform",
      membership_resource_version: 1,
      source: "platform",
      status: "active",
      roles: ["admin"],
    };
    const companyMember: CompanyMemberView = {
      schema_version: 1,
      membership_id: "membership_company",
      actor_id: "actor_company",
      membership_resource_version: 2,
      source: "company",
      status: "active",
      roles: ["admin"],
    };
    const api = fakeApi({
      inspectSession: vi.fn(async () => session),
      listCompanyMembers: vi.fn(async () => [platformMember, companyMember]),
    });
    const user = userEvent.setup();
    render(<AuthShell api={api} initialTenantId="tenant_shell" />);
    await screen.findByText("服务尚未开通");
    await user.click(screen.getByRole("button", { name: "公司成员" }));
    const platformRow = await screen.findByTestId("member-membership_platform");
    expect(within(platformRow).getByText("平台管理成员")).not.toBeNull();
    expect(within(platformRow).queryByRole("button", { name: /(?:暂停|撤销|编辑)/u })).toBeNull();
    const companyRow = screen.getByTestId("member-membership_company");
    expect(within(companyRow).getByRole("button", { name: "暂停成员" })).not.toBeNull();
  });

  it("returns to sign-in on Session expiry and restores an unsent company draft", async () => {
    sessionStorage.clear();
    const companyMember: CompanyMemberView = {
      schema_version: 1,
      membership_id: "membership_draft",
      actor_id: "actor_draft",
      membership_resource_version: 2,
      source: "company",
      status: "active",
      roles: ["consultant"],
    };
    const api = fakeApi({
      inspectSession: vi.fn(async () => session),
      listCompanyMembers: vi.fn(async () => [companyMember]),
      suspendCompanyMember: vi.fn(async () => { throw new AuthClientError("anonymous", false); }),
    });
    const user = userEvent.setup();
    render(<AuthShell api={api} initialTenantId="tenant_shell" />);
    await screen.findByText("服务尚未开通");
    await user.click(screen.getByRole("button", { name: "公司成员" }));
    await user.type(await screen.findByLabelText("成员邮箱"), "draft@example.com");
    await user.click(screen.getByRole("button", { name: "暂停成员" }));
    await screen.findByRole("heading", { name: "登录 Core Agent" });
    await user.type(screen.getByLabelText("邮箱"), "admin@example.com");
    await user.type(screen.getByLabelText("密码"), "password-long-enough");
    await user.click(screen.getByRole("button", { name: "登录", exact: true }));
    await user.click(await screen.findByRole("button", { name: "公司成员" }));
    expect((await screen.findByLabelText("成员邮箱") as HTMLInputElement).value).toBe("draft@example.com");
  });
});
