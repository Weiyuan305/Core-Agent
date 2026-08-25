import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import type { AuthSessionView } from "@core-agent/contracts";

import { AccountView } from "./account-view.js";
import {
  AuthClientError,
  createAuthApi,
  type AccountDeletionView,
  type AuthApi,
  type InvitationView as InvitationFacts,
} from "./auth-api.js";
import { authErrorCopy } from "./auth-copy.js";
import { CompanyMembersView } from "./company-members-view.js";
import { InvitationView } from "./invitation-view.js";
import { SignInView } from "./sign-in-view.js";
import { SignUpView } from "./sign-up-view.js";
import { createServicesApi, type ServicesApi } from "../services/services-api.js";
import { ServicesWorkspace } from "../services/services-workspace.js";

export type AppAdmission =
  | { readonly kind: "loading" }
  | { readonly kind: "anonymous" }
  | { readonly kind: "verification_pending" }
  | { readonly kind: "authenticated"; readonly session: AuthSessionView }
  | { readonly kind: "temporarily_unavailable" };

type Screen =
  | { readonly kind: "loading" }
  | { readonly kind: "sign_in" }
  | { readonly kind: "sign_up" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "invitation_loading" }
  | { readonly kind: "invitation_invalid" }
  | { readonly kind: "invitation"; readonly invitation: InvitationFacts }
  | { readonly kind: "verification"; readonly verificationId: string; readonly tenantId?: string }
  | { readonly kind: "home"; readonly session: AuthSessionView }
  | { readonly kind: "account"; readonly session: AuthSessionView }
  | { readonly kind: "company"; readonly session: AuthSessionView; readonly tenantId: string };

const TENANT_HINT_KEY = "core-agent.identity.tenant-hint.v1";

export interface AuthShellProps {
  readonly api?: AuthApi;
  readonly initialTenantId?: string;
  readonly invitationSecret?: string;
  readonly navigate?: (url: string) => void;
  readonly serviceApi?: ServicesApi;
}

