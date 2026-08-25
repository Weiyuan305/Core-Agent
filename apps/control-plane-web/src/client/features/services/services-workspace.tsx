import { useCallback, useEffect, useRef, useState } from "react";

import type { CompanyMemberView } from "@core-agent/contracts";

import { CompanySeatView, type EligibleProfile } from "./company-seat-view.js";
import { CompanyServicesView } from "./company-services-view.js";
import { PlatformCatalogView } from "./platform-catalog-view.js";
import { PlatformGrantsView } from "./platform-grants-view.js";
import {
  ServiceClientError,
  type ServiceMutation,
  type ServicesApi,
  type ServiceWorkspace,
} from "./services-api.js";
import { StudentServicesView } from "./student-services-view.js";

const POLL_DELAYS_MS = Object.freeze([5_000, 10_000, 20_000, 30_000]);

function hasPreparing(workspace: ServiceWorkspace): boolean {
  if (workspace.kind === "company") return [...workspace.services, ...workspace.assignments].some(({ state }) => state === "preparing");
  if (workspace.kind === "student") return workspace.services.some(({ state }) => state === "preparing");
  return false;
}

function calmError(error: unknown): string {
  if (!(error instanceof ServiceClientError)) return "服务状态暂时无法读取，请稍后再试。";
  if (error.reason === "seat_exhausted") return "可分配名额已用完。";
  if (error.reason === "capability_conflict") return "当前服务组合暂时无法启用，请联系支持。";
  if (error.reason === "conflict") return "服务状态已更新，请刷新后重试。";
  if (error.reason === "rate_limited") return "操作有些频繁，请稍后再试。";
  if (error.reason === "forbidden") return "当前账户无法管理这项服务。";
  if (error.reason === "invalid") return "请检查填写的信息后重试。";
  return "服务状态暂时无法读取，请稍后再试。";
}

function eligibleProfiles(members: readonly CompanyMemberView[]): readonly EligibleProfile[] {
  return Object.freeze(members.flatMap((member) => {
    const roles: readonly string[] = member.roles;
    return member.source === "company" && member.status === "active" && roles.includes("consultant")
      && "profile_id" in member && "profile_status" in member && member.profile_status === "active"
      ? [{ profileId: member.profile_id, displayName: `顾问 ${member.actor_id}` }]
      : [];
  }));
}

export interface ServicesWorkspaceProps {
  readonly api: ServicesApi;
  readonly loadCompanyMembers: (tenantId: string) => Promise<readonly CompanyMemberView[]>;
  readonly onReauthenticationRequired: (action: () => Promise<void>) => void;
  readonly onSessionExpired: () => void;
  readonly tenantId?: string;
}

export function ServicesWorkspace({ api, loadCompanyMembers, onReauthenticationRequired, onSessionExpired, tenantId }: ServicesWorkspaceProps) {
  const [workspace, setWorkspace] = useState<ServiceWorkspace>();
  const [profiles, setProfiles] = useState<readonly EligibleProfile[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const pollIndex = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const next = await api.loadWorkspace(tenantId);
    setWorkspace(next);
    setError(undefined);
    if (next.kind === "company") setProfiles(eligibleProfiles(await loadCompanyMembers(next.tenantId)));
    else setProfiles([]);
  }, [api, loadCompanyMembers, tenantId]);

  useEffect(() => {
    let active = true;
    void load().catch((caught) => {
      if (!active) return;
      if (caught instanceof ServiceClientError && caught.reason === "anonymous") onSessionExpired();
      else if (caught instanceof ServiceClientError && caught.reason === "reauthentication_required") onReauthenticationRequired(load);
      else {
        setWorkspace({ kind: "none" });
        setError(calmError(caught));
      }
    });
    return () => { active = false; };
  }, [load, onReauthenticationRequired, onSessionExpired]);

  useEffect(() => {
    if (workspace === undefined || !hasPreparing(workspace)) {
      pollIndex.current = 0;
      return;
    }
    const delay = POLL_DELAYS_MS[Math.min(pollIndex.current, POLL_DELAYS_MS.length - 1)]!;
    const timer = window.setTimeout(() => {
      pollIndex.current += 1;
      void load().catch((caught) => setError(calmError(caught)));
    }, delay);
    return () => window.clearTimeout(timer);
  }, [load, workspace]);

  const mutate = (mutation: ServiceMutation): void => {
    if (busy) return;
    const action = async (): Promise<void> => {
      setBusy(true);
      setError(undefined);
      try {
        await api.mutate(mutation);
        await load();
      } catch (caught) {
        if (caught instanceof ServiceClientError && caught.reason === "anonymous") onSessionExpired();
        else if (caught instanceof ServiceClientError && caught.reason === "reauthentication_required") {
          onReauthenticationRequired(action);
        } else {
          if (caught instanceof ServiceClientError && caught.reason === "seat_exhausted") {
            try { await load(); } catch { /* Preserve the closed seat-exhausted result. */ }
          }
          setError(calmError(caught));
        }
      } finally {
        setBusy(false);
      }
    };
    void action();
  };

  if (workspace === undefined) return <section aria-live="polite" className="service-loading"><span className="service-loading__mark" /><p>正在读取服务状态…</p></section>;
  if (workspace.kind === "none") return (
    <section aria-labelledby="service-title" className="service-empty">
      <span aria-hidden="true">◎</span><p className="auth-eyebrow">Core Agent</p><h1 id="service-title">服务尚未开通</h1>
      <p>你的身份已经安全建立。服务开通后，这里会显示可用的工作空间。</p>
      <p className="service-empty__note">{error ?? "请联系管理员确认服务开通状态。"}</p>
    </section>
  );
  if (workspace.kind === "student") return <StudentServicesView services={workspace.services} />;
  if (workspace.kind === "company") return (
    <div className="service-workspace">
      <div className="service-hero"><p className="auth-eyebrow">公司管理</p><h1>服务与名额</h1><p>查看服务准备状态，并把已购买的名额分配给顾问。</p></div>
      {error === undefined ? null : <p className="auth-message auth-message--error" role="alert">{error}</p>}
      <CompanyServicesView services={workspace.services} />
      <CompanySeatView assignments={workspace.assignments} busy={busy} eligibleProfiles={profiles} onMutate={mutate} services={workspace.services} tenantId={workspace.tenantId} />
    </div>
  );
  return (
    <div className="service-workspace">
      <div className="service-hero"><p className="auth-eyebrow">平台内部</p><h1>平台服务管理</h1><p>管理经过审核的能力版本、服务包和客户授权。</p></div>
      {error === undefined ? null : <p className="auth-message auth-message--error" role="alert">{error}</p>}
      <PlatformCatalogView busy={busy} capabilities={workspace.catalog.capabilities} onMutate={mutate} packs={workspace.catalog.packs} />
      <PlatformGrantsView busy={busy} entitlements={workspace.entitlements} onMutate={mutate} packs={workspace.catalog.packs} />
    </div>
  );
}
