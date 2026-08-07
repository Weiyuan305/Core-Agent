// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConsultantWorkspaceApp } from "../src/client/app.js";
import type { ClientGatewayPort } from "../src/client/api/client-gateway.js";
import type { ClientFrame } from "../src/shared/protocol.js";

const firstId = `chat_${"a".repeat(32)}`;
const secondId = `chat_${"b".repeat(32)}`;

afterEach(cleanup);

function fakePort(overrides: Partial<ClientGatewayPort> = {}): ClientGatewayPort {
  return {
    bootstrap: vi.fn(async () => ({
      csrf: "c".repeat(64),
      runtimeState: "ready",
      student: { id: "demo_student", name: "演示学生" },
      conversations: [{ id: firstId, title: "演示空间" }],
      selectedConversationId: firstId,
    })),
    createConversation: vi.fn(async () => ({ id: secondId, title: "演示空间" })),
    runConversation: vi.fn(async function* (): AsyncGenerator<ClientFrame> {
      yield { type: "run.started" };
      yield { type: "message.delta", delta: "这是" };
      yield { type: "message.delta", delta: "流式回复" };
      yield { type: "message.completed" };
      yield { type: "run.completed" };
    }),
    retryConversation: vi.fn(async function* (): AsyncGenerator<ClientFrame> {
      yield { type: "run.started" };
      yield { type: "message.delta", delta: "重试成功" };
      yield { type: "message.completed" };
      yield { type: "run.completed" };
    }),
    restartApiWorker: vi.fn(async () => undefined),
    health: vi.fn(async () => ({ state: "ready" as const })),
    ...overrides,
  };
}

async function renderReady(port = fakePort()) {
  render(<ConsultantWorkspaceApp port={port} />);
  await screen.findByRole("textbox", { name: "给 Core Agent 发送任务或指令" });
  return port;
}

