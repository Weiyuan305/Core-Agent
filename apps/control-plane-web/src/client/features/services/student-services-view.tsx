import { ServiceStatus } from "./service-status.js";
import type { StudentServiceView } from "./services-api.js";

export function StudentServicesView({ services }: { readonly services: readonly StudentServiceView[] }) {
  const available = services.some(({ state }) => state === "available");
  return (
    <section aria-labelledby="student-services-title" className="service-workspace service-workspace--student">
      <div className="service-hero">
        <p className="auth-eyebrow">Core Agent</p>
        <h1 id="student-services-title">我的服务</h1>
        <p>查看已经由平台确认的服务及准备状态。</p>
      </div>
      {services.length === 0 ? <p className="service-empty-inline">当前没有已开通的服务。</p> : (
        <div className="service-grid">
          {services.map((service) => (
            <article className="service-card" key={service.serviceId}>
              <h2>{service.displayName}</h2>
              <ServiceStatus state={service.state} />
            </article>
          ))}
        </div>
      )}
      <div className="conversation-admission">
        <button className="auth-primary" disabled type="button">{available ? "对话入口待启用" : "开始对话"}</button>
        <p>{available ? "服务已准备完成；安全对话入口将在独立网关验收后开放。" : "服务可用后，对话入口会在这里开放。"}</p>
      </div>
    </section>
  );
}
