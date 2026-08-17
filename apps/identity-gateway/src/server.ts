import type { FastifyInstance } from "fastify";

import { buildIdentityGatewayApp, type BuildIdentityGatewayAppDependencies } from "./app.js";
import { loadIdentityGatewayConfig } from "./config.js";

export interface IdentityGatewayServerDependencies extends Omit<BuildIdentityGatewayAppDependencies, "config"> {
  readonly environment?: NodeJS.ProcessEnv;
}

export async function startIdentityGatewayServer(dependencies: IdentityGatewayServerDependencies): Promise<FastifyInstance> {
  const config = loadIdentityGatewayConfig(dependencies.environment ?? process.env);
  const app = await buildIdentityGatewayApp({ ...dependencies, config });
  try {
    await app.listen({ host: config.host, port: config.port });
    return app;
  } catch (error) {
    await app.close().catch(() => undefined);
    throw error;
  }
}
