import type { ClientRunFailureReason } from "../../shared/protocol.js";

export type RunFailureCopy = Readonly<
  | { readonly message: string; readonly intent: "none" }
  | {
    readonly message: string;
    readonly action: string;
    readonly intent: "retry" | "refresh";
  }
>;

export const RUN_FAILURE_COPY: Readonly<Record<ClientRunFailureReason, RunFailureCopy>> = Object.freeze({
  BUSY: Object.freeze({ message: "现在请求较多，请稍后再试。", action: "再试一次", intent: "retry" }),
  TEMPORARILY_UNAVAILABLE: Object.freeze({ message: "Core Agent 暂时无法回复，请稍后再试。", action: "再试一次", intent: "retry" }),
  TOOK_TOO_LONG: Object.freeze({ message: "这次回复等待时间较长，请再试一次。", action: "重新生成", intent: "retry" }),
  SERVICE_UNAVAILABLE: Object.freeze({ message: "这项服务暂时无法使用。如问题持续，请联系支持。", intent: "none" }),
  REPLY_INTERRUPTED: Object.freeze({ message: "这条回复没有完成，内容可能不完整。", action: "重新生成", intent: "retry" }),
  NO_REPLY: Object.freeze({ message: "这次没有生成回复，请再试一次。", action: "再试一次", intent: "retry" }),
  ASSISTANT_PREPARING: Object.freeze({ message: "Core Agent 正在准备中，请稍后再试。", action: "刷新状态", intent: "refresh" }),
  UNKNOWN: Object.freeze({ message: "暂时无法完成这次请求，请稍后再试。", action: "再试一次", intent: "retry" }),
});
