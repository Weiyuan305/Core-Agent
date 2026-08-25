import type { FormEvent } from "react";

import type { PlatformEntitlementView, PlatformPackView, ServiceMutation } from "./services-api.js";

export interface PlatformGrantsViewProps {
  readonly busy: boolean;
  readonly entitlements: readonly PlatformEntitlementView[];
  readonly onMutate: (mutation: ServiceMutation) => void;
  readonly packs: readonly PlatformPackView[];
}

export function PlatformGrantsView({ busy, entitlements, onMutate, packs }: PlatformGrantsViewProps) {
  const publishedPacks = packs.filter((pack) => pack.status === "published" && pack.packVersionId !== undefined);
  const products = [...new Map(publishedPacks.map((pack) => [pack.packProductId, pack])).values()];

  const selectRelease = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const selected = publishedPacks.find((pack) => pack.packVersionId === String(values.get("release_pack_version_id")));
    if (selected?.packVersionId === undefined) return;
    onMutate({
      kind: "tenant_select_release",
      tenantId: String(values.get("release_tenant_id")),
      packProductId: selected.packProductId,
      packVersionId: selected.packVersionId,
      expectedResourceVersion: Number(values.get("release_resource_version")),
    });
  };

  const grant = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const selected = products.find((pack) => pack.packProductId === String(values.get("grant_pack_product_id")));
    if (selected === undefined) return;
    const common = {
      kind: "entitlement_grant" as const,
      tenantId: String(values.get("grant_tenant_id")),
      packProductId: selected.packProductId,
      externalOrderRef: String(values.get("external_order_ref")),
      expectedResourceVersion: Number(values.get("grant_resource_version")),
    };
    onMutate(selected.tenantModes.length === 1 && selected.tenantModes[0] === "b2c"
      ? { ...common, tenantMode: "b2c" }
      : { ...common, tenantMode: "b2b", seatQuantity: Number(values.get("seat_quantity")) });
  };

  return (
    <section aria-labelledby="grants-title" className="service-panel">
      <div className="service-section-heading">
        <div><p className="auth-eyebrow">授权记录</p><h2 id="grants-title">客户服务状态</h2></div>
        <p>授权只由平台管理员记录，不提供价格、支付或结账入口。</p>
      </div>
      {entitlements.length === 0 ? <p className="service-empty-inline">当前没有可见的客户授权。</p> : (
        <ul className="service-list">
          {entitlements.map((entitlement) => (
            <li key={entitlement.entitlementId}>
              <div><strong>{entitlement.displayName}</strong><span>{entitlement.tenantMode.toUpperCase()} · {entitlement.status}</span></div>
              {entitlement.status === "active" ? (
                <button className="auth-secondary" disabled={busy} onClick={() => onMutate({
                  kind: "entitlement_change_status",
                  entitlementId: entitlement.entitlementId,
                  expectedResourceVersion: entitlement.resourceVersion,
                  status: "suspended",
                })} type="button">暂停服务</button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <div className="service-admin-forms">
        <details>
          <summary>切换或回滚服务版本</summary>
          <form className="service-form-grid" onSubmit={selectRelease}>
            <label>客户租户标识<input autoComplete="off" disabled={busy} name="release_tenant_id" required /></label>
            <label>目标服务版本<select disabled={busy || publishedPacks.length === 0} name="release_pack_version_id" required>
              <option value="">请选择</option>
              {publishedPacks.map((pack) => <option key={pack.packVersionId} value={pack.packVersionId}>{pack.displayName} · {pack.version}</option>)}
            </select></label>
            <label>当前资源版本<input defaultValue="1" disabled={busy} min="1" name="release_resource_version" required type="number" /></label>
            <button className="auth-secondary" disabled={busy || publishedPacks.length === 0} type="submit">生成新发布代次</button>
          </form>
        </details>
        <details>
          <summary>记录客户授权</summary>
          <form className="service-form-grid" onSubmit={grant}>
            <label>授权租户标识<input autoComplete="off" disabled={busy} name="grant_tenant_id" required /></label>
            <label>授权服务包<select disabled={busy || products.length === 0} name="grant_pack_product_id" required>
              <option value="">请选择</option>
              {products.map((pack) => <option key={pack.packProductId} value={pack.packProductId}>{pack.displayName}</option>)}
            </select></label>
            <label>业务订单标识<input autoComplete="off" disabled={busy} name="external_order_ref" required /></label>
            <label>当前资源版本<input defaultValue="1" disabled={busy} min="1" name="grant_resource_version" required type="number" /></label>
            <label>公司名额数<input defaultValue="1" disabled={busy} min="1" name="seat_quantity" required type="number" /></label>
            <button className="auth-secondary" disabled={busy || products.length === 0} type="submit">记录授权</button>
          </form>
        </details>
      </div>
    </section>
  );
}
