import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { applyMigrations, canonicalPayloadHash, createRuntimeDatabase, issueCoreSession } from "@core-agent/runtime-core";
import { Pool } from "pg";

import { buildIdentityGatewayApp } from "../../src/app.js";
import { identityGatewayServerTestInternals } from "../../src/server.js";

const databaseUrl = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
if (databaseUrl === undefined || !new URL(databaseUrl).pathname.slice(1).startsWith("core_agent_")) {
  throw new Error("CONTROL_PLANE_TEST_DATABASE_URL must name a disposable core_agent_ database");
}
const migrations = join(dirname(fileURLToPath(import.meta.url)), "../../../../packages/runtime-core/migrations");

test("production entitlement administration enforces durable platform, company, and student authority", async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  const db = createRuntimeDatabase(pool);
  try {
    await pool.query("drop schema public cascade; create schema public");
    await applyMigrations(pool, migrations);
    const now = new Date();
    await pool.query(
      `insert into tenants (tenant_id, schema_version, resource_version, tenant_mode, status, display_name, created_at, updated_at)
       values ('tenant_platform', 1, 1, 'b2b', 'active', 'Platform', $1, $1),
              ('tenant_company', 1, 1, 'b2b', 'active', 'Company', $1, $1),
              ('tenant_student', 1, 1, 'b2c', 'active', 'Student', $1, $1)`,
      [now],
    );
    await pool.query(
      `insert into actors (actor_id, schema_version, resource_version, actor_kind, display_name, status, created_at, updated_at)
       values ('actor_platform',1,1,'human','Platform admin','active',$1,$1),
              ('actor_company',1,1,'human','Company admin','active',$1,$1),
              ('actor_consultant',1,1,'human','Consultant','active',$1,$1),
              ('actor_student',1,1,'human','Student','active',$1,$1)`,
      [now],
    );
    await pool.query(
      `insert into memberships (tenant_id,membership_id,actor_id,schema_version,resource_version,roles,membership_source,seat_ref,status,created_at,updated_at)
       values ('tenant_platform','membership_platform','actor_platform',1,1,array['admin'],'platform',null,'active',$1,$1),
              ('tenant_company','membership_platform_company','actor_platform',1,1,array['admin'],'platform',null,'active',$1,$1),
              ('tenant_company','membership_company','actor_company',1,1,array['admin','consultant'],'company',null,'active',$1,$1),
              ('tenant_company','membership_consultant','actor_consultant',1,1,array['consultant'],'company',null,'active',$1,$1),
              ('tenant_student','membership_student','actor_student',1,1,array['student'],'self',null,'active',$1,$1)`,
      [now],
    );
    await pool.query(
      `insert into platform_role_assignments (platform_role_assignment_id,actor_id,role,status,resource_version,created_at,updated_at)
       values ('role_platform','actor_platform','platform_super_admin','active',1,$1,$1)`,
      [now],
    );
    await pool.query(
      `insert into auth_subjects (auth_subject_id,actor_id,provider,provider_subject,provider_identity_kind,verified_at,status,resource_version,created_at,updated_at)
       values ('auth_platform','actor_platform','supabase','provider_platform','email_password',$1,'active',1,$1,$1),
              ('auth_company','actor_company','supabase','provider_company','email_password',$1,'active',1,$1,$1),
              ('auth_consultant','actor_consultant','supabase','provider_consultant','email_password',$1,'active',1,$1,$1),
              ('auth_student','actor_student','supabase','provider_student','email_password',$1,'active',1,$1,$1)`,
      [now],
    );
    const issuedSessions = new Map<string, Awaited<ReturnType<typeof issueCoreSession>>>();
    for (const [sessionId, actorId, authSubjectId] of [
      ["session_platform", "actor_platform", "auth_platform"],
      ["session_company", "actor_company", "auth_company"],
      ["session_consultant", "actor_consultant", "auth_consultant"],
      ["session_student", "actor_student", "auth_student"],
    ] as const) {
      const issued = await issueCoreSession({ db }, { sessionId, actorId, authSubjectId, clientKind: "web", deviceLabel: "Browser" });
      issuedSessions.set(actorId, issued);
      await pool.query("update core_sessions set reauthenticated_at = clock_timestamp() where session_id = $1", [sessionId]);
    }
    await pool.query(
      `insert into profiles (tenant_id,profile_id,schema_version,resource_version,owner_actor_id,profile_kind,hermes_profile_ref,description,status,provider_config_id,model_id,created_at,updated_at)
       values ('tenant_company','profile_company',1,1,'actor_company','consultant','profile-company','Company profile','active','provider','model',$1,$1),
              ('tenant_student','profile_student',1,1,'actor_student','default','profile-student','Student profile','active','provider','model',$1,$1)`,
      [now],
    );

    const key = Buffer.alloc(32, 0x61);
    const operations = identityGatewayServerTestInternals.productionOperations(
      db,
      key,
      identityGatewayServerTestInternals.aesProtector(key, "task10-pii"),
      identityGatewayServerTestInternals.aesProtector(key, "task10-oauth"),
      "tenant_platform",
    );
    const platformAuthority = { actorId: "actor_platform", authSubjectId: "auth_platform", session: { session_id: "session_platform", client_kind: "web", session_resource_version: 1 } };
    const companyAuthority = { actorId: "actor_company", authSubjectId: "auth_company", session: { session_id: "session_company", client_kind: "web", session_resource_version: 1 } };
    const consultantAuthority = { actorId: "actor_consultant", authSubjectId: "auth_consultant", session: { session_id: "session_consultant", client_kind: "web", session_resource_version: 1 } };
    const studentAuthority = { actorId: "actor_student", authSubjectId: "auth_student", session: { session_id: "session_student", client_kind: "web", session_resource_version: 1 } };

    const catalog = await operations.executeAuthorityCommand({ kind: "platform_catalog_list", payload: {}, authority: platformAuthority });
    assert.deepEqual(catalog, { schema_version: 1, capabilities: [], packs: [] });
    const company = await operations.executeAuthorityCommand({ kind: "company_service_list", payload: { tenant_id: "tenant_company" }, authority: companyAuthority });
    assert.deepEqual(company, { schema_version: 1, services: [] });
    const student = await operations.executeAuthorityCommand({ kind: "student_service_list", payload: {}, authority: studentAuthority });
    assert.deepEqual(student, { schema_version: 1, services: [] });
    await assert.rejects(
      operations.executeAuthorityCommand({ kind: "company_service_list", payload: { tenant_id: "tenant_company" }, authority: studentAuthority }),
      { code: "UNAUTHENTICATED" },
    );
    await assert.rejects(
      operations.executeAuthorityCommand({ kind: "company_service_list", payload: { tenant_id: "tenant_company" }, authority: consultantAuthority }),
      { code: "UNAUTHENTICATED" },
    );
    const foreignFailure = await operations.executeAuthorityCommand({ kind: "company_service_list", payload: { tenant_id: "tenant_student" }, authority: companyAuthority })
      .then(() => undefined, (error: unknown) => (error as { code?: unknown }).code);
    const unknownFailure = await operations.executeAuthorityCommand({ kind: "company_service_list", payload: { tenant_id: "tenant_missing" }, authority: companyAuthority })
      .then(() => undefined, (error: unknown) => (error as { code?: unknown }).code);
    assert.equal(foreignFailure, "UNAUTHENTICATED");
    assert.equal(unknownFailure, foreignFailure, "unknown and other-Tenant resources must be indistinguishable");

    const createFacts = {
      schema_version: 1 as const, idempotency_key: "task10_capability_create",
      capability_id: "capability_task10", capability_version_id: "capability_version_task10",
      display_name: "Task 10 capability", owning_domain: "core", kind: "mcp" as const, version: "1.0.0",
      artifact_ref: `manifest:sha256:${"a".repeat(64)}`, contract_ref: "core-agent.contracts@0.8.0",
      risk_class: "read" as const, approval_requirement: "none" as const,
      compatibility: { core_contract_version: "0.8.0", domain_contract_version: "1.0.0", runtime_protocol_version: "1.0.0", tenant_modes: ["b2b", "b2c"] as const },
      expected_resource_version: null,
    };
    const created = await operations.executeProtectedAuthorityCommand({
      kind: "catalog_capability_create", payload: { ...createFacts, payload_hash: canonicalPayloadHash(createFacts) }, authority: platformAuthority,
    });
    assert.equal((created as { status?: unknown }).status, "draft");
    assert.equal((await pool.query("select count(*)::int as count from capability_versions where capability_version_id = 'capability_version_task10'")).rows[0]?.count, 1);

    const capabilityReviewFacts = {
      schema_version: 1 as const, idempotency_key: "task10_capability_review",
      capability_version_id: "capability_version_task10", expected_resource_version: 1,
    };
    await operations.executeProtectedAuthorityCommand({
      kind: "catalog_capability_review",
      payload: { ...capabilityReviewFacts, payload_hash: canonicalPayloadHash(capabilityReviewFacts) },
      authority: platformAuthority,
    });
    const packFacts = {
      schema_version: 1 as const, idempotency_key: "task10_pack_create",
      pack_product_id: "pack_task10", pack_version_id: "pack_version_task10",
      display_name: "Task 10 Service", tenant_modes: ["b2b", "b2c"] as const,
      version: "1.0.0", expected_resource_version: null,
      members: [{ capability_id: "capability_task10", capability_version_id: "capability_version_task10", version: "1.0.0" }],
    };
    await operations.executeProtectedAuthorityCommand({
      kind: "catalog_pack_create", payload: { ...packFacts, payload_hash: canonicalPayloadHash(packFacts) }, authority: platformAuthority,
    });
    for (const [kind, idempotencyKey, expectedResourceVersion] of [
      ["catalog_pack_review", "task10_pack_review", 1],
      ["catalog_pack_publish", "task10_pack_publish", 2],
    ] as const) {
      const facts = { schema_version: 1 as const, idempotency_key: idempotencyKey, pack_version_id: "pack_version_task10", expected_resource_version: expectedResourceVersion };
      await operations.executeProtectedAuthorityCommand({ kind, payload: { ...facts, payload_hash: canonicalPayloadHash(facts) }, authority: platformAuthority });
    }

    const releaseFacts = new Map<string, Record<string, unknown>>();
    for (const [tenantId, idempotencyKey] of [
      ["tenant_company", "task10_release_company"], ["tenant_student", "task10_release_student"],
    ] as const) {
      const facts = {
        schema_version: 1 as const, idempotency_key: idempotencyKey, tenant_id: tenantId,
        pack_product_id: "pack_task10", pack_version_id: "pack_version_task10", expected_resource_version: 1,
      };
      releaseFacts.set(tenantId, facts);
      await operations.executeProtectedAuthorityCommand({
        kind: "entitlement_select_release", payload: { ...facts, payload_hash: canonicalPayloadHash(facts) }, authority: platformAuthority,
      });
    }
    const companyGrantFacts = {
      schema_version: 1 as const, idempotency_key: "task10_grant_company", tenant_id: "tenant_company",
      pack_product_id: "pack_task10", source: "platform_manual" as const, external_order_ref: "order_company_internal",
      expected_resource_version: 1, tenant_mode: "b2b" as const, assignment_mode: "seat" as const, seat_quantity: 2,
    };
    const companyGrant = await operations.executeProtectedAuthorityCommand({
      kind: "entitlement_grant", payload: { ...companyGrantFacts, payload_hash: canonicalPayloadHash(companyGrantFacts) }, authority: platformAuthority,
    }) as { entitlement_id: string };
    const studentGrantFacts = {
      schema_version: 1 as const, idempotency_key: "task10_grant_student", tenant_id: "tenant_student",
      pack_product_id: "pack_task10", source: "platform_manual" as const, external_order_ref: "order_student_internal",
      expected_resource_version: 1, tenant_mode: "b2c" as const, assignment_mode: "automatic" as const,
    };
    await operations.executeProtectedAuthorityCommand({
      kind: "entitlement_grant", payload: { ...studentGrantFacts, payload_hash: canonicalPayloadHash(studentGrantFacts) }, authority: platformAuthority,
    });
    const seatFacts = {
      schema_version: 1 as const, idempotency_key: "task10_seat_assign",
      entitlement_id: companyGrant.entitlement_id, expected_resource_version: 1, profile_id: "profile_company",
    };
    const seatResult = await operations.executeProtectedAuthorityCommand({
      kind: "entitlement_seat_assign",
      payload: { ...seatFacts, payload_hash: canonicalPayloadHash(seatFacts), tenant_id: "tenant_company" },
      authority: companyAuthority,
    }) as { assignment_id: string; resource_version: number };

    const consultantSeatFacts = { ...seatFacts, idempotency_key: "task10_consultant_forbidden" };
    await assert.rejects(operations.executeProtectedAuthorityCommand({
      kind: "entitlement_seat_assign",
      payload: { ...consultantSeatFacts, payload_hash: canonicalPayloadHash(consultantSeatFacts), tenant_id: "tenant_company" },
      authority: consultantAuthority,
    }), { code: "UNAUTHENTICATED" });

    const wrongOuterTenantFacts = {
      schema_version: 1 as const,
      idempotency_key: "task10_wrong_outer_tenant_revoke",
      assignment_id: seatResult.assignment_id,
      expected_resource_version: seatResult.resource_version,
      reason_code: "administrator_revoked" as const,
    };
    await assert.rejects(operations.executeProtectedAuthorityCommand({
      kind: "entitlement_seat_revoke",
      payload: {
        ...wrongOuterTenantFacts,
        payload_hash: canonicalPayloadHash(wrongOuterTenantFacts),
        tenant_id: "tenant_student",
      },
      authority: companyAuthority,
    }), { code: "RESOURCE_NOT_FOUND" });
    assert.deepEqual((await pool.query(
      "select status, resource_version::int as resource_version from entitlement_assignments where assignment_id = $1",
      [seatResult.assignment_id],
    )).rows, [{ status: "preparing", resource_version: seatResult.resource_version }],
    "a mismatched outer Tenant must not mutate the discovered company assignment");

    await pool.query("update core_sessions set reauthenticated_at = clock_timestamp() - interval '10 minutes' where session_id = 'session_company'");
    const revokeFacts = {
      schema_version: 1 as const, idempotency_key: "task10_stale_revoke",
      assignment_id: seatResult.assignment_id, expected_resource_version: seatResult.resource_version,
      reason_code: "administrator_revoked" as const,
    };
    const staleExistingFailure = await operations.executeProtectedAuthorityCommand({
      kind: "entitlement_seat_revoke",
      payload: { ...revokeFacts, payload_hash: canonicalPayloadHash(revokeFacts), tenant_id: "tenant_company" },
      authority: companyAuthority,
    }).then(() => undefined, (error: unknown) => (error as { code?: unknown }).code);
    const missingRevokeFacts = {
      ...revokeFacts,
      idempotency_key: "task10_stale_missing_revoke",
      assignment_id: "assignment_missing",
    };
    const staleMissingFailure = await operations.executeProtectedAuthorityCommand({
      kind: "entitlement_seat_revoke",
      payload: { ...missingRevokeFacts, payload_hash: canonicalPayloadHash(missingRevokeFacts), tenant_id: "tenant_company" },
      authority: companyAuthority,
    }).then(() => undefined, (error: unknown) => (error as { code?: unknown }).code);
    assert.equal(staleExistingFailure, "UNAUTHENTICATED");
    assert.equal(staleMissingFailure, staleExistingFailure,
      "stale reauthentication must fail before existing versus missing seat discovery");
    await assert.rejects(
      operations.executeAuthorityCommand({ kind: "company_service_list", payload: { tenant_id: "tenant_company" }, authority: companyAuthority }),
      { code: "UNAUTHENTICATED" },
    );
    await pool.query("update core_sessions set reauthenticated_at = clock_timestamp() where session_id = 'session_company'");

    const companyView = await operations.executeAuthorityCommand({ kind: "company_service_list", payload: { tenant_id: "tenant_company" }, authority: companyAuthority }) as { services: readonly Record<string, unknown>[] };
    assert.equal(companyView.services.length, 1);
    assert.deepEqual({
      display_name: companyView.services[0]?.display_name,
      used_seats: companyView.services[0]?.used_seats,
      total_seats: companyView.services[0]?.total_seats,
      available_seats: companyView.services[0]?.available_seats,
      service_state: companyView.services[0]?.service_state,
    }, { display_name: "Task 10 Service", used_seats: 1, total_seats: 2, available_seats: 1, service_state: "preparing" });
    assert.doesNotMatch(JSON.stringify(companyView), /artifact_ref|contract_ref|external_order_ref|order_company|runtime_container|failure_summary/u);
    const assignmentView = await operations.executeAuthorityCommand({ kind: "company_assignment_list", payload: { tenant_id: "tenant_company" }, authority: companyAuthority }) as { assignments: readonly unknown[] };
    assert.equal(assignmentView.assignments.length, 1);
    await pool.query("update profiles set description = $1 where tenant_id = 'tenant_company' and profile_id = 'profile_company'", ["x".repeat(300)]);
    const boundedAssignments = await operations.executeAuthorityCommand({ kind: "company_assignment_list", payload: { tenant_id: "tenant_company" }, authority: companyAuthority }) as { assignments: readonly { profile_display_name: string }[] };
    assert.equal(boundedAssignments.assignments[0]?.profile_display_name.length, 200);
    const studentView = await operations.executeAuthorityCommand({ kind: "student_service_list", payload: {}, authority: studentAuthority }) as { services: readonly Record<string, unknown>[] };
    assert.equal(studentView.services.length, 1);
    assert.equal(studentView.services[0]?.display_name, "Task 10 Service");
    assert.doesNotMatch(JSON.stringify(studentView), /capability|pack_version|external_order|artifact|contract|container|failure/u);

    const companyIssued = issuedSessions.get("actor_company")!;
    const platformIssued = issuedSessions.get("actor_platform")!;
    const app = await buildIdentityGatewayApp({
      config: {
        publicOrigins: new Set(["https://app.example.test"]), cookieHost: "identity.example.test",
        publicBaseUrl: "https://identity.example.test", providerUrl: "https://provider.example.test",
        appleWebRedirectUris: new Set(["https://app.example.test/auth/apple/callback"]),
        appleNativeRedirectUris: new Set(["coreagent://auth/apple/callback"]),
        passwordResetRedirectUri: "https://app.example.test/auth/password/reset/callback", publicAuthEnabled: true,
      },
      provider: {} as never, operations, flowCookieKey: Buffer.alloc(32, 0x62),
    });
    try {
      const response = await app.inject({
        method: "GET", url: "/app/v1/company/services?tenant_id=tenant_company",
        headers: {
          host: "identity.example.test", origin: "https://app.example.test",
          cookie: `core_agent_session=${companyIssued.sessionSecret}; core_agent_csrf=${companyIssued.csrfSecret}`,
        },
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().services[0]?.display_name, "Task 10 Service");
      const companyRelease = releaseFacts.get("tenant_company")!;
      const selection = await app.inject({
        method: "POST", url: "/app/v1/platform/entitlements",
        headers: {
          host: "identity.example.test", origin: "https://app.example.test", "content-type": "application/json",
          "x-core-agent-csrf": platformIssued.csrfSecret!,
          cookie: `core_agent_session=${platformIssued.sessionSecret}; core_agent_csrf=${platformIssued.csrfSecret}`,
        },
        payload: { action: "select_release", command: { ...companyRelease, payload_hash: canonicalPayloadHash(companyRelease) } },
      });
      assert.equal(selection.statusCode, 200, selection.body);
      assert.deepEqual(selection.json(), {
        schema_version: 1,
        release_id: selection.json().release_id,
        generation: 1,
        state: "replay",
      });
    } finally {
      await app.close();
    }
    await pool.query("update tenants set status = 'closed' where tenant_id = 'tenant_platform'");
    const closedAuthorityFacts = {
      schema_version: 1 as const,
      idempotency_key: "task10_closed_platform_authority",
      tenant_id: "tenant_company",
      pack_product_id: "pack_task10",
      pack_version_id: "pack_version_task10",
      expected_resource_version: 1,
    };
    await assert.rejects(operations.executeProtectedAuthorityCommand({
      kind: "entitlement_select_release",
      payload: { ...closedAuthorityFacts, payload_hash: canonicalPayloadHash(closedAuthorityFacts) },
      authority: platformAuthority,
    }), { code: "INVALID_STATE_TRANSITION" });
    await pool.query("update tenants set status = 'active', tenant_mode = 'b2c' where tenant_id = 'tenant_platform'");
    const b2cAuthorityFacts = {
      ...closedAuthorityFacts,
      idempotency_key: "task10_b2c_platform_authority",
    };
    await assert.rejects(operations.executeProtectedAuthorityCommand({
      kind: "entitlement_select_release",
      payload: { ...b2cAuthorityFacts, payload_hash: canonicalPayloadHash(b2cAuthorityFacts) },
      authority: platformAuthority,
    }), { code: "INVALID_STATE_TRANSITION" });
  } finally {
    await db.destroy();
  }
});
