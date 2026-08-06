import { describe, expect, it } from "vitest";

import {
  BROWSER_SESSION_COOKIE_NAME,
  createBrowserSessionStore,
  issueBrowserSession,
  validateBrowserRequest,
  verifyMutationSession,
} from "../src/server/security.js";
import { createClientConversationStore } from "../src/server/session-store.js";

function rawHeaders(values: Readonly<Record<string, string>>): string[] {
  return Object.entries(values).flatMap(([name, value]) => [name, value]);
}

describe("loopback request boundary", () => {
  it.each([
    ["127.0.0.1:4173", "http://127.0.0.1:4173", "same-origin"],
    ["localhost:4173", "http://localhost:4173", "same-origin"],
    ["127.0.0.1:4173", undefined, "none"],
  ])("accepts one exact loopback origin", (host, origin, secFetchSite) => {
    const headers = rawHeaders({ host, "sec-fetch-site": secFetchSite });
    if (origin !== undefined) headers.push("origin", origin);
    expect(validateBrowserRequest(headers)).toEqual({ ok: true });
  });

  it.each([
    rawHeaders({ host: "example.com:4173", origin: "http://example.com:4173", "sec-fetch-site": "same-origin" }),
    rawHeaders({ host: "127.0.0.1:4173", origin: "https://attacker.example", "sec-fetch-site": "cross-site" }),
    rawHeaders({ host: "127.0.0.1:4173", origin: "http://localhost:4173", "sec-fetch-site": "same-origin" }),
    rawHeaders({ host: "127.0.0.1:4173", origin: "http://127.0.0.1:4174", "sec-fetch-site": "same-origin" }),
  ])("rejects a non-matching request without reflecting it", (headers) => {
    const result = validateBrowserRequest(headers);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toMatch(/^CLIENT_(?:HOST|ORIGIN)_INVALID$/u);
    expect(JSON.stringify(result)).not.toContain("attacker");
  });

  it("rejects duplicate protected headers", () => {
    expect(validateBrowserRequest([
      "host", "127.0.0.1:4173",
      "Host", "127.0.0.1:4173",
      "sec-fetch-site", "same-origin",
    ])).toEqual({ ok: false, code: "CLIENT_HOST_INVALID" });
  });
});

describe("browser session and CSRF", () => {
  const deterministicBytes = (): ((size: number) => Buffer) => {
    let value = 0x29;
    return (size) => Buffer.alloc(size, value += 1);
  };

  it("issues an owner-held cookie and separate CSRF value", () => {
    const store = createBrowserSessionStore({ randomBytes: deterministicBytes() });
    const issued = issueBrowserSession(store);
    expect(issued.cookieValue).toBe("2a".repeat(32));
    expect(issued.csrf).toBe("2b".repeat(32));
    expect(issued.setCookie).toBe(
      `${BROWSER_SESSION_COOKIE_NAME}=${issued.cookieValue}; HttpOnly; SameSite=Strict; Path=/; Max-Age=14400`,
    );
    expect(verifyMutationSession(store, issued.cookieValue, issued.csrf)).toBe(true);
  });

  it.each([
    [undefined, "2a".repeat(32)],
    ["2a".repeat(32), undefined],
    ["2a".repeat(32), "2c".repeat(32)],
    ["not-hex", "2a".repeat(32)],
  ])("rejects an incomplete or mismatched mutation session", (cookieValue, csrf) => {
    const store = createBrowserSessionStore({ randomBytes: deterministicBytes() });
    issueBrowserSession(store);
    expect(verifyMutationSession(store, cookieValue, csrf)).toBe(false);
  });
});

describe("public conversation mapping", () => {
  it("never accepts or returns an internal conversation identity", () => {
    let byte = 0;
    const store = createClientConversationStore({
      randomBytes: (size) => Buffer.alloc(size, byte += 1),
    });
    const publicConversation = store.add("conversation_internal_secret");
    expect(publicConversation).toEqual({ id: `chat_${"01".repeat(16)}`, title: "对话 1" });
    expect(store.resolve(publicConversation.id)).toBe("conversation_internal_secret");
    expect(store.resolve("conversation_internal_secret")).toBeUndefined();
    expect(JSON.stringify(store.list())).not.toContain("internal_secret");
  });

  it("returns deeply immutable public records", () => {
    const store = createClientConversationStore({ randomBytes: (size) => Buffer.alloc(size, 0x3c) });
    const conversation = store.add("conversation_1");
    const list = store.list();
    expect(Object.isFrozen(conversation)).toBe(true);
    expect(Object.isFrozen(list)).toBe(true);
    expect(Object.isFrozen(list[0])).toBe(true);
  });
});
