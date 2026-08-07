import { describe, expect, it, vi } from "vitest";

import {
  createClientGatewayPort,
  parseClientEventStream,
} from "../src/client/api/client-gateway.js";
import type { ClientFrame } from "../src/shared/protocol.js";

function streamChunks(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function encodedStream(frames: readonly ClientFrame[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return streamChunks(...frames.map((frame) => encoder.encode(`data: ${JSON.stringify(frame)}\n\n`)));
}

async function collect(stream: AsyncIterable<ClientFrame>): Promise<ClientFrame[]> {
  const frames: ClientFrame[] = [];
  for await (const frame of stream) frames.push(frame);
  return frames;
}

describe("client event stream", () => {
  it("reassembles split UTF-8 chunks in protocol order", async () => {
    const bytes = new TextEncoder().encode([
      'data: {"type":"run.started"}\n\n',
      'data: {"type":"message.delta","delta":"你好"}\n\n',
      'data: {"type":"message.completed"}\n\n',
      'data: {"type":"run.completed"}\n\n',
    ].join(""));
    const splitInsideChinese = bytes.indexOf(0xe4) + 1;
    const frames = await collect(parseClientEventStream(streamChunks(
      bytes.slice(0, splitInsideChinese),
      bytes.slice(splitInsideChinese),
    )));
    expect(frames).toEqual([
      { type: "run.started" },
      { type: "message.delta", delta: "你好" },
      { type: "message.completed" },
      { type: "run.completed" },
    ]);
  });

  it.each([
    ["missing start", [{ type: "message.delta", delta: "no" }, { type: "run.completed" }]],
    ["duplicate terminal", [{ type: "run.started" }, { type: "message.completed" }, { type: "run.completed" }, { type: "run.completed" }]],
    ["post terminal delta", [{ type: "run.started" }, { type: "message.completed" }, { type: "run.completed" }, { type: "message.delta", delta: "late" }]],
    ["missing message terminal", [{ type: "run.started" }, { type: "run.completed" }]],
  ] as const)("rejects %s", async (_label, frames) => {
    await expect(collect(parseClientEventStream(encodedStream(frames as readonly ClientFrame[]))))
      .rejects.toThrowError("CLIENT_FRAME_INVALID");
  });

  it("rejects unknown SSE fields and truncated UTF-8", async () => {
    const unknown = streamChunks(new TextEncoder().encode('event: delta\ndata: {"type":"run.started"}\n\n'));
    await expect(collect(parseClientEventStream(unknown))).rejects.toThrowError("CLIENT_FRAME_INVALID");
    const truncated = streamChunks(new Uint8Array([0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xe4]));
    await expect(collect(parseClientEventStream(truncated))).rejects.toThrowError("CLIENT_FRAME_INVALID");
  });

  it("rejects an overlarge aggregate stream", async () => {
    const oversized = new Uint8Array(4 * 1_024 * 1_024 + 1).fill(0x61);
    await expect(collect(parseClientEventStream(streamChunks(oversized))))
      .rejects.toThrowError("CLIENT_FRAME_INVALID");
  });
});

describe("client Gateway port", () => {
  it("keeps CSRF in memory and attaches it only to mutation headers", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        csrf: "a".repeat(64),
        runtimeState: "ready",
        student: { id: "demo_student", name: "演示学生" },
        conversations: [{ id: `chat_${"b".repeat(32)}`, title: "演示空间" }],
        selectedConversationId: `chat_${"b".repeat(32)}`,
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: `chat_${"c".repeat(32)}`,
        title: "演示空间",
      }), { status: 201, headers: { "content-type": "application/json" } }));
    const port = createClientGatewayPort(fetchImpl);

    await port.bootstrap();
    await port.createConversation();

    expect(fetchImpl.mock.calls[0]?.[0]).toBe("/client/v1/bootstrap");
    expect(fetchImpl.mock.calls[1]?.[0]).toBe("/client/v1/conversations");
    const request = fetchImpl.mock.calls[1]?.[1];
    expect(request?.credentials).toBe("same-origin");
    expect(new Headers(request?.headers).get("x-core-agent-csrf")).toBe("a".repeat(64));
    expect(JSON.stringify(fetchImpl.mock.calls)).not.toContain(`?csrf=`);
  });

  it("streams decoded frames through the typed port", async () => {
    const frames: ClientFrame[] = [
      { type: "run.started" },
      { type: "message.delta", delta: "完成" },
      { type: "message.completed" },
      { type: "run.completed" },
    ];
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        csrf: "a".repeat(64), runtimeState: "ready",
        student: { id: "demo_student", name: "演示学生" },
        conversations: [{ id: `chat_${"b".repeat(32)}`, title: "演示空间" }],
        selectedConversationId: `chat_${"b".repeat(32)}`,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(encodedStream(frames), {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      }));
    const port = createClientGatewayPort(fetchImpl);
    await port.bootstrap();
    expect(await collect(port.runConversation(`chat_${"b".repeat(32)}`, "匿名测试"))).toEqual(frames);
  });

  it("requests an explicit retry without a body or internal Run identity", async () => {
    const frames: ClientFrame[] = [
      { type: "run.started" },
      { type: "run.failed", reason: "TOOK_TOO_LONG" },
    ];
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        csrf: "a".repeat(64), runtimeState: "ready",
        student: { id: "demo_student", name: "演示学生" },
        conversations: [{ id: `chat_${"b".repeat(32)}`, title: "演示空间" }],
        selectedConversationId: `chat_${"b".repeat(32)}`,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(encodedStream(frames), {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      }));
    const port = createClientGatewayPort(fetchImpl);
    await port.bootstrap();
    expect(await collect(port.retryConversation(`chat_${"b".repeat(32)}`))).toEqual(frames);
    const retry = fetchImpl.mock.calls[1];
    expect(retry?.[0]).toBe(`/client/v1/conversations/chat_${"b".repeat(32)}/retries`);
    expect(retry?.[1]?.body).toBeUndefined();
    expect(new Headers(retry?.[1]?.headers).get("content-type")).toBeNull();
    expect(JSON.stringify(retry)).not.toContain("run_internal");
  });

  it("maps raw transport failures to a stable public error", async () => {
    const port = createClientGatewayPort(vi.fn<typeof fetch>().mockRejectedValue(new Error("secret upstream")));
    await expect(port.bootstrap()).rejects.toThrowError("CLIENT_CONFIGURATION_INVALID");
  });
});
