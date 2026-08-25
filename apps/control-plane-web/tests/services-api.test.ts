// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import { canonicalPublicPayloadHash } from "../src/client/features/auth/auth-api.js";
import { createServicesApi } from "../src/client/features/services/services-api.js";

function publicError(code = "ENTITLEMENT_DENIED"): Response {
  return Response.json({
    schema_version: 1,
    error_id: "error_services",
    code,
    category: code === "REAUTHENTICATION_REQUIRED" ? "authentication" : "authorization",
    message: "暂时无法访问服务。",
    retryable: false,
    request_id: "request_services",
    trace_id: "trace_services",
  }, { status: code === "REAUTHENTICATION_REQUIRED" ? 401 : 403 });
}

describe("service management API", () => {
  it("discovers the student surface through closed public summaries", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/app/v1/platform/catalog" || path === "/app/v1/platform/entitlements") return publicError();
      if (path === "/app/v1/student/services") return Response.json({
        schema_version: 1,
        services: [{
          schema_version: 1,
          service_id: "entitlement_student",
          display_name: "学生全能服务",
          valid_from: "2026-08-25T00:00:00.000Z",
          service_state: "preparing",
        }],
      });
      throw new Error(`unexpected path ${path}`);
    });
    const api = createServicesApi(fetchImpl as typeof fetch);
    await expect(api.loadWorkspace()).resolves.toEqual({
      kind: "student",
      services: [{
        serviceId: "entitlement_student",
        displayName: "学生全能服务",
        validFrom: "2026-08-25T00:00:00.000Z",
        state: "preparing",
      }],
    });
    expect(JSON.stringify(await api.loadWorkspace())).not.toMatch(/(?:artifact|contract|order|container|provider)/iu);
  });

  it("keeps exact catalog versions needed for closed pack and release commands", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/app/v1/platform/catalog") return Response.json({
        schema_version: 1,
        capabilities: [{ schema_version: 1, capability_id: "capability_read", capability_version_id: "capability_version_read", version: "1.2.0", display_name: "资料读取", kind: "mcp", status: "reviewed", resource_version: 2 }],
        packs: [{ schema_version: 1, pack_product_id: "pack_student", pack_version_id: "pack_version_student", version: "1.2.0", display_name: "学生全能服务", tenant_modes: ["b2c"], status: "published", resource_version: 3 }],
      });
      if (path === "/app/v1/platform/entitlements") return Response.json({ schema_version: 1, entitlements: [] });
      throw new Error(`unexpected path ${path}`);
    });
    const workspace = await createServicesApi(fetchImpl as typeof fetch).loadWorkspace();
    expect(workspace).toMatchObject({
      kind: "platform",
      catalog: {
        capabilities: [{ capabilityVersionId: "capability_version_read", version: "1.2.0" }],
        packs: [{ packVersionId: "pack_version_student", version: "1.2.0" }],
      },
    });
  });

  it("loads company seats and assignments only for the explicit tenant hint", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/app/v1/platform/catalog" || path === "/app/v1/platform/entitlements") return publicError();
      if (path === "/app/v1/company/services?tenant_id=tenant_company") return Response.json({
        schema_version: 1,
        services: [{
          schema_version: 1,
          service_id: "entitlement_company",
          entitlement_resource_version: 4,
          display_name: "顾问工作台",
          valid_from: "2026-08-25T00:00:00.000Z",
          service_state: "available",
          used_seats: 1,
          total_seats: 3,
          available_seats: 2,
        }],
      });
      if (path === "/app/v1/company/assignments?tenant_id=tenant_company") return Response.json({
        schema_version: 1,
        assignments: [{
          schema_version: 1,
          assignment_id: "assignment_company",
          assignment_resource_version: 2,
          profile_id: "profile_company",
          profile_display_name: "顾问 A",
          service_display_name: "顾问工作台",
          service_state: "available",
        }],
      });
      throw new Error(`unexpected path ${path}`);
    });
    const api = createServicesApi(fetchImpl as typeof fetch);
    await expect(api.loadWorkspace("tenant_company")).resolves.toMatchObject({
      kind: "company",
      tenantId: "tenant_company",
      services: [{ serviceId: "entitlement_company", resourceVersion: 4, usedSeats: 1, totalSeats: 3, availableSeats: 2 }],
      assignments: [{ assignmentId: "assignment_company", resourceVersion: 2, profileId: "profile_company" }],
    });
    expect(fetchImpl.mock.calls.some(([input]) => String(input).includes("student"))).toBe(false);
  });

  it("hashes and submits one protected catalog transition with the readable CSRF cookie", async () => {
    document.cookie = "core_agent_csrf=csrf-services; Path=/";
    const fetchImpl = vi.fn(async () => Response.json({
      schema_version: 1,
      capability_version_id: "capability_version_read",
      capability_id: "capability_read",
      version: "1.0.0",
      status: "reviewed",
      resource_version: 2,
    }));
    const api = createServicesApi(fetchImpl as typeof fetch, { idempotencyKey: () => "service_transition" });
    await api.mutate({
      kind: "capability_review",
      capabilityVersionId: "capability_version_read",
      expectedResourceVersion: 1,
    });
    const [path, init] = fetchImpl.mock.calls[0]!;
    expect(path).toBe("/app/v1/platform/catalog");
    expect(new Headers(init?.headers).get("x-core-agent-csrf")).toBe("csrf-services");
    const body = JSON.parse(String(init?.body)) as { command: Record<string, unknown> };
    const { payload_hash: supplied, ...facts } = body.command;
    expect(supplied).toBe(await canonicalPublicPayloadHash(facts));
  });

  it("submits a platform entitlement status command with the required reason and resource version", async () => {
    document.cookie = "core_agent_csrf=csrf-services; Path=/";
    const fetchImpl = vi.fn(async () => Response.json({
      schema_version: 1,
      entitlement_id: "entitlement_student",
      tenant_id: "tenant_student",
      pack_product_id: "pack_student",
      status: "suspended",
      reason_code: "administrator_suspended",
      resource_version: 4,
      valid_from: "2026-08-25T00:00:00.000Z",
    }));
    const api = createServicesApi(fetchImpl as typeof fetch, { idempotencyKey: () => "service_suspend" });

    await api.mutate({
      kind: "entitlement_change_status",
      entitlementId: "entitlement_student",
      expectedResourceVersion: 3,
      status: "suspended",
    });

    const [path, init] = fetchImpl.mock.calls[0]!;
    expect(path).toBe("/app/v1/platform/entitlements");
    const body = JSON.parse(String(init?.body)) as { action: string; command: Record<string, unknown> };
    expect(body.action).toBe("change_status");
    expect(body.command).toMatchObject({
      entitlement_id: "entitlement_student",
      expected_resource_version: 3,
      status: "suspended",
      reason_code: "administrator_suspended",
    });
    const { payload_hash: supplied, ...facts } = body.command;
    expect(supplied).toBe(await canonicalPublicPayloadHash(facts));
  });

  it("submits closed platform draft, release, and manual grant commands", async () => {
    document.cookie = "core_agent_csrf=csrf-services; Path=/";
    const fetchImpl = vi.fn(async () => Response.json({ schema_version: 1 }));
    let sequence = 0;
    const api = createServicesApi(fetchImpl as typeof fetch, { idempotencyKey: () => `service_admin_${++sequence}` });

    await api.mutate({
      kind: "capability_create",
      capabilityId: "capability_read",
      capabilityVersionId: "capability_version_read_v2",
      displayName: "资料读取",
      owningDomain: "applications",
      capabilityKind: "mcp",
      version: "2.0.0",
      artifactRef: `manifest:sha256:${"a".repeat(64)}`,
      contractRef: "applications.read@2.0.0",
      riskClass: "read",
      approvalRequirement: "none",
      coreContractVersion: "0.8.0",
      domainContractVersion: "2.0.0",
      runtimeProtocolVersion: "1.0.0",
      tenantModes: ["b2b", "b2c"],
    });
    await api.mutate({
      kind: "pack_create",
      packProductId: "pack_student",
      packVersionId: "pack_version_student_v2",
      displayName: "学生全能服务",
      tenantModes: ["b2c"],
      version: "2.0.0",
      members: [{ capabilityId: "capability_read", capabilityVersionId: "capability_version_read_v2", version: "2.0.0" }],
    });
    await api.mutate({
      kind: "tenant_select_release",
      tenantId: "tenant_student",
      packProductId: "pack_student",
      packVersionId: "pack_version_student_v2",
      expectedResourceVersion: 1,
    });
    await api.mutate({
      kind: "entitlement_grant",
      tenantId: "tenant_student",
      packProductId: "pack_student",
      externalOrderRef: "order_student_2",
      expectedResourceVersion: 1,
      tenantMode: "b2c",
    });

    expect(fetchImpl.mock.calls.map(([path]) => path)).toEqual([
      "/app/v1/platform/catalog",
      "/app/v1/platform/catalog",
      "/app/v1/platform/entitlements",
      "/app/v1/platform/entitlements",
    ]);
    expect(fetchImpl.mock.calls.map(([, init]) => (JSON.parse(String(init?.body)) as { action: string }).action)).toEqual([
      "capability_create", "pack_create", "select_release", "grant",
    ]);
    for (const [, init] of fetchImpl.mock.calls) {
      const body = JSON.parse(String(init?.body)) as { command: Record<string, unknown> };
      const { payload_hash: supplied, ...facts } = body.command;
      expect(supplied).toBe(await canonicalPublicPayloadHash(facts));
    }
  });

  it("recognizes only the two allowlisted calm conflict copies", async () => {
    document.cookie = "core_agent_csrf=csrf-services; Path=/";
    const fetchImpl = vi.fn(async () => Response.json({
      schema_version: 1,
      error_id: "error_seat",
      code: "AUTH_CONFLICT",
      category: "conflict",
      message: "可分配名额已用完。",
      retryable: false,
      request_id: "request_seat",
      trace_id: "trace_seat",
    }, { status: 409 }));
    const api = createServicesApi(fetchImpl as typeof fetch, { idempotencyKey: () => "service_seat" });
    await expect(api.mutate({
      kind: "seat_assign",
      tenantId: "tenant_company",
      entitlementId: "entitlement_company",
      expectedResourceVersion: 1,
      profileId: "profile_consultant",
    })).rejects.toMatchObject({ reason: "seat_exhausted" });
  });
});
