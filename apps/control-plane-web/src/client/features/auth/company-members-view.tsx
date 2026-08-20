import { useEffect, useState, type FormEvent } from "react";

import type { CompanyMemberView } from "@core-agent/contracts";

import type { AuthApi } from "./auth-api.js";
import { authErrorCopy } from "./auth-copy.js";

export interface CompanyMembersViewProps {
  readonly api: AuthApi;
  readonly busy: boolean;
  readonly onBack: () => void;
  readonly onProtectedAction: (action: () => Promise<void>) => void;
  readonly tenantId: string;
}

export function CompanyMembersView({ api, busy, onBack, onProtectedAction, tenantId }: CompanyMembersViewProps) {
  const [members, setMembers] = useState<readonly CompanyMemberView[]>([]);
  const [error, setError] = useState<string>();
  const draftKey = `core-agent.identity.company-invite-draft.v1:${tenantId}`;
  const [email, setEmail] = useState(() => {
    try {
      const value = sessionStorage.getItem(draftKey) ?? "";
      return value.length <= 320 ? value : "";
    } catch {
      return "";
    }
  });
  const [role, setRole] = useState<"admin" | "consultant">("consultant");
  const refresh = (): void => {
    void api.listCompanyMembers(tenantId).then(setMembers).catch((caught) => setError(authErrorCopy(caught)));
  };
  useEffect(refresh, [api, tenantId]);
  useEffect(() => {
    try {
      if (email === "") sessionStorage.removeItem(draftKey);
      else if (email.length <= 320) sessionStorage.setItem(draftKey, email);
    } catch { /* non-authoritative navigation draft only */ }
  }, [draftKey, email]);
  const invite = (event: FormEvent): void => {
    event.preventDefault();
    onProtectedAction(async () => {
      await api.inviteCompanyMember({ tenantId, email, role });
      setEmail("");
      refresh();
    });
  };
  const mutate = (member: CompanyMemberView, kind: "suspend" | "revoke"): void => {
    onProtectedAction(async () => {
      const input = { membershipId: member.membership_id, expectedResourceVersion: member.membership_resource_version };
      if (kind === "suspend") await api.suspendCompanyMember(input);
      else await api.revokeCompanyMember(input);
      refresh();
    });
  };
  return (
    <main className="management-card management-card--wide" aria-labelledby="members-title">
      <button className="auth-link auth-link--back" onClick={onBack} type="button">返回</button>
      <p className="auth-eyebrow">公司管理</p>
      <h1 id="members-title">公司成员</h1>
      <p className="auth-lead">平台管理成员由系统维护，公司管理员无法编辑。</p>
      {error === undefined ? null : <p className="auth-message auth-message--error" role="alert">{error}</p>}
      <form className="member-invite" onSubmit={invite}>
        <label>成员邮箱<input inputMode="email" required type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
        <label>角色<select value={role} onChange={(event) => setRole(event.target.value as "admin" | "consultant")}><option value="consultant">顾问</option><option value="admin">管理员</option></select></label>
        <button className="auth-primary" disabled={busy} type="submit">发送邀请</button>
      </form>
      <ul className="member-list" aria-label="公司成员列表">
        {members.map((member) => (
          <li data-testid={`member-${member.membership_id}`} key={member.membership_id}>
            <div><strong>{member.source === "platform" ? "平台管理成员" : "公司成员"}</strong><span>{member.roles.join(" · ")} · {member.status}</span></div>
            {member.source === "platform" || member.status === "revoked" ? null : (
              <div className="member-actions">
                {member.status === "active" ? <button className="auth-secondary" disabled={busy} onClick={() => mutate(member, "suspend")} type="button">暂停成员</button> : null}
                <button className="auth-danger auth-danger--compact" disabled={busy} onClick={() => mutate(member, "revoke")} type="button">撤销成员</button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </main>
  );
}
