import type { FormEvent } from "react";

import type { PlatformCapabilityView, PlatformPackView, ServiceMutation } from "./services-api.js";

export interface PlatformCatalogViewProps {
  readonly busy: boolean;
  readonly capabilities: readonly PlatformCapabilityView[];
  readonly onMutate: (mutation: ServiceMutation) => void;
  readonly packs: readonly PlatformPackView[];
}

export function PlatformCatalogView({ busy, capabilities, onMutate, packs }: PlatformCatalogViewProps) {
  const reviewedCapabilities = capabilities.filter((capability) => capability.status === "reviewed" && capability.capabilityVersionId !== undefined);

  const createCapability = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    onMutate({
      kind: "capability_create",
      capabilityId: String(values.get("capability_id")),
      capabilityVersionId: String(values.get("capability_version_id")),
      displayName: String(values.get("display_name")),
      owningDomain: String(values.get("owning_domain")),
      capabilityKind: "mcp",
      version: String(values.get("version")),
      artifactRef: String(values.get("artifact_ref")),
      contractRef: String(values.get("contract_ref")),
      riskClass: "read",
      approvalRequirement: "none",
      coreContractVersion: "0.8.0",
      domainContractVersion: "1.0.0",
      runtimeProtocolVersion: "1.0.0",
      tenantModes: ["b2b", "b2c"],
    });
  };

  const createPack = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const selectedVersionId = String(values.get("capability_version_id"));
    const selected = reviewedCapabilities.find((capability) => capability.capabilityVersionId === selectedVersionId);
    if (selected?.capabilityVersionId === undefined) return;
    onMutate({
      kind: "pack_create",
      packProductId: String(values.get("pack_product_id")),
      packVersionId: String(values.get("pack_version_id")),
      displayName: String(values.get("pack_display_name")),
      tenantModes: ["b2c"],
      version: String(values.get("pack_version")),
      members: [{ capabilityId: selected.capabilityId, capabilityVersionId: selected.capabilityVersionId, version: selected.version }],
    });
  };

  return (
    <section aria-labelledby="catalog-title" className="service-panel">
      <div className="service-section-heading">
        <div><p className="auth-eyebrow">内部管理</p><h2 id="catalog-title">能力与服务包</h2></div>
        <p>只有经过审核的精确版本才能进入服务发布流程。</p>
      </div>
      <div className="service-grid">
        {capabilities.map((capability) => (
          <article className="service-card" data-testid={`capability-${capability.capabilityVersionId ?? capability.capabilityId}`} key={capability.capabilityVersionId ?? capability.capabilityId}>
            <div className="service-card__heading"><h3>{capability.displayName}</h3><span className="service-chip">{capability.kind.toUpperCase()}</span></div>
            <p className="service-card__meta">能力版本 · {capability.status === "draft" ? "草稿" : capability.status === "reviewed" ? "已审核" : capability.status === "blocked" ? "已阻止" : "已停用"}</p>
            {capability.status === "draft" && capability.capabilityVersionId !== undefined && capability.resourceVersion !== undefined ? (
              <button className="auth-secondary" disabled={busy} onClick={() => onMutate({ kind: "capability_review", capabilityVersionId: capability.capabilityVersionId!, expectedResourceVersion: capability.resourceVersion! })} type="button">审核能力版本</button>
            ) : null}
            {capability.status === "reviewed" && capability.capabilityVersionId !== undefined && capability.resourceVersion !== undefined ? (
              <button className="auth-danger auth-danger--compact" disabled={busy} onClick={() => onMutate({ kind: "capability_block", capabilityVersionId: capability.capabilityVersionId!, expectedResourceVersion: capability.resourceVersion! })} type="button">阻止能力版本</button>
            ) : null}
          </article>
        ))}
        {packs.map((pack) => (
          <article className="service-card" data-testid={`pack-${pack.packVersionId ?? pack.packProductId}`} key={pack.packVersionId ?? pack.packProductId}>
            <div className="service-card__heading"><h3>{pack.displayName}</h3><span className="service-chip">{pack.tenantModes.join(" + ").toUpperCase()}</span></div>
            <p className="service-card__meta">服务包 · {pack.status === "draft" ? "草稿" : pack.status === "reviewed" ? "已审核" : pack.status === "published" ? "已发布" : pack.status === "blocked" ? "已阻止" : "已停用"}</p>
            {pack.status === "draft" && pack.packVersionId !== undefined && pack.resourceVersion !== undefined ? (
              <button className="auth-secondary" disabled={busy} onClick={() => onMutate({ kind: "pack_review", packVersionId: pack.packVersionId!, expectedResourceVersion: pack.resourceVersion! })} type="button">审核服务包</button>
            ) : null}
            {pack.status === "reviewed" && pack.packVersionId !== undefined && pack.resourceVersion !== undefined ? (
              <button className="auth-primary" disabled={busy} onClick={() => onMutate({ kind: "pack_publish", packVersionId: pack.packVersionId!, expectedResourceVersion: pack.resourceVersion! })} type="button">发布服务包</button>
            ) : null}
          </article>
        ))}
      </div>
      <div className="service-admin-forms">
        <details>
          <summary>创建能力草稿</summary>
          <form className="service-form-grid" onSubmit={createCapability}>
            <label>能力标识<input autoComplete="off" disabled={busy} name="capability_id" required /></label>
            <label>能力版本标识<input autoComplete="off" disabled={busy} name="capability_version_id" required /></label>
            <label>能力名称<input autoComplete="off" disabled={busy} maxLength={200} name="display_name" required /></label>
            <label>归属域<input autoComplete="off" disabled={busy} name="owning_domain" required /></label>
            <label>语义版本<input autoComplete="off" disabled={busy} name="version" placeholder="1.0.0" required /></label>
            <label>不可变制品坐标<input autoComplete="off" disabled={busy} name="artifact_ref" required /></label>
            <label>精确契约坐标<input autoComplete="off" disabled={busy} name="contract_ref" required /></label>
            <button className="auth-secondary" disabled={busy} type="submit">保存能力草稿</button>
          </form>
        </details>
        <details>
          <summary>创建服务包草稿</summary>
          <form className="service-form-grid" onSubmit={createPack}>
            <label>服务包标识<input autoComplete="off" disabled={busy} name="pack_product_id" required /></label>
            <label>服务包版本标识<input autoComplete="off" disabled={busy} name="pack_version_id" required /></label>
            <label>服务包名称<input autoComplete="off" disabled={busy} maxLength={200} name="pack_display_name" required /></label>
            <label>服务包语义版本<input autoComplete="off" disabled={busy} name="pack_version" placeholder="1.0.0" required /></label>
            <label>已审核能力版本<select disabled={busy || reviewedCapabilities.length === 0} name="capability_version_id" required>
              <option value="">请选择</option>
              {reviewedCapabilities.map((capability) => <option key={capability.capabilityVersionId} value={capability.capabilityVersionId}>{capability.displayName} · {capability.version}</option>)}
            </select></label>
            <button className="auth-secondary" disabled={busy || reviewedCapabilities.length === 0} type="submit">保存服务包草稿</button>
          </form>
        </details>
      </div>
    </section>
  );
}
