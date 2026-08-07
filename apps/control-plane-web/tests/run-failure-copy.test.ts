import { describe, expect, it } from "vitest";

import { RUN_FAILURE_COPY } from "../src/client/content/run-failure-copy.js";
import type { ClientRunFailureReason } from "../src/shared/protocol.js";

describe("Chinese Run failure copy", () => {
  it("is exhaustive and contains only the approved product language", () => {
    const expected: Record<ClientRunFailureReason, unknown> = {
      BUSY: { message: "现在请求较多，请稍后再试。", action: "再试一次", intent: "retry" },
      TEMPORARILY_UNAVAILABLE: { message: "Core Agent 暂时无法回复，请稍后再试。", action: "再试一次", intent: "retry" },
      TOOK_TOO_LONG: { message: "这次回复等待时间较长，请再试一次。", action: "重新生成", intent: "retry" },
      SERVICE_UNAVAILABLE: { message: "这项服务暂时无法使用。如问题持续，请联系支持。", intent: "none" },
      REPLY_INTERRUPTED: { message: "这条回复没有完成，内容可能不完整。", action: "重新生成", intent: "retry" },
      NO_REPLY: { message: "这次没有生成回复，请再试一次。", action: "再试一次", intent: "retry" },
      ASSISTANT_PREPARING: { message: "Core Agent 正在准备中，请稍后再试。", action: "刷新状态", intent: "refresh" },
      UNKNOWN: { message: "暂时无法完成这次请求，请稍后再试。", action: "再试一次", intent: "retry" },
    };
    expect(RUN_FAILURE_COPY).toEqual(expected);
    expect(JSON.stringify(RUN_FAILURE_COPY)).not.toMatch(
      /(?:503|SSE|Hermes|Worker|MODEL_|CLIENT_RUN_FAILED|provider|tokenhub)/u,
    );
  });
});
