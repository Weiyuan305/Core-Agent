// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within, type RenderResult } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentType } from "react";

import type { AuthSessionView } from "@core-agent/contracts";

import { type AuthApi } from "../src/client/features/auth/auth-api.js";
import { AuthShell } from "../src/client/features/auth/auth-shell.js";
import { ServiceClientError } from "../src/client/features/services/services-api.js";

const session: AuthSessionView = Object.freeze({
  schema_version: 1,
  actor_id: "actor_services",
  actor_resource_version: 2,
  session_id: "session_services",
  session_resource_version: 8,
  client_kind: "web",
  idle_expires_at: "2026-08-25T08:00:00.000Z",
  absolute_expires_at: "2026-09-24T08:00:00.000Z",
  reauthentication_required: false,
});

afterEach(cleanup);

function fakeAuthApi(): AuthApi {
  return {
    inspectSession: vi.fn(async () => session),
    signIn: vi.fn(async () => session),
    signUp: vi.fn(async () => ({ verificationId: "verification_services", status: "verification_pending" as const })),
    verifyEmail: vi.fn(async () => session),
    startAppleSignIn: vi.fn(async () => "https://appleid.apple.com/auth/authorize"),
    inspectInvitation: vi.fn(async () => { throw new Error("unused"); }),
    registerInvitation: vi.fn(async () => { throw new Error("unused"); }),
    acceptInvitation: vi.fn(async () => { throw new Error("unused"); }),
    signOut: vi.fn(async () => undefined),
    revokeCurrentSession: vi.fn(async () => undefined),
    reauthenticate: vi.fn(async () => session),
    listCompanyMembers: vi.fn(async () => [{
      schema_version: 1,
      membership_id: "membership_consultant",
      actor_id: "actor_consultant",
      membership_resource_version: 2,
      source: "company",
      status: "active",
      roles: ["consultant"],
      profile_id: "profile_consultant",
      profile_resource_version: 3,
      profile_status: "active",
    }]),
    inviteCompanyMember: vi.fn(async () => undefined),
    suspendCompanyMember: vi.fn(async () => undefined),
    revokeCompanyMember: vi.fn(async () => undefined),
    requestAccountDeletion: vi.fn(async () => ({
      accountDeletionId: "deletion_services",
      scheduledFor: "2026-09-24T08:00:00.000Z",
      resourceVersion: 1,
    })),
    cancelAccountDeletion: vi.fn(async () => undefined),
  };
}

type ServiceShellProps = Parameters<typeof AuthShell>[0] & {
  readonly serviceApi: {
    readonly loadWorkspace: (tenantId?: string) => Promise<unknown>;
    readonly mutate: (input: unknown) => Promise<void>;
  };
};

const ServiceAwareAuthShell = AuthShell as unknown as ComponentType<ServiceShellProps>;

async function renderServices(workspace: unknown, options: { readonly tenantId?: string } = {}): Promise<{
  readonly api: ServiceShellProps["serviceApi"];
  readonly authApi: AuthApi;
  readonly result: RenderResult;
}> {
  const api = {
    loadWorkspace: vi.fn(async () => workspace),
    mutate: vi.fn(async () => undefined),
  };
  const authApi = fakeAuthApi();
  const props: ServiceShellProps = {
    api: authApi,
    serviceApi: api,
    ...(options.tenantId === undefined ? {} : { initialTenantId: options.tenantId }),
  };
  const result = render(<ServiceAwareAuthShell {...props} />);
  return { api, authApi, result };
}