function storedTenantHint(): string | undefined {
  try {
    const value = sessionStorage.getItem(TENANT_HINT_KEY);
    return value !== null && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function storeTenantHint(value: string): void {
  try { sessionStorage.setItem(TENANT_HINT_KEY, value); } catch { /* navigation hint only */ }
}

function ReauthenticationDialog(props: {
  readonly busy: boolean;
  readonly error?: string | undefined;
  readonly onCancel: () => void;
  readonly onSubmit: (password: string) => void;
}) {
  const [password, setPassword] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    props.onSubmit(password);
  };
  return (
    <div className="auth-dialog-backdrop">
      <div aria-labelledby="reauth-title" aria-modal="true" className="auth-dialog" role="dialog">
        <p className="auth-eyebrow">安全确认</p>
        <h2 id="reauth-title">确认当前密码</h2>
        <p>管理成员或删除账户前，需要在十分钟内重新验证。</p>
        {props.error === undefined ? null : <p className="auth-message auth-message--error" role="alert">{props.error}</p>}
        <form className="auth-form" onSubmit={submit}>
          <label>当前密码<input autoComplete="current-password" minLength={8} ref={inputRef} required type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
          <div className="auth-dialog__actions">
            <button className="auth-secondary" disabled={props.busy} onClick={props.onCancel} type="button">取消</button>
            <button className="auth-primary" disabled={props.busy} type="submit">继续</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function VerificationView(props: {
  readonly busy: boolean;
  readonly error?: string | undefined;
  readonly onBack: () => void;
  readonly onVerify: (code: string) => void;
}) {
  const [code, setCode] = useState("");
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!props.busy) props.onVerify(code);
  };
  return (
    <main className="auth-card" aria-labelledby="verification-title">
      <div className="auth-brand" aria-hidden="true">CA</div>
      <p className="auth-eyebrow">还差一步</p>
      <h1 id="verification-title">验证邮箱</h1>
      <p className="auth-lead">输入邮件中的一次性验证码。我们不会在页面中显示账户是否已经存在。</p>
      {props.error === undefined ? null : <p className="auth-message auth-message--error" role="alert">{props.error}</p>}
      <form className="auth-form" onSubmit={submit}>
        <label>验证码<input autoComplete="one-time-code" minLength={8} required value={code} onChange={(event) => setCode(event.target.value)} /></label>
        <button className="auth-primary" disabled={props.busy} type="submit">{props.busy ? "正在验证…" : "完成验证"}</button>
      </form>
      <button className="auth-link" disabled={props.busy} onClick={props.onBack} type="button">返回登录</button>
    </main>
  );
}

function AuthenticatedHome(props: {
  readonly authApi: AuthApi;
  readonly onAccount: () => void;
  readonly onCompany?: (() => void) | undefined;
  readonly onReauthenticationRequired: (action: () => Promise<void>) => void;
  readonly onSessionExpired: () => void;
  readonly onSignOut: () => void;
  readonly serviceApi: ServicesApi;
  readonly tenantId?: string | undefined;
}) {
  return (
    <main className="authenticated-shell">
      <header className="authenticated-header">
        <a aria-label="Core Agent 首页" className="auth-brand auth-brand--small" href="/">CA</a>
        <nav aria-label="账户导航">
          {props.onCompany === undefined ? null : <button className="auth-link" onClick={props.onCompany} type="button">公司成员</button>}
          <button className="auth-link" onClick={props.onAccount} type="button">账户与安全</button>
          <button className="auth-link" onClick={props.onSignOut} type="button">退出登录</button>
        </nav>
      </header>
      <ServicesWorkspace api={props.serviceApi} loadCompanyMembers={props.authApi.listCompanyMembers} onReauthenticationRequired={props.onReauthenticationRequired} onSessionExpired={props.onSessionExpired} {...(props.tenantId === undefined ? {} : { tenantId: props.tenantId })} />
    </main>
  );
}

export function AuthShell({
  api: providedApi,
  initialTenantId,
  invitationSecret,
  navigate = (url) => { window.location.assign(url); },
  serviceApi: providedServiceApi,
}: AuthShellProps) {
  const api = useMemo(() => providedApi ?? createAuthApi(), [providedApi]);
  const serviceApi = useMemo(() => providedServiceApi ?? createServicesApi(), [providedServiceApi]);
  const [screen, setScreen] = useState<Screen>({ kind: "loading" });
  const [session, setSession] = useState<AuthSessionView>();
  const [tenantId, setTenantId] = useState(initialTenantId ?? storedTenantHint());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [deletion, setDeletion] = useState<AccountDeletionView>();
  const [reauthAction, setReauthAction] = useState<((current: AuthSessionView) => Promise<void>)>();
  const [reauthError, setReauthError] = useState<string>();

  useEffect(() => {
    let active = true;
    if (invitationSecret !== undefined) {
      setScreen({ kind: "invitation_loading" });
      void Promise.allSettled([api.inspectSession(), api.inspectInvitation(invitationSecret)]).then(([sessionResult, invitationResult]) => {
        if (!active) return;
        if (sessionResult.status === "fulfilled") setSession(sessionResult.value);
        else if (!(sessionResult.reason instanceof AuthClientError) || sessionResult.reason.reason !== "anonymous") {
          setScreen({ kind: "unavailable" });
          return;
        }
        setScreen(invitationResult.status === "fulfilled" && invitationResult.value.status === "pending"
          ? { kind: "invitation", invitation: invitationResult.value }
          : { kind: "invitation_invalid" });
      });
    } else {
      void api.inspectSession().then((current) => {
        if (!active) return;
        setSession(current);
        setScreen({ kind: "home", session: current });
      }).catch((caught) => {
        if (!active) return;
        setScreen(caught instanceof AuthClientError && caught.reason === "anonymous"
          ? { kind: "sign_in" }
          : { kind: "unavailable" });
      });
    }
    return () => { active = false; };
  }, [api, invitationSecret]);

  const fail = (caught: unknown): void => {
    if (caught instanceof AuthClientError && caught.reason === "anonymous") {
      setSession(undefined);
      setScreen({ kind: "sign_in" });
    } else if (caught instanceof AuthClientError && caught.reason === "reauthentication_required") {
      setReauthError(authErrorCopy(caught));
    } else {
      setError(authErrorCopy(caught));
    }
  };

  const perform = async (action: () => Promise<void>): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try { await action(); } catch (caught) { fail(caught); } finally { setBusy(false); }
  };

  const protectedAction = (action: (current: AuthSessionView) => Promise<void>): void => {
    if (session === undefined) return;
    if (session.reauthentication_required) {
      setReauthAction(() => action);
      setReauthError(undefined);
      return;
    }
    setBusy(true);
    setError(undefined);
    void action(session).catch((caught) => {
      if (caught instanceof AuthClientError && caught.reason === "reauthentication_required") {
        setReauthAction(() => action);
        setReauthError(undefined);
      } else {
        fail(caught);
      }
    }).finally(() => setBusy(false));
  };

  const onReauthenticate = (password: string): void => {
    if (session === undefined || reauthAction === undefined) return;
    setBusy(true);
    setReauthError(undefined);
    void api.reauthenticate({ password, sessionResourceVersion: session.session_resource_version }).then(async (current) => {
      setSession(current);
      const action = reauthAction;
      setReauthAction(undefined);
      await action(current);
    }).catch((caught) => setReauthError(authErrorCopy(caught))).finally(() => setBusy(false));
  };

  const authenticated = (current: AuthSessionView): void => {
    setSession(current);
    setError(undefined);
    setScreen({ kind: "home", session: current });
  };

  const requestServiceReauthentication = useCallback((action: () => Promise<void>): void => {
    setReauthAction(() => async () => action());
    setReauthError(undefined);
  }, []);

  const expireServiceSession = useCallback((): void => {
    setSession(undefined);
    setScreen({ kind: "sign_in" });
  }, []);

  let content;
  if (screen.kind === "loading" || screen.kind === "invitation_loading") {
    content = <div aria-live="polite" className="launch-state"><span className="launch-state__mark">CA</span><p>正在建立安全连接…</p></div>;
  } else if (screen.kind === "unavailable") {
    content = <main className="auth-card" role="alert"><div className="auth-brand" aria-hidden="true">CA</div><h1>暂时无法连接</h1><p className="auth-lead">登录服务暂时不可用，请稍后再试。</p></main>;
  } else if (screen.kind === "invitation_invalid") {
    content = <main className="auth-card"><div className="auth-brand" aria-hidden="true">CA</div><h1>邀请暂时不可用</h1><p className="auth-message" role="alert">这个邀请暂时无法使用，请向邀请人确认。</p><button className="auth-link" onClick={() => setScreen({ kind: "sign_in" })} type="button">返回登录</button></main>;
  } else if (screen.kind === "invitation") {
    content = <InvitationView authenticated={session !== undefined} busy={busy} error={error} invitation={screen.invitation} onAccept={() => {
      if (invitationSecret === undefined) return;
      void perform(async () => {
        const accepted = await api.acceptInvitation({ invitationSecret, expectedResourceVersion: screen.invitation.resource_version });
        setTenantId(accepted.tenantId);
        storeTenantHint(accepted.tenantId);
        authenticated(accepted.session);
      });
    }} onBack={() => setScreen({ kind: "sign_in" })} onRegister={(input) => {
      if (invitationSecret === undefined) return;
      void perform(async () => {
        const pending = await api.registerInvitation({ invitationSecret, ...input });
        setScreen({ kind: "verification", verificationId: pending.verificationId, tenantId: screen.invitation.tenant_id });
      });
    }} />;
  } else if (screen.kind === "sign_up") {
    content = <SignUpView busy={busy} error={error} onBack={() => setScreen({ kind: "sign_in" })} onSubmit={(input) => {
      void perform(async () => {
        const pending = await api.signUp(input);
        setScreen({ kind: "verification", verificationId: pending.verificationId });
      });
    }} />;
  } else if (screen.kind === "verification") {
    content = <VerificationView busy={busy} error={error} onBack={() => setScreen({ kind: "sign_in" })} onVerify={(verificationCode) => {
      void perform(async () => {
        const current = await api.verifyEmail({ verificationId: screen.verificationId, verificationCode });
        if (screen.tenantId !== undefined) {
          setTenantId(screen.tenantId);
          storeTenantHint(screen.tenantId);
        }
        authenticated(current);
      });
    }} />;
  } else if (screen.kind === "sign_in") {
    content = <SignInView busy={busy} error={error} onApple={() => {
      void perform(async () => navigate(await api.startAppleSignIn()));
    }} onCreateAccount={() => { setError(undefined); setScreen({ kind: "sign_up" }); }} onSignIn={(input) => {
      void perform(async () => authenticated(await api.signIn(input)));
    }} />;
  } else if (screen.kind === "account") {
    content = <AccountView busy={busy} deletion={deletion} error={error} onBack={() => setScreen({ kind: "home", session: screen.session })} onCancelDeletion={() => {
      if (deletion === undefined) return;
      protectedAction(async () => {
        await api.cancelAccountDeletion({ accountDeletionId: deletion.accountDeletionId, expectedResourceVersion: deletion.resourceVersion });
        setDeletion(undefined);
      });
    }} onDelete={() => protectedAction(async (current) => {
      setDeletion(await api.requestAccountDeletion(current.session_resource_version));
    })} onRevokeSession={() => protectedAction(async (current) => {
      await api.revokeCurrentSession({ sessionId: current.session_id, expectedResourceVersion: current.session_resource_version });
      setSession(undefined);
      setScreen({ kind: "sign_in" });
    })} onSignOut={() => { void perform(async () => { await api.signOut(); setSession(undefined); setScreen({ kind: "sign_in" }); }); }} session={screen.session} />;
  } else if (screen.kind === "company") {
    content = <CompanyMembersView api={api} busy={busy} onBack={() => setScreen({ kind: "home", session: screen.session })} onProtectedAction={(action) => protectedAction(async () => action())} tenantId={screen.tenantId} />;
  } else {
    content = <AuthenticatedHome authApi={api} onAccount={() => setScreen({ kind: "account", session: screen.session })} onCompany={tenantId === undefined ? undefined : () => setScreen({ kind: "company", session: screen.session, tenantId })} onReauthenticationRequired={requestServiceReauthentication} onSessionExpired={expireServiceSession} onSignOut={() => { void perform(async () => { await api.signOut(); setSession(undefined); setScreen({ kind: "sign_in" }); }); }} serviceApi={serviceApi} {...(tenantId === undefined ? {} : { tenantId })} />;
  }

  return (
    <div className="auth-page">
      {content}
      {reauthAction === undefined ? null : <ReauthenticationDialog busy={busy} error={reauthError} onCancel={() => setReauthAction(undefined)} onSubmit={onReauthenticate} />}
    </div>
  );
}
