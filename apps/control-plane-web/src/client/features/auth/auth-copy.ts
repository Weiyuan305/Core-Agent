import { AuthClientError, type AuthClientFailureReason } from "./auth-api.js";

export const AUTH_COPY: Readonly<Record<AuthClientFailureReason, string>> = Object.freeze({
  anonymous: "请重新登录后继续。",
  invalid: "无法完成验证，请检查信息后重试。",
  conflict: "信息已经发生变化，请刷新后重试。",
  rate_limited: "尝试次数较多，请稍后再试。",
  reauthentication_required: "请先确认当前密码。",
  unavailable: "登录服务暂时不可用，请稍后再试。",
});

export function authErrorCopy(error: unknown): string {
  return error instanceof AuthClientError ? AUTH_COPY[error.reason] : AUTH_COPY.unavailable;
}
