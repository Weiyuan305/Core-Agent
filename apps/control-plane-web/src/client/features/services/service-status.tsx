import type { PublicServiceState } from "./services-api.js";

const STATUS_COPY: Readonly<Record<PublicServiceState, string>> = Object.freeze({
  preparing: "服务正在准备，完成后即可开始对话。",
  available: "服务已经可以使用。",
  suspended: "服务已暂停，请联系支持确认账户状态。",
  expired: "服务已到期，请联系支持确认续期状态。",
  unavailable: "服务准备未完成，我们正在处理。",
});

export interface ServiceStatusProps {
  readonly state: PublicServiceState;
  readonly compact?: boolean;
}

export function serviceStatusCopy(state: PublicServiceState): string {
  return STATUS_COPY[state];
}

export function ServiceStatus({ state, compact = false }: ServiceStatusProps) {
  return (
    <p aria-live={state === "preparing" ? "polite" : undefined} className={`service-status service-status--${state}${compact ? " service-status--compact" : ""}`}>
      <span aria-hidden="true" className="service-status__dot" />
      {STATUS_COPY[state]}
    </p>
  );
}
