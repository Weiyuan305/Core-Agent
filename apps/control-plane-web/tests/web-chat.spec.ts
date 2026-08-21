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

test("keeps partial content and regenerates without exposing technical details", async ({ page }) => {
  await page.addInitScript({ path: axePath });
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "给 Core Agent 发送任务或指令" });
  await composer.fill("匿名部分失败界面测试");
  await page.getByRole("button", { name: "发送" }).click();

  const transcript = page.getByRole("log");
  await expect(transcript.getByText("已经生成的匿名内容。")).toBeVisible();
  await expect(transcript.getByText("这条回复没有完成，内容可能不完整。")).toBeVisible();
  const regenerate = transcript.getByRole("button", { name: "重新生成" });
  await expect(regenerate).toBeVisible();
  await expect(transcript).not.toContainText(/(?:502|SSE|Hermes|Worker|REPLY_INTERRUPTED|tokenhub)/u);

  await regenerate.click();
  await expect(transcript.getByText("这是重新生成的匿名合成回复。")).toBeVisible();
  await expect(regenerate).toHaveCount(0);

  const violations = await page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: () => Promise<{ violations: readonly unknown[] }> } }).axe;
    return (await axe.run()).violations;
  });
  expect(violations).toEqual([]);
});

test("keeps long conversations inside a vertically scrollable transcript", async ({ page }) => {
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "给 Core Agent 发送任务或指令" });
  await composer.fill("匿名长回复界面测试");
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page.getByText(/这是一段用于验证长对话滚动区域的匿名合成内容/u)).toBeVisible();

  const layout = await page.evaluate(() => {
    const workspace = document.querySelector<HTMLElement>(".workspace");
    const conversation = document.querySelector<HTMLElement>(".conversation-workspace");
    const transcript = document.querySelector<HTMLElement>(".transcript");
    if (workspace === null || conversation === null || transcript === null) throw new Error("layout missing");
    return {
      conversationHeight: conversation.clientHeight,
      transcriptClientHeight: transcript.clientHeight,
      transcriptScrollHeight: transcript.scrollHeight,
      viewportHeight: window.innerHeight,
      workspaceHeight: workspace.clientHeight,
    };
  });

  expect(layout.workspaceHeight).toBe(layout.viewportHeight);
  expect(layout.conversationHeight).toBeLessThanOrEqual(layout.workspaceHeight);
  expect(layout.transcriptScrollHeight).toBeGreaterThan(layout.transcriptClientHeight);

  const transcript = page.getByRole("log");
  await expect.poll(() => transcript.evaluate((element) => (
    element.scrollHeight - element.clientHeight - element.scrollTop
  ))).toBeLessThanOrEqual(1);
  await transcript.hover();
  await page.mouse.wheel(0, -800);
  await expect(page.getByRole("button", { name: "回到最新消息" })).toBeVisible();
  await page.getByRole("button", { name: "回到最新消息" }).click();
  await expect.poll(() => transcript.evaluate((element) => (
    element.scrollHeight - element.clientHeight - element.scrollTop
  ))).toBeLessThanOrEqual(1);
  await expect(page.getByRole("button", { name: "回到最新消息" })).toHaveCount(0);
});

test("keeps the selected Conversation visible in a constrained scrolling list", async ({ page }, testInfo) => {
  await page.goto("/");
  if (testInfo.project.name === "iphone") {
    await page.getByRole("button", { name: "返回学生与对话" }).click();
    await expect(page.getByRole("navigation", { name: "学生与对话" })).toBeVisible();
  }
  const conversationRows = page.locator(".conversation-row");
  let expectedConversationCount = await conversationRows.count();
  for (let index = 0; index < 11; index += 1) {
    await page.getByRole("button", { name: "新建对话" }).click();
    expectedConversationCount += 1;
    await expect(conversationRows).toHaveCount(expectedConversationCount);
    if (testInfo.project.name === "iphone") {
      await page.getByRole("button", { name: "返回学生与对话" }).click();
      await expect(page.getByRole("navigation", { name: "学生与对话" })).toBeVisible();
    }
  }

  const list = page.locator(".conversation-list__items");
  const selected = page.locator('.conversation-row[aria-current="page"]');
  const readMetrics = async () => page.evaluate(() => {
    const items = document.querySelector<HTMLElement>(".conversation-list__items");
    const current = document.querySelector<HTMLElement>('.conversation-row[aria-current="page"]');
    if (items === null || current === null) throw new Error("Conversation list missing");
    const listRect = items.getBoundingClientRect();
    const currentRect = current.getBoundingClientRect();
    return {
      clientHeight: items.clientHeight,
      currentBottom: currentRect.bottom,
      currentTop: currentRect.top,
      listBottom: listRect.bottom,
      listTop: listRect.top,
      scrollHeight: items.scrollHeight,
      scrollTop: items.scrollTop,
    };
  });

  await expect(list).toBeVisible();
  await expect(selected).toHaveCount(1);
  await expect.poll(async () => {
    const current = await readMetrics();
    return current.scrollHeight > current.clientHeight
      && current.scrollTop > 0
      && current.currentTop >= current.listTop
      && current.currentBottom <= current.listBottom + 1;
  }).toBe(true);
  const metrics = await readMetrics();
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
  expect(metrics.scrollTop).toBeGreaterThan(0);
  expect(metrics.currentTop).toBeGreaterThanOrEqual(metrics.listTop);
  expect(metrics.currentBottom).toBeLessThanOrEqual(metrics.listBottom + 1);
});

test("reclaims the desktop inspector column when student details close", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "wide desktop grid only");
  await page.goto("/");
  const inspector = page.getByRole("complementary", { name: "当前学生" });
  await expect(inspector).toBeVisible();
  const before = await page.locator(".conversation-workspace").evaluate((element) => element.clientWidth);
  await inspector.getByRole("button", { name: "关闭学生信息" }).click();
  await expect(inspector).toHaveCount(0);
  const after = await page.locator(".conversation-workspace").evaluate((element) => element.clientWidth);
  expect(after - before).toBeGreaterThanOrEqual(270);
});

test("moves a newly submitted turn into view after the reader scrolled away", async ({ page }) => {
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "给 Core Agent 发送任务或指令" });
  await composer.fill("匿名长回复界面测试");
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page.getByText(/这是一段用于验证长对话滚动区域的匿名合成内容/u)).toBeVisible();
  const transcript = page.getByRole("log");
  await transcript.hover();
  await page.mouse.wheel(0, -800);

  await composer.fill("匿名合成界面测试");
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page.getByText("这是用于界面验收的匿名合成回复。")).toBeVisible();
  await expect.poll(() => transcript.evaluate((element) => (
    element.scrollHeight - element.clientHeight - element.scrollTop
  ))).toBeLessThanOrEqual(1);
});

test("makes the transcript keyboard focusable and scrollable", async ({ page }) => {
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "给 Core Agent 发送任务或指令" });
  await composer.fill("匿名长回复界面测试");
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page.getByText(/这是一段用于验证长对话滚动区域的匿名合成内容/u)).toBeVisible();

  const transcript = page.getByRole("log", { name: "对话记录" });
  await expect(transcript).toHaveAttribute("tabindex", "0");
  await transcript.focus();
  await expect(transcript).toBeFocused();
  await page.keyboard.press("Home");
  await expect.poll(() => transcript.evaluate((element) => element.scrollTop)).toBeLessThanOrEqual(2);
  await page.keyboard.press("End");
  await expect.poll(() => transcript.evaluate((element) => (
    element.scrollHeight - element.clientHeight - element.scrollTop
  ))).toBeLessThanOrEqual(1);
});
