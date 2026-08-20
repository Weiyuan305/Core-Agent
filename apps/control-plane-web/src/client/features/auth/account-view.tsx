import type { AuthSessionView } from "@core-agent/contracts";

import type { AccountDeletionView } from "./auth-api.js";

export interface AccountViewProps {
  readonly busy: boolean;
  readonly deletion?: AccountDeletionView | undefined;
  readonly error?: string | undefined;
  readonly onBack: () => void;
  readonly onCancelDeletion: () => void;
  readonly onDelete: () => void;
  readonly onRevokeSession: () => void;
  readonly onSignOut: () => void;
  readonly session: AuthSessionView;
}

export function AccountView({ busy, deletion, error, onBack, onCancelDeletion, onDelete, onRevokeSession, onSignOut, session }: AccountViewProps) {
  return (
    <main className="management-card" aria-labelledby="account-title">
      <button className="auth-link auth-link--back" onClick={onBack} type="button">返回</button>
      <p className="auth-eyebrow">账户与安全</p>
      <h1 id="account-title">管理当前账户</h1>
      <dl className="account-facts">
        <div><dt>当前设备</dt><dd>Web 浏览器</dd></div>
        <div><dt>会话到期</dt><dd>{new Date(session.absolute_expires_at).toLocaleDateString("zh-CN")}</dd></div>
      </dl>
      {error === undefined ? null : <p className="auth-message auth-message--error" role="alert">{error}</p>}
      {deletion === undefined ? (
        <section className="danger-zone" aria-labelledby="delete-title">
          <h2 id="delete-title">删除账户</h2>
          <p>申请后立即退出，账户将在 30 天恢复期结束后完成清理。</p>
          <button className="auth-danger" disabled={busy} onClick={onDelete} type="button">申请删除账户</button>
        </section>
      ) : (
        <section className="danger-zone" aria-live="polite">
          <h2>账户删除已安排</h2>
          <p>账户将在 {new Date(deletion.scheduledFor).toLocaleDateString("zh-CN")} 后完成清理。</p>
          <button className="auth-secondary" disabled={busy} onClick={onCancelDeletion} type="button">撤销删除申请</button>
        </section>
      )}
      <button className="auth-secondary" disabled={busy} onClick={onRevokeSession} type="button">撤销当前会话</button>
      <button className="auth-secondary" disabled={busy} onClick={onSignOut} type="button">退出登录</button>
    </main>
  );
}
