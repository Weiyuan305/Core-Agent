import { ServiceStatus } from "./service-status.js";
import type { CompanyServiceView } from "./services-api.js";

export function CompanyServicesView({ services }: { readonly services: readonly CompanyServiceView[] }) {
  return (
    <section aria-labelledby="company-services-title" className="service-panel">
      <div className="service-section-heading">
        <div><p className="auth-eyebrow">公司服务</p><h2 id="company-services-title">席位概览</h2></div>
        <p>名额按服务包独立计算，分配完成前不会开放相应能力。</p>
      </div>
      {services.length === 0 ? <p className="service-empty-inline">公司当前没有可分配的服务。</p> : (
        <div className="service-grid">
          {services.map((service) => (
            <article className="service-card" key={service.serviceId}>
              <h3>{service.displayName}</h3>
              <div className="seat-meter" aria-label={`${service.displayName} 名额`}>
                <span>已使用 {service.usedSeats} / {service.totalSeats}</span>
                <strong>可分配 {service.availableSeats}</strong>
              </div>
              <ServiceStatus compact state={service.state} />
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
