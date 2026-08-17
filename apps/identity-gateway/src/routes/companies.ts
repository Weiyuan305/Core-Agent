import {
  CompanyConsultantRoleGrantRequestSchema,
  CompanyConsultantRoleGrantResponseSchema,
  CompanyConsultantRoleRemoveRequestSchema,
  CompanyConsultantRoleRemoveResponseSchema,
  CompanyCreateRequestSchema,
  CompanyCreateResponseSchema,
  CompanyMemberInviteRequestSchema,
  CompanyMemberInviteResponseSchema,
  CompanyMemberListRequestSchema,
  CompanyMemberListResponseSchema,
  CompanyMemberRevokeRequestSchema,
  CompanyMemberRevokeResponseSchema,
  CompanyMemberSuspendRequestSchema,
  CompanyMemberSuspendResponseSchema,
} from "@core-agent/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { GatewayAuthenticatedSession, IdentityGatewayRouteDependencies } from "../app.js";
import { assertClientTransport, requireMutationCredentials } from "../security.js";

async function protectedAuthority(request: FastifyRequest, dependencies: IdentityGatewayRouteDependencies): Promise<GatewayAuthenticatedSession> {
  assertClientTransport(request, "web", dependencies.config);
  const credential = requireMutationCredentials(request);
  return dependencies.operations.authenticateSession({ sessionSecret: credential.sessionSecret, csrfSecret: credential.csrfSecret, requireCsrf: true });
}

export async function registerCompanyRoutes(app: FastifyInstance, dependencies: IdentityGatewayRouteDependencies): Promise<void> {
  const protectedRoute = (path: string, requestSchema: object, responseSchema: object, kind: string) => {
    app.post(path, { schema: { body: requestSchema, response: { 200: responseSchema } } }, async (request) => {
      const authority = await protectedAuthority(request, dependencies);
      return dependencies.operations.executeProtectedAuthorityCommand({ kind, payload: request.body, authority });
    });
  };
  protectedRoute("/auth/v1/companies", CompanyCreateRequestSchema, CompanyCreateResponseSchema, "company_create");
  protectedRoute("/auth/v1/companies/members", CompanyMemberInviteRequestSchema, CompanyMemberInviteResponseSchema, "company_member_invite");
  protectedRoute("/auth/v1/companies/members/list", CompanyMemberListRequestSchema, CompanyMemberListResponseSchema, "company_member_list");
  protectedRoute("/auth/v1/companies/members/consultant/grant", CompanyConsultantRoleGrantRequestSchema, CompanyConsultantRoleGrantResponseSchema, "company_consultant_grant");
  protectedRoute("/auth/v1/companies/members/consultant/remove", CompanyConsultantRoleRemoveRequestSchema, CompanyConsultantRoleRemoveResponseSchema, "company_consultant_remove");
  protectedRoute("/auth/v1/companies/members/suspend", CompanyMemberSuspendRequestSchema, CompanyMemberSuspendResponseSchema, "company_member_suspend");
  protectedRoute("/auth/v1/companies/members/revoke", CompanyMemberRevokeRequestSchema, CompanyMemberRevokeResponseSchema, "company_member_revoke");
}
