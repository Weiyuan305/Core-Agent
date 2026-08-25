import { createRequire } from "node:module";

import { expect, test } from "playwright/test";

const require = createRequire(import.meta.url);
const axePath = require.resolve("axe-core/axe.min.js");
const adminSecret = `a${"A".repeat(42)}`;
const consultantSecret = `c${"C".repeat(42)}`;
const invalidSecret = `z${"Z".repeat(42)}`;

async function expectAccessible(page: import("playwright/test").Page): Promise<void> {
  const violations = await page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: () => Promise<{ violations: readonly unknown[] }> } }).axe;
    return (await axe.run()).violations;
  });
  expect(violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

async function signIn(page: import("playwright/test").Page, navigate = true): Promise<void> {
  if (navigate) {
    await page.goto("/");
  }
  await page.getByLabel("邮箱").fill("admin@example.com");
  await page.getByLabel("密码", { exact: true }).fill("password-long-enough");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("button", { name: "账户与安全" })).toBeVisible();
  expect((await page.context().cookies()).map(({ name }) => name).sort()).toEqual(["core_agent_csrf", "core_agent_session"]);
}

test.beforeEach(async ({ page }) => { await page.addInitScript({ path: axePath }); });

test("registers and verifies without opening a fake service", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "创建账户" }).click();
  await page.getByLabel("邮箱").fill("student@example.com");
  await page.getByLabel("密码", { exact: true }).fill("password-long-enough");
  await page.getByLabel("确认密码").fill("password-long-enough");
  await page.getByRole("button", { name: "继续注册" }).click();
  await page.getByLabel("验证码").fill("verification-code");
  await page.getByRole("button", { name: "完成验证" }).click();
  await expect(page.getByRole("heading", { name: "服务尚未开通" })).toBeVisible();
  await expect(page.getByText(/(?:购买|支付|checkout|自动创建)/iu)).toHaveCount(0);
  await expectAccessible(page);
});

test("starts Apple without rendering provider state", async ({ page }) => {
  await page.route("https://appleid.apple.com/**", (route) => route.abort());
  await page.goto("/");
  const request = page.waitForRequest((candidate) => candidate.url().startsWith("https://appleid.apple.com/"));
  await page.getByRole("button", { name: "使用 Apple 登录" }).click();
  expect((await request).url()).toContain("opaque=browser-fixture");
  expect(await page.locator("body").textContent()).not.toMatch(/(?:transaction_id|nonce|pkce|supabase|state=)/iu);
});

test("handles invitation copy and an authenticated admin acceptance", async ({ browser, page, baseURL }) => {
  await page.goto(`/?invitation=${invalidSecret}`);
  await expect(page.getByRole("alert")).toHaveText("这个邀请暂时无法使用，请向邀请人确认。");
  expect(page.url()).not.toContain("invitation=");

  const context = await browser.newContext({ baseURL });
  const accepted = await context.newPage();
  await accepted.addInitScript({ path: axePath });
  await signIn(accepted);
  await accepted.goto(`/?invitation=${adminSecret}`);
  await expect(accepted.getByText("公司管理员")).toBeVisible();
  await accepted.getByRole("button", { name: "接受邀请" }).click();
  await expect(accepted.getByRole("heading", { name: "服务与名额" })).toBeVisible();
  await accepted.getByRole("button", { name: "公司成员" }).click();
  const platform = accepted.getByTestId("member-membership_platform");
  await expect(platform.getByText("平台管理成员")).toBeVisible();
  await expect(platform.getByRole("button")).toHaveCount(0);
  await accepted.getByLabel("成员邮箱").fill("draft-member@example.com");
  await accepted.getByTestId("member-membership_company").getByRole("button", { name: "暂停成员" }).click();
  await expect(accepted.getByRole("heading", { name: "登录 Core Agent" })).toBeVisible();
  await signIn(accepted, false);
  await accepted.getByRole("button", { name: "公司成员" }).click();
  await expect(accepted.getByLabel("成员邮箱")).toHaveValue("draft-member@example.com");
  await expectAccessible(accepted);
  await context.close();
});

test("registers an invited consultant through email verification", async ({ page }) => {
  await page.goto(`/?invitation=${consultantSecret}`);
  await expect(page.getByText("顾问")).toBeVisible();
  await page.getByLabel("邮箱").fill("consultant@example.com");
  await page.getByLabel("密码").fill("password-long-enough");
  await page.getByRole("button", { name: "验证邮箱并加入" }).click();
  await page.getByLabel("验证码").fill("verification-code");
  await page.getByRole("button", { name: "完成验证" }).click();
  await expect(page.getByRole("heading", { name: "服务尚未开通" })).toBeVisible();
  expect(page.url()).not.toContain("invitation=");
});

test("reauthenticates before deletion and supports cancellation", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await page.addInitScript({ path: axePath });
  await signIn(page);
  await page.getByRole("button", { name: "账户与安全" }).click();
  await page.getByRole("button", { name: "申请删除账户" }).click();
  const dialog = page.getByRole("dialog", { name: "确认当前密码" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("当前密码").fill("password-long-enough");
  await dialog.getByRole("button", { name: "继续" }).click();
  await expect(page.getByText(/账户将在/u)).toBeVisible();
  await page.getByRole("button", { name: "撤销删除申请" }).click();
  await expect(page.getByRole("button", { name: "申请删除账户" })).toBeVisible();
  await page.getByRole("button", { name: "撤销当前会话" }).click();
  await expect(page.getByRole("heading", { name: "登录 Core Agent" })).toBeVisible();
  await expectAccessible(page);
  await context.close();
});

test("keeps keyboard focus, reduced motion, 200% zoom, and narrow layouts usable", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.getByLabel("邮箱").focus();
  await expect(page.getByLabel("邮箱")).toBeFocused();
  await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
  await expect(page.getByRole("heading", { name: "登录 Core Agent" })).toBeVisible();
  await expectAccessible(page);
});
