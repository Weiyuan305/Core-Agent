import { randomUUID } from "node:crypto";

import type {
  ProviderCatalog,
  Redactor,
  RuntimeDatabase,
  RuntimeEnvironment,
} from "@core-agent/runtime-core";
import { DomainError } from "@core-agent/runtime-core";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyRequest,
} from "fastify";
import type { Kysely } from "kysely";

import {
  authenticateBootstrapRequest,
  loadBootstrapKeyDigest,
  type ApiRequestContext,
} from "./auth.js";
import { mapApiError } from "./errors.js";
import {
  registerHealthRoutes,
  type HealthDependencies,
} from "./routes/health.js";

export const MAX_API_BODY_BYTES = 64 * 1024;
export const MAX_API_HEADER_BYTES = 16 * 1024;

interface ApiIdentifiers {
  readonly requestId: string;
  readonly traceId: string;
}

declare module "fastify" {
  interface FastifyRequest {
    apiIdentifiers: ApiIdentifiers;
    apiContext: ApiRequestContext;
  }

  interface FastifyContextConfig {
    tenantScoped?: boolean;
  }
}

export interface ControlPlaneAppDependencies extends HealthDependencies {
  readonly environment: RuntimeEnvironment;
  readonly db: Kysely<RuntimeDatabase>;
  readonly providerCatalog: ProviderCatalog;
  readonly logger: FastifyBaseLogger;
  readonly redactor: Redactor;
}

export async function cleanupFailedAppStartup(
  app: Pick<FastifyInstance, "close"> | undefined,
  bootstrapDigest: Buffer,
): Promise<void> {
  try {
    await app?.close();
  } catch {
    // Preserve the original startup failure while still releasing key material.
  } finally {
    bootstrapDigest.fill(0);
  }
}

function isProtectedRequest(request: FastifyRequest): boolean {
  const path = request.url.split("?", 1)[0];
  return path === "/internal/v1" || path?.startsWith("/internal/v1/") === true;
}

export async function buildControlPlaneApp(dependencies: ControlPlaneAppDependencies): Promise<FastifyInstance> {
  const bootstrapDigest = await loadBootstrapKeyDigest(dependencies.environment.bootstrapKeyFile);
  let app: FastifyInstance | undefined;
  try {
    app = Fastify({
      loggerInstance: dependencies.logger,
      bodyLimit: MAX_API_BODY_BYTES,
      http: { maxHeaderSize: MAX_API_HEADER_BYTES },
      requestIdHeader: false,
      genReqId: () => `request_${randomUUID()}`,
      onProtoPoisoning: "error",
      onConstructorPoisoning: "error",
      ajv: {
        customOptions: {
          removeAdditional: false,
          coerceTypes: false,
          useDefaults: false,
        },
      },
    });
    app.decorateRequest("apiIdentifiers");
    app.decorateRequest("apiContext");
    app.addHook("onClose", async () => {
      bootstrapDigest.fill(0);
    });

    app.addHook("onRequest", async (request) => {
      request.apiIdentifiers = Object.freeze({
        requestId: request.id,
        traceId: `trace_${randomUUID()}`,
      });
      if (!isProtectedRequest(request)) return;
      request.apiContext = authenticateBootstrapRequest({
        configuredDigest: bootstrapDigest,
        headers: request.headers,
        rawHeaders: request.raw.rawHeaders,
        tenantScoped: request.routeOptions.config.tenantScoped === true,
        requestId: request.apiIdentifiers.requestId,
        traceId: request.apiIdentifiers.traceId,
      });
    });

    app.setNotFoundHandler(async () => {
      throw new DomainError("RESOURCE_NOT_FOUND", "Route was not found");
    });

    app.setErrorHandler((error, request, reply) => {
      const identifiers = request.apiIdentifiers ?? {
        requestId: request.id,
        traceId: `trace_${randomUUID()}`,
      };
      const mapped = mapApiError(error, { ...identifiers, redactor: dependencies.redactor });
      const fields = { error: mapped.envelope };
      if (mapped.internalError === undefined) {
        request.log.warn(fields, "API request rejected");
      } else {
        request.log.error({ ...fields, internal_error: mapped.internalError }, "API request failed");
      }
      void reply.code(mapped.statusCode).type("application/json").send(mapped.envelope);
    });

    await registerHealthRoutes(app, dependencies);
    return app;
  } catch (error) {
    await cleanupFailedAppStartup(app, bootstrapDigest);
    throw error;
  }
}
