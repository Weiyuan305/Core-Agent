import { createRequire } from "node:module";

import { expect, test, type Page } from "playwright/test";

const require = createRequire(import.meta.url);
const axePath = require.resolve("axe-core/axe.min.js");
const adminSecret = `a${"A".repeat(42)}`;

async function accessible(page: Page): Promise<void> {
  const violations = await page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: () => Promise<{ violations: readonly unknown[] }> } }).axe;
    return (await axe.run()).violations;
  });
  expect(violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto("/");
  await page.getByLabel("邮箱").fill(email);
  await page.getByLabel("密码", { exact: true }).fill("password-long-enough");
  await page.getByRole("button", { name: "登录", exact: true }).click();
}

test.beforeEach(async ({ page }) => { await page.addInitScript({ path: axePath }); });

test("platform manages reviewed versions through closed admin commands", async ({ page }) => {
  await signIn(page, "platform@example.com");
  await expect(page.getByRole("heading", { name: "平台服务管理" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "资料读取", exact: true })).toBeVisible();
  const suspendRequest = page.waitForRequest((request) => request.url().endsWith("/app/v1/platform/entitlements") && request.method() === "POST");
  await page.getByRole("button", { name: "暂停服务" }).click();
  const payload = (await suspendRequest).postDataJSON() as { action: string; command: Record<string, unknown> };
  expect(payload.action).toBe("change_status");
  expect(payload.command).toMatchObject({ entitlement_id: "entitlement_browser", status: "suspended", reason_code: "administrator_suspended" });
  expect(JSON.stringify(payload)).not.toMatch(/(?:provider_secret|tool_schema|customer_content)/iu);
  await accessible(page);
});

test("company admin sees seats and submits one eligible assignment", async ({ page }) => {
  await signIn(page, "admin@example.com");
  await page.goto(`/?invitation=${adminSecret}`);
  await page.getByRole("button", { name: "接受邀请" }).click();
  await expect(page.getByRole("heading", { name: "服务与名额" })).toBeVisible();
  await expect(page.getByText("已使用 1 / 3")).toBeVisible();
  await page.getByLabel("选择顾问").selectOption("profile_consultant");
  const assignment = page.waitForRequest((request) => request.url().endsWith("/app/v1/company/assignments") && request.method() === "POST");
  await page.getByRole("button", { name: "分配名额" }).click();
  expect(((await assignment).postDataJSON() as { action: string }).action).toBe("assign");
  await accessible(page);
});

test("student preparation is calm and conversation remains fail-closed", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await signIn(page, "student@example.com");
  await expect(page.getByRole("heading", { name: "我的服务" })).toBeVisible();
  await expect(page.getByText("服务正在准备，完成后即可开始对话。")).toBeVisible();
  await expect(page.getByRole("button", { name: "开始对话" })).toBeDisabled();
  await expect(page.locator("body")).not.toContainText(/(?:价格|支付|购买|failed|runtime|container|supabase|hermes|provider)/iu);
  await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
  await accessible(page);
});