describe("service management workspace", () => {
  it("renders platform catalog lifecycle and manual entitlement controls without executable internals", async () => {
    const user = userEvent.setup();
    const { api } = await renderServices({
      kind: "platform",
      catalog: {
        capabilities: [{
          capabilityId: "capability_read",
          capabilityVersionId: "capability_version_read",
          displayName: "资料读取",
          version: "1.0.0",
          kind: "mcp",
          status: "draft",
          resourceVersion: 1,
        }],
        packs: [{
          packProductId: "pack_student",
          packVersionId: "pack_version_student",
          displayName: "学生全能服务",
          version: "1.0.0",
          tenantModes: ["b2c"],
          status: "reviewed",
          resourceVersion: 2,
        }],
      },
      entitlements: [{
        entitlementId: "entitlement_student",
        tenantId: "tenant_student",
        displayName: "学生全能服务",
        tenantMode: "b2c",
        status: "active",
        validFrom: "2026-08-25T00:00:00.000Z",
        resourceVersion: 3,
      }],
    });

    expect(await screen.findByRole("heading", { name: "平台服务管理" })).not.toBeNull();
    const capability = screen.getByTestId("capability-capability_version_read");
    await user.click(within(capability).getByRole("button", { name: "审核能力版本" }));
    await waitFor(() => expect(api.mutate).toHaveBeenCalledWith({
      kind: "capability_review",
      capabilityVersionId: "capability_version_read",
      expectedResourceVersion: 1,
    }));
    const pack = screen.getByTestId("pack-pack_version_student");
    await user.click(within(pack).getByRole("button", { name: "发布服务包" }));
    await waitFor(() => expect(api.mutate).toHaveBeenCalledWith({
      kind: "pack_publish",
      packVersionId: "pack_version_student",
      expectedResourceVersion: 2,
    }));
    await user.click(screen.getByRole("button", { name: "暂停服务" }));
    await waitFor(() => expect(api.mutate).toHaveBeenCalledWith({
      kind: "entitlement_change_status",
      entitlementId: "entitlement_student",
      expectedResourceVersion: 3,
      status: "suspended",
    }));
    expect(document.body.textContent).not.toMatch(/(?:artifact_ref|contract_ref|external_order_ref|tool schema|container|supabase|hermes)/iu);
  });

  it("shows company seat totals, eligible consultant assignment, and prevents duplicate submission", async () => {
    let releaseMutation: (() => void) | undefined;
    const user = userEvent.setup();
    const { api, authApi } = await renderServices({
      kind: "company",
      tenantId: "tenant_company",
      services: [{
        serviceId: "entitlement_company",
        resourceVersion: 1,
        displayName: "顾问工作台",
        validFrom: "2026-08-25T00:00:00.000Z",
        state: "available",
        usedSeats: 1,
        totalSeats: 3,
        availableSeats: 2,
      }],
      assignments: [],
    }, { tenantId: "tenant_company" });
    vi.mocked(api.mutate).mockImplementation(() => new Promise<void>((resolve) => { releaseMutation = resolve; }));

    expect(await screen.findByRole("heading", { name: "服务与名额" })).not.toBeNull();
    expect(screen.getByText("已使用 1 / 3")).not.toBeNull();
    expect(screen.getByText("可分配 2")).not.toBeNull();
    expect(authApi.listCompanyMembers).toHaveBeenCalledWith("tenant_company");
    await user.selectOptions(screen.getByLabelText("选择顾问"), "profile_consultant");
    const assign = screen.getByRole("button", { name: "分配名额" });
    await user.click(assign);
    expect((assign as HTMLButtonElement).disabled).toBe(true);
    await user.click(assign);
    expect(api.mutate).toHaveBeenCalledTimes(1);
    expect(api.mutate).toHaveBeenCalledWith({
      kind: "seat_assign",
      tenantId: "tenant_company",
      entitlementId: "entitlement_company",
      expectedResourceVersion: 1,
      profileId: "profile_consultant",
    });
    releaseMutation?.();
  });

  it("refreshes company seat totals after a concurrent seat exhaustion", async () => {
    const user = userEvent.setup();
    const initial = {
      kind: "company" as const,
      tenantId: "tenant_company",
      services: [{ serviceId: "entitlement_company", resourceVersion: 1, displayName: "顾问工作台", validFrom: "2026-08-25T00:00:00.000Z", state: "available" as const, usedSeats: 2, totalSeats: 3, availableSeats: 1 }],
      assignments: [],
    };
    const { api } = await renderServices(initial, { tenantId: "tenant_company" });
    await screen.findByRole("heading", { name: "服务与名额" });
    vi.mocked(api.mutate).mockRejectedValueOnce(new ServiceClientError("seat_exhausted", false));
    vi.mocked(api.loadWorkspace).mockResolvedValueOnce({
      ...initial,
      services: [{ ...initial.services[0], resourceVersion: 2, usedSeats: 3, availableSeats: 0 }],
    });

    await user.selectOptions(screen.getByLabelText("选择顾问"), "profile_consultant");
    await user.click(screen.getByRole("button", { name: "分配名额" }));

    expect(await screen.findByText("可分配名额已用完。")).not.toBeNull();
    expect(screen.getByText("已使用 3 / 3")).not.toBeNull();
  });

  it("dispatches platform draft creation, manual grant, and rollback release as closed commands", async () => {
    const user = userEvent.setup();
    const { api } = await renderServices({
      kind: "platform",
      catalog: {
        capabilities: [{
          capabilityId: "capability_read",
          capabilityVersionId: "capability_version_read",
          displayName: "资料读取",
          version: "1.0.0",
          kind: "mcp",
          status: "reviewed",
          resourceVersion: 2,
        }],
        packs: [{
          packProductId: "pack_student",
          packVersionId: "pack_version_student_v1",
          displayName: "学生全能服务",
          version: "1.0.0",
          tenantModes: ["b2c"],
          status: "published",
          resourceVersion: 3,
        }],
      },
      entitlements: [],
    });

    await screen.findByRole("heading", { name: "平台服务管理" });
    await user.click(screen.getByText("创建能力草稿"));
    await user.type(screen.getByLabelText("能力标识"), "capability_write");
    await user.type(screen.getByLabelText("能力版本标识"), "capability_version_write");
    await user.type(screen.getByLabelText("能力名称"), "材料草稿");
    await user.type(screen.getByLabelText("归属域"), "applications");
    await user.type(screen.getByLabelText("语义版本"), "1.0.0");
    await user.type(screen.getByLabelText("不可变制品坐标"), `manifest:sha256:${"b".repeat(64)}`);
    await user.type(screen.getByLabelText("精确契约坐标"), "applications.write@1.0.0");
    await user.click(screen.getByRole("button", { name: "保存能力草稿" }));
    await waitFor(() => expect(api.mutate).toHaveBeenCalledWith(expect.objectContaining({
      kind: "capability_create",
      capabilityId: "capability_write",
      capabilityVersionId: "capability_version_write",
    })));

    await user.click(screen.getByText("创建服务包草稿"));
    await user.type(screen.getByLabelText("服务包标识"), "pack_student");
    await user.type(screen.getByLabelText("服务包版本标识"), "pack_version_student_v2");
    await user.type(screen.getByLabelText("服务包名称"), "学生全能服务");
    await user.type(screen.getByLabelText("服务包语义版本"), "2.0.0");
    await user.selectOptions(screen.getByLabelText("已审核能力版本"), "capability_version_read");
    await user.click(screen.getByRole("button", { name: "保存服务包草稿" }));
    await waitFor(() => expect(api.mutate).toHaveBeenCalledWith(expect.objectContaining({
      kind: "pack_create",
      packVersionId: "pack_version_student_v2",
      members: [{ capabilityId: "capability_read", capabilityVersionId: "capability_version_read", version: "1.0.0" }],
    })));

    await user.click(screen.getByText("切换或回滚服务版本"));
    await user.type(screen.getByLabelText("客户租户标识"), "tenant_student");
    await user.selectOptions(screen.getByLabelText("目标服务版本"), "pack_version_student_v1");
    await user.click(screen.getByRole("button", { name: "生成新发布代次" }));
    await waitFor(() => expect(api.mutate).toHaveBeenCalledWith({
      kind: "tenant_select_release",
      tenantId: "tenant_student",
      packProductId: "pack_student",
      packVersionId: "pack_version_student_v1",
      expectedResourceVersion: 1,
    }));

    await user.click(screen.getByText("记录客户授权"));
    await user.type(screen.getByLabelText("授权租户标识"), "tenant_student");
    await user.selectOptions(screen.getByLabelText("授权服务包"), "pack_student");
    await user.type(screen.getByLabelText("业务订单标识"), "order_student_2");
    await user.click(screen.getByRole("button", { name: "记录授权" }));
    await waitFor(() => expect(api.mutate).toHaveBeenCalledWith({
      kind: "entitlement_grant",
      tenantId: "tenant_student",
      packProductId: "pack_student",
      externalOrderRef: "order_student_2",
      expectedResourceVersion: 1,
      tenantMode: "b2c",
    }));
  });

  it("keeps student conversation admission disabled while preparing and explains terminal states calmly", async () => {
    await renderServices({
      kind: "student",
      services: [
        { serviceId: "entitlement_suite", displayName: "学生全能服务", validFrom: "2026-08-25T00:00:00.000Z", state: "preparing" },
        { serviceId: "entitlement_addon", displayName: "雅思写作加购", validFrom: "2026-08-25T00:00:00.000Z", state: "suspended" },
      ],
    });

    expect(await screen.findByRole("heading", { name: "我的服务" })).not.toBeNull();
    expect(screen.getByText("服务正在准备，完成后即可开始对话。")).not.toBeNull();
    expect(screen.getByText("服务已暂停，请联系支持确认账户状态。")).not.toBeNull();
    expect((screen.getByRole("button", { name: "开始对话" }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.body.textContent).not.toMatch(/(?:SERVICE_PREPARING|failed|runtime|provider|价格|支付|购买)/iu);
  });

  it("keeps an available service fail-closed until the public trusted conversation gateway exists", async () => {
    await renderServices({
      kind: "student",
      services: [{ serviceId: "entitlement_suite", displayName: "学生全能服务", validFrom: "2026-08-25T00:00:00.000Z", state: "available" }],
    });

    await screen.findByRole("heading", { name: "我的服务" });
    expect((screen.getByRole("button", { name: "对话入口待启用" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("服务已准备完成；安全对话入口将在独立网关验收后开放。")).not.toBeNull();
  });

  it("renders the calm empty state when the authenticated actor has no visible service surface", async () => {
    await renderServices({ kind: "none" });
    expect(await screen.findByRole("heading", { name: "服务尚未开通" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: /服务与名额|平台服务管理/u })).toBeNull();
  });
});
