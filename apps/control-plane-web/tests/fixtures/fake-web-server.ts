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
    async runPrompt(_conversationId, content, sink, options) {
      sink.onStarted();
      if (content === "匿名失败界面测试" && options === undefined) {
        await delay(12);
        return {
          status: "failed",
          runId: "synthetic_run_busy",
          failureCode: "MODEL_BUSY",
        } as const;
      }
      if (content === "匿名部分失败界面测试" && options === undefined) {
        await delay(12);
        sink.onDelta("已经生成的匿名内容。");
        await delay(12);
        return {
          status: "failed",
          runId: "synthetic_run_interrupted",
          failureCode: "MODEL_STREAM_INTERRUPTED",
        } as const;
      }
      await delay(12);
      if (content === "匿名长回复界面测试" && options === undefined) {
        sink.onDelta("这是一段用于验证长对话滚动区域的匿名合成内容。".repeat(80));
        return {
          status: "succeeded",
          runId: "synthetic_run_long_success",
        } as const;
      }
      sink.onDelta(options === undefined ? "这是用于界面验收的" : "这是重新生成的");
      await delay(12);
      sink.onDelta("匿名合成回复。");
      return {
        status: "succeeded",
        runId: options === undefined ? "synthetic_run_success" : "synthetic_run_retry_success",
      } as const;
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
