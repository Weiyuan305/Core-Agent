import { useState, type FormEvent } from "react";

export interface SignInViewProps {
  readonly busy: boolean;
  readonly error?: string | undefined;
  readonly onApple: () => void;
  readonly onCreateAccount: () => void;
  readonly onSignIn: (input: { readonly email: string; readonly password: string }) => void;
}

export function SignInView({ busy, error, onApple, onCreateAccount, onSignIn }: SignInViewProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!busy) onSignIn({ email, password });
  };
  return (
    <main className="auth-card" aria-labelledby="sign-in-title">
      <div className="auth-brand" aria-hidden="true">CA</div>
      <p className="auth-eyebrow">安全地继续你的工作</p>
      <h1 id="sign-in-title">登录 Core Agent</h1>
      <p className="auth-lead">使用已验证的邮箱，或通过 Apple 继续。</p>
      {error === undefined ? null : <p className="auth-message auth-message--error" role="alert">{error}</p>}
      <form className="auth-form" onSubmit={submit}>
        <label>邮箱<input autoComplete="email" inputMode="email" name="email" required type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
        <label>密码<input autoComplete="current-password" minLength={8} name="password" required type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        <button className="auth-primary" disabled={busy} type="submit">{busy ? "正在登录…" : "登录"}</button>
      </form>
      <div className="auth-divider"><span>或</span></div>
      <button className="auth-apple" disabled={busy} onClick={onApple} type="button"><span aria-hidden="true">●</span> 使用 Apple 登录</button>
      <button className="auth-link" disabled={busy} onClick={onCreateAccount} type="button">创建账户</button>
    </main>
  );
}
