import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadPolicyGatewayConfig } from "./config.js";
import { createProductionPolicyGateway } from "./production.js";
import { buildPolicyMcpGatewayApp } from "./server.js";

export async function runPolicyMcpGateway(): Promise<void> {
  let production;
  let app;
  try {
    const config = loadPolicyGatewayConfig(process.env);
    production = await createProductionPolicyGateway(config);
    app = buildPolicyMcpGatewayApp(production.operations);
    await app.listen({ host: config.host, port: config.port });
  } catch {
    process.stderr.write("POLICY_MCP_GATEWAY_FAILED\n"); process.exitCode = 1; return;
  }
  const shutdown = (): void => { void app!.close().then(() => production!.close()).finally(() => { process.exitCode = 0; }); };
  process.once("SIGTERM", shutdown); process.once("SIGINT", shutdown);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void runPolicyMcpGateway();
