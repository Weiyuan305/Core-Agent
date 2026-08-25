import { useMemo, useState, type FormEvent } from "react";

import { ServiceStatus } from "./service-status.js";
import type { CompanyAssignmentView, CompanyServiceView, ServiceMutation } from "./services-api.js";

export interface EligibleProfile {
  readonly profileId: string;
  readonly displayName: string;
}

export interface CompanySeatViewProps {
  readonly assignments: readonly CompanyAssignmentView[];
  readonly busy: boolean;
  readonly eligibleProfiles: readonly EligibleProfile[];
  readonly onMutate: (mutation: ServiceMutation) => void;
  readonly services: readonly CompanyServiceView[];
  readonly tenantId: string;
}

export function CompanySeatView({ assignments, busy, eligibleProfiles, onMutate, services, tenantId }: CompanySeatViewProps) {
  const assignable = useMemo(() => services.filter(({ availableSeats, state }) => availableSeats > 0 && (state === "available" || state === "preparing")), [services]);
  const [serviceId, setServiceId] = useState(assignable[0]?.serviceId ?? "");
  const [profileId, setProfileId] = useState(eligibleProfiles[0]?.profileId ?? "");
  const selected = assignable.find((service) => service.serviceId === serviceId);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (busy || selected === undefined || profileId === "") return;
    onMutate({ kind: "seat_assign", tenantId, entitlementId: selected.serviceId, expectedResourceVersion: selected.resourceVersion, profileId });
  };
  return (
    <section aria-labelledby="seat-title" className="service-panel">
      <div className="service-section-heading">
        <div><p className="auth-eyebrow">人员分配</p><h2 id="seat-title">顾问名额</h2></div>
        <p>只显示当前公司内状态有效的顾问 Profile。</p>
      </div>
      {assignable.length > 0 && eligibleProfiles.length > 0 ? (
        <form className="seat-form" onSubmit={submit}>
          <label>选择服务<select aria-label="选择服务" disabled={busy} onChange={(event) => setServiceId(event.target.value)} value={serviceId}>{assignable.map((service) => <option key={service.serviceId} value={service.serviceId}>{service.displayName}</option>)}</select></label>
          <label>选择顾问<select aria-label="选择顾问" disabled={busy} onChange={(event) => setProfileId(event.target.value)} value={profileId}>{eligibleProfiles.map((profile) => <option key={profile.profileId} value={profile.profileId}>{profile.displayName}</option>)}</select></label>
          <button className="auth-primary" disabled={busy} type="submit">分配名额</button>
        </form>
      ) : <p className="service-empty-inline">当前没有可分配的名额或符合条件的顾问。</p>}
      {assignments.length === 0 ? null : (
        <ul className="service-list service-list--assignments">
          {assignments.map((assignment) => (
            <li key={assignment.assignmentId}>
              <div><strong>{assignment.profileDisplayName}</strong><span>{assignment.serviceDisplayName}</span><ServiceStatus compact state={assignment.state} /></div>
              <button className="auth-danger auth-danger--compact" disabled={busy} onClick={() => onMutate({ kind: "seat_revoke", tenantId, assignmentId: assignment.assignmentId, expectedResourceVersion: assignment.resourceVersion })} type="button">撤销名额</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
