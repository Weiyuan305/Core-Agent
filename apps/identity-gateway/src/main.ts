import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startIdentityGatewayServer } from "./server.js";

export async function runIdentityGateway(): Promise<void> {
  let app;
  try {
    app = await startIdentityGatewayServer();
  } catch {
    process.stderr.write("IDENTITY_GATEWAY_FAILED\n");
    process.exitCode = 1;
    return;
  }
  const shutdown = (): void => {
    void app.close().finally(() => {
      process.exitCode = 0;
    });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runIdentityGateway();
}