describe("consultant workspace", () => {
  it("renders the one demo student and selected real Conversation", async () => {
    await renderReady();
    expect(screen.getAllByText("演示学生").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "演示空间，当前对话" }).getAttribute("aria-current")).toBe("page");
    expect(screen.queryByText("已连接")).not.toBeNull();
  });

  it("sends one consultant turn and renders streamed assistant content", async () => {
    const port = await renderReady();
    const user = userEvent.setup();
    const composer = screen.getByRole("textbox", { name: "给 Core Agent 发送任务或指令" });
    await user.type(composer, "请制定下一步计划");
    await user.click(screen.getByRole("button", { name: "发送" }));

    await screen.findByText("这是流式回复");
    expect(screen.queryByText("请制定下一步计划")).not.toBeNull();
    expect(port.runConversation).toHaveBeenCalledWith(firstId, "请制定下一步计划");
  });

  it("keeps the draft editable but disables a second send during streaming", async () => {
    let release!: () => void;
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const port = fakePort({
      async *runConversation(): AsyncGenerator<ClientFrame> {
        yield { type: "run.started" };
        started();
        await hold;
        yield { type: "message.delta", delta: "完成" };
        yield { type: "message.completed" };
        yield { type: "run.completed" };
      },
    });
    await renderReady(port);
    const user = userEvent.setup();
    const composer = screen.getByRole("textbox", { name: "给 Core Agent 发送任务或指令" });
    await user.type(composer, "第一条");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await didStart;
    await user.type(composer, "下一条草稿");
    expect((composer as HTMLTextAreaElement).value).toBe("下一条草稿");
    expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { release(); await hold; });
    await screen.findByText("完成");
  });

  it("renders a zero-content failure as one calm status card and retries through the child-Run route", async () => {
    const runConversation = vi.fn(async function* (): AsyncGenerator<ClientFrame> {
      yield { type: "run.started" };
      yield { type: "run.failed", reason: "BUSY" };
    });
    const retryConversation = vi.fn(async function* (): AsyncGenerator<ClientFrame> {
      yield { type: "run.started" };
      yield { type: "message.delta", delta: "重试后的回复" };
      yield { type: "message.completed" };
      yield { type: "run.completed" };
    });
    const port = fakePort({
      runConversation,
      retryConversation,
    });
    await renderReady(port);
    const user = userEvent.setup();
    const composer = screen.getByRole("textbox", { name: "给 Core Agent 发送任务或指令" });
    await user.type(composer, "需要重试");
    const send = screen.getByRole("button", { name: "发送" });
    await user.click(send);

    const message = await screen.findByText("现在请求较多，请稍后再试。");
    expect(message.closest(".run-failure-card")).not.toBeNull();
    expect(document.querySelector(".stream-caret")).toBeNull();
    expect(screen.getByRole("log").getAttribute("aria-live")).toBe("polite");
    expect(document.activeElement).toBe(send);

    await user.click(screen.getByRole("button", { name: "再试一次" }));
    await screen.findByText("重试后的回复");
    expect(retryConversation).toHaveBeenCalledWith(firstId);
    expect(runConversation).toHaveBeenCalledOnce();
  });

  it("keeps partial content and shows the precise incomplete notice", async () => {
    const port = fakePort({
      async *runConversation(): AsyncGenerator<ClientFrame> {
        yield { type: "run.started" };
        yield { type: "message.delta", delta: "已经生成的内容" };
        yield { type: "run.failed", reason: "REPLY_INTERRUPTED" };
      },
    });
    await renderReady(port);
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox"), "触发部分回复");
    await user.click(screen.getByRole("button", { name: "发送" }));
    expect(await screen.findByText("已经生成的内容")).not.toBeNull();
    expect(screen.getByText("这条回复没有完成，内容可能不完整。")).not.toBeNull();
    expect(screen.getByRole("button", { name: "重新生成" })).not.toBeNull();
  });

  it("does not show a dead action for service configuration failures", async () => {
    const port = fakePort({
      async *runConversation(): AsyncGenerator<ClientFrame> {
        yield { type: "run.started" };
        yield { type: "run.failed", reason: "SERVICE_UNAVAILABLE" };
      },
    });
    await renderReady(port);
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox"), "不可重试场景");
    await user.click(screen.getByRole("button", { name: "发送" }));
    expect(await screen.findByText("这项服务暂时无法使用。如问题持续，请联系支持。")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /(?:重试|支持)/u })).toBeNull();
  });

  it("shows one disabled loading action while a retry is in flight", async () => {
    let release!: () => void;
    let admitted!: () => void;
    const isAdmitted = new Promise<void>((resolve) => { admitted = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const port = fakePort({
      async *runConversation(): AsyncGenerator<ClientFrame> {
        yield { type: "run.started" };
        yield { type: "run.failed", reason: "NO_REPLY" };
      },
      async *retryConversation(): AsyncGenerator<ClientFrame> {
        yield { type: "run.started" };
        admitted();
        await hold;
        yield { type: "message.delta", delta: "恢复" };
        yield { type: "message.completed" };
        yield { type: "run.completed" };
      },
    });
    await renderReady(port);
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox"), "无回复");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await user.click(await screen.findByRole("button", { name: "再试一次" }));
    await isAdmitted;
    const loading = screen.getByRole("button", { name: "正在处理…" });
    expect((loading as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { release(); await hold; });
    await screen.findByText("恢复");
  });

  it("creates and selects a new real Conversation", async () => {
    const port = await renderReady();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "新建对话" }));
    await waitFor(() => expect(port.createConversation).toHaveBeenCalledOnce());
    const current = screen.getAllByRole("button", { name: "演示空间，当前对话" });
    expect(current).toHaveLength(1);
  });

  it("restarts once, preserves readiness, and keeps raw failures private", async () => {
    const restartApiWorker = vi.fn(async () => { throw new Error("private worker detail"); });
    await renderReady(fakePort({ restartApiWorker }));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "重新启动服务" }));
    await screen.findByText("服务暂时无法重新启动。");
    expect(screen.queryByText(/private worker detail/u)).toBeNull();
    expect(restartApiWorker).toHaveBeenCalledOnce();
  });

  it("returns focus to the inspector trigger after close", async () => {
    await renderReady();
    const user = userEvent.setup();
    const trigger = screen.getByRole("button", { name: "学生信息" });
    const inspector = screen.getByRole("complementary", { name: "当前学生" });
    await user.click(within(inspector).getByRole("button", { name: "关闭学生信息" }));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("shows mobile student navigation without losing transcript state", async () => {
    await renderReady();
    const user = userEvent.setup();
    const composer = screen.getByRole("textbox", { name: "给 Core Agent 发送任务或指令" });
    await user.type(composer, "保留这段内容");
    await user.click(screen.getByRole("button", { name: "返回学生与对话" }));
    expect(screen.getByRole("navigation", { name: "学生与对话" }).getAttribute("data-mobile-visible")).toBe("true");
    await user.click(screen.getByRole("button", { name: "演示空间，当前对话" }));
    expect((composer as HTMLTextAreaElement).value).toBe("保留这段内容");
  });

  it.each(["", "bad\u0000input", "x".repeat(4_001)])("announces invalid input and never starts a Run", async (message) => {
    const runConversation = vi.fn<ClientGatewayPort["runConversation"]>();
    await renderReady(fakePort({ runConversation }));
    const user = userEvent.setup();
    const composer = screen.getByRole("textbox", { name: "给 Core Agent 发送任务或指令" });
    fireEvent.change(composer, { target: { value: message } });
    await user.click(screen.getByRole("button", { name: "发送" }));
    expect((await screen.findByRole("alert")).textContent?.length).toBeGreaterThan(0);
    expect(runConversation).not.toHaveBeenCalled();
  });
});
