// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { ControlPlaneWebApp } from "../src/client/app.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("admits public auth without requesting the synthetic bootstrap", async () => {
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const path = String(input);
    if (path === "/client/v1/config") return Response.json({ schema_version: 1, mode: "public_auth" });
    if (path === "/auth/v1/session") return Response.json({ code: "AUTH_INVALID" }, { status: 401 });
    throw new Error(`unexpected path ${path}`);
  });
  vi.stubGlobal("fetch", fetchImpl);
  render(<ControlPlaneWebApp />);
  await screen.findByRole("heading", { name: "登录 Core Agent" });
  expect(fetchImpl.mock.calls.some(([input]) => String(input) === "/client/v1/bootstrap")).toBe(false);
});

it("fails closed when the server returns an unknown admission mode", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ schema_version: 1, mode: "unknown" })));
  render(<ControlPlaneWebApp />);
  expect((await screen.findByRole("alert")).textContent).toContain("暂时无法连接");
});
