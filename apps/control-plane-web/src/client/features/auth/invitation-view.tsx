import { useState, type FormEvent } from "react";

import type { InvitationView } from "./auth-api.js";

export interface InvitationViewProps {
  readonly authenticated: boolean;
  readonly busy: boolean;
  readonly error?: string | undefined;
  readonly invitation: InvitationView;
  readonly onAccept: () => void;
  readonly onBack: () => void;
  readonly onRegister: (input: { readonly email: string; readonly password: string }) => void;
}

export function InvitationView({ authenticated, busy, error, invitation, onAccept, onBack, onRegister }: InvitationViewProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!busy) onRegister({ email, password });
  };
  const role = invitation.role === "admin" ? "公司管理员" : "顾问";
  return (
    <main className="auth-card" aria-labelledby="invitation-title">
      <div className="auth-brand" aria-hidden="true">CA</div>
      <p className="auth-eyebrow">公司邀请</p>
      <h1 id="invitation-title">加入公司工作空间</h1>
      <p className="auth-lead">你将以“{role}”身份加入。邀请会在使用后立即失效。</p>
      {error === undefined ? null : <p className="auth-message auth-message--error" role="alert">{error}</p>}
      {authenticated ? (
        <button className="auth-primary" disabled={busy} onClick={onAccept} type="button">{busy ? "正在加入…" : "接受邀请"}</button>
      ) : (
        <form className="auth-form" onSubmit={submit}>
          <label>邮箱<input autoComplete="email" inputMode="email" required type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
          <label>密码<input autoComplete="new-password" minLength={8} required type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
          <button className="auth-primary" disabled={busy} type="submit">{busy ? "正在提交…" : "验证邮箱并加入"}</button>
        </form>
      )}
      <button className="auth-link" disabled={busy} onClick={onBack} type="button">返回登录</button>
    </main>
  );
}
