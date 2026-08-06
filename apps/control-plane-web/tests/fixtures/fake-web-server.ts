import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { buildClientGatewayApp } from "../../src/server/app.js";
import type { ManagedChatPort } from "../../src/server/runtime-chat-port.js";

const delay = (milliseconds: number): Promise<void> => new Promise((complete) => {
  setTimeout(complete, milliseconds);
});

let startupStage = "initialize";

async function start(): Promise<void> {
  let conversationNumber = 0;
  const port: ManagedChatPort = Object.freeze({
    async createConversation(): Promise<string> {
      conversationNumber += 1;
      return `synthetic_internal_conversation_${conversationNumber}`;
    },
    async runPrompt(_conversationId, _content, sink): Promise<void> {
      sink.onStarted();
      await delay(12);
      sink.onDelta("这是用于界面验收的");
      await delay(12);
      sink.onDelta("匿名合成回复。");
    },
    async restartApiWorker(): Promise<void> {
      await delay(24);
    },
  });
  const packageRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  startupStage = "build";
  const app = await buildClientGatewayApp({ port, staticRoot: resolve(packageRoot, "dist/client") });
  const stop = (): void => {
    void app.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  startupStage = "listen";
  await app.listen({ host: "127.0.0.1", port: 4_174 });
  process.stdout.write("FAKE_WEB_READY\n");
}

void start().catch((error: unknown) => {
  const candidate = typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "UNKNOWN";
  const code = new Set(["EACCES", "EADDRINUSE", "EPERM"]).has(candidate) ? candidate : "UNKNOWN";
  process.stderr.write(`FAKE_WEB_FAILED_${startupStage.toUpperCase()}_${code}\n`);
  process.exitCode = 1;
});
