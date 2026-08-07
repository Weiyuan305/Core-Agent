import { createRequire } from "node:module";

import { expect, test } from "playwright/test";

const require = createRequire(import.meta.url);
const axePath = require.resolve("axe-core/axe.min.js");

test("completes the consultant flow without overflow or accessibility violations", async ({ page }, testInfo) => {
  await page.addInitScript({ path: axePath });
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "给 Core Agent 发送任务或指令" });
  await expect(composer).toBeVisible();

  await composer.fill("匿名合成界面测试");
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page.getByText("这是用于界面验收的匿名合成回复。")).toBeVisible();

  if (testInfo.project.name === "iphone") {
    await page.getByRole("button", { name: "返回学生与对话" }).click();
    await expect(page.getByRole("navigation", { name: "学生与对话" })).toBeVisible();
  }

  await page.getByRole("button", { name: "新建对话" }).click();
  if (testInfo.project.name === "iphone") {
    await expect(composer).toBeVisible();
  } else {
    await expect(page.getByRole("button", { name: "演示空间，当前对话" })).toHaveCount(1);
  }

  const inspector = page.getByRole("complementary", { name: "当前学生" });
  const inspectorTrigger = page.getByRole("button", { name: "学生信息", exact: true });
  if (!(await inspector.isVisible())) await inspectorTrigger.click();
  await expect(inspector).toBeVisible();
  await inspector.getByRole("button", { name: "重新启动服务" }).click();
  await expect(inspector.getByRole("button", { name: "重新启动服务" })).toBeEnabled();
  await inspector.getByRole("button", { name: "关闭学生信息" }).click();
  await expect(inspectorTrigger).toBeFocused();
  await expect(inspector).toHaveCount(0);

  if (testInfo.project.name === "iphone") {
    await page.getByRole("button", { name: "返回学生与对话" }).click();
    await expect(page.getByRole("navigation", { name: "学生与对话" })).toBeVisible();
    await page.getByRole("button", { name: "演示空间，当前对话" }).click();
    await expect(composer).toBeVisible();
  }

  await page.keyboard.press("Tab");
  await expect(page.locator(":focus-visible")).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  const violations = await page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: () => Promise<{ violations: readonly unknown[] }> } }).axe;
    return (await axe.run()).violations;
  });
  expect(violations).toEqual([]);
});

test("shows a calm retryable failure without technical details", async ({ page }) => {
  await page.addInitScript({ path: axePath });
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "给 Core Agent 发送任务或指令" });
  await composer.fill("匿名失败界面测试");
  await page.getByRole("button", { name: "发送" }).click();

  await expect(page.getByText("现在请求较多，请稍后再试。")).toBeVisible();
  const retry = page.getByRole("button", { name: "再试一次" });
  await retry.focus();
  await expect(retry).toBeFocused();
  const transcript = page.getByRole("log");
  await expect(transcript).not.toContainText(/(?:503|SSE|Hermes|Worker|MODEL_|CLIENT_RUN_FAILED|tokenhub)/u);

  await retry.click();
  await expect(page.getByText("这是重新生成的匿名合成回复。")).toBeVisible();
  await expect(retry).toHaveCount(0);

  const violations = await page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: () => Promise<{ violations: readonly unknown[] }> } }).axe;
    return (await axe.run()).violations;
  });
  expect(violations).toEqual([]);
});
