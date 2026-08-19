import { useState, type FormEvent } from "react";

export interface SignUpViewProps {
  readonly busy: boolean;
  readonly error?: string | undefined;
  readonly onBack: () => void;
  readonly onSubmit: (input: { readonly email: string; readonly password: string }) => void;
}

export function SignUpView({ busy, error, onBack, onSubmit }: SignUpViewProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [localError, setLocalError] = useState<string>();
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (password !== confirmation) {
      setLocalError("两次输入的密码不一致。");
      return;
    }
    setLocalError(undefined);
    if (!busy) onSubmit({ email, password });
  };
  return (
    <main className="auth-card" aria-labelledby="sign-up-title">
      <div className="auth-brand" aria-hidden="true">CA</div>
      <p className="auth-eyebrow">创建个人学习空间</p>
      <h1 id="sign-up-title">创建 Core Agent 账户</h1>
      <p className="auth-lead">注册不会自动购买服务或创建 Runtime。</p>
      {(localError ?? error) === undefined ? null : <p className="auth-message auth-message--error" role="alert">{localError ?? error}</p>}
      <form className="auth-form" onSubmit={submit}>
        <label>邮箱<input autoComplete="email" inputMode="email" required type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
        <label>密码<input autoComplete="new-password" minLength={8} required type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        <label>确认密码<input autoComplete="new-password" minLength={8} required type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>
        <button className="auth-primary" disabled={busy} type="submit">{busy ? "正在提交…" : "继续注册"}</button>
      </form>
      <button className="auth-link" disabled={busy} onClick={onBack} type="button">返回登录</button>
    </main>
  );
}
