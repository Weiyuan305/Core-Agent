import { randomBytes as nodeRandomBytes, timingSafeEqual } from "node:crypto";

import type { ClientPublicErrorCode } from "../shared/protocol.js";

export const BROWSER_SESSION_COOKIE_NAME = "core_agent_session";
const SESSION_BYTES = 32;
const SESSION_MAX_AGE_SECONDS = 14_400;
const MAX_BROWSER_SESSIONS = 16;
const tokenPattern = /^[a-f0-9]{64}$/u;
const headerNamePattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;

type RandomBytes = (size: number) => Buffer;

export type BrowserRequestDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "CLIENT_HOST_INVALID" | "CLIENT_ORIGIN_INVALID" };

export interface BrowserSession {
  readonly cookieValue: string;
  readonly csrf: string;
  readonly setCookie: string;
}

interface StoredSession {
  readonly csrf: string;
  readonly expiresAt: number;
}

export interface BrowserSessionStore {
  readonly issue: () => BrowserSession;
  readonly verify: (cookieValue: string | undefined, csrf: string | undefined) => boolean;
}

interface BrowserSessionStoreOptions {
  readonly now?: () => number;
  readonly randomBytes?: RandomBytes;
}

function invalidDecision(code: "CLIENT_HOST_INVALID" | "CLIENT_ORIGIN_INVALID"): BrowserRequestDecision {
  return Object.freeze({ ok: false, code });
}

function parseRawHeaders(rawHeaders: readonly string[]): Map<string, readonly string[]> | undefined {
  if (!Array.isArray(rawHeaders) || Object.getPrototypeOf(rawHeaders) !== Array.prototype || rawHeaders.length % 2 !== 0) {
    return undefined;
  }
  const ownKeys = Reflect.ownKeys(rawHeaders);
  if (
    ownKeys.length !== rawHeaders.length + 1
    || ownKeys.some((key) => key !== "length" && (typeof key !== "string" || !/^\d+$/u.test(key)))
  ) return undefined;

  const values = new Map<string, string[]>();
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const nameDescriptor = Object.getOwnPropertyDescriptor(rawHeaders, String(index));
    const valueDescriptor = Object.getOwnPropertyDescriptor(rawHeaders, String(index + 1));
    if (
      nameDescriptor === undefined
      || valueDescriptor === undefined
      || !("value" in nameDescriptor)
      || !("value" in valueDescriptor)
      || nameDescriptor.enumerable !== true
      || valueDescriptor.enumerable !== true
      || typeof nameDescriptor.value !== "string"
      || typeof valueDescriptor.value !== "string"
      || !headerNamePattern.test(nameDescriptor.value)
      || /[\u0000\r\n]/u.test(valueDescriptor.value)
    ) return undefined;
    const name = nameDescriptor.value.toLowerCase();
    const current = values.get(name) ?? [];
    current.push(valueDescriptor.value);
    values.set(name, current);
  }
  return values;
}

function singleton(headers: Map<string, readonly string[]>, name: string): string | undefined | null {
  const values = headers.get(name);
  if (values === undefined) return undefined;
  return values.length === 1 ? values[0] : null;
}

function parseLoopbackHost(value: string): URL | undefined {
  if (value.length < 1 || value.length > 255 || /[\u0000-\u0020\u007f]/u.test(value)) return undefined;
  try {
    const parsed = new URL(`http://${value}`);
    if (
      (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost")
      || parsed.username !== ""
      || parsed.password !== ""
      || parsed.pathname !== "/"
      || parsed.search !== ""
      || parsed.hash !== ""
    ) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function validateBrowserRequest(rawHeaders: readonly string[]): BrowserRequestDecision {
  const headers = parseRawHeaders(rawHeaders);
  if (headers === undefined) return invalidDecision("CLIENT_HOST_INVALID");
  const hostValue = singleton(headers, "host");
  if (hostValue === undefined || hostValue === null) return invalidDecision("CLIENT_HOST_INVALID");
  const host = parseLoopbackHost(hostValue);
  if (host === undefined) return invalidDecision("CLIENT_HOST_INVALID");

  const originValue = singleton(headers, "origin");
  const fetchSite = singleton(headers, "sec-fetch-site");
  if (originValue === null || fetchSite === null) return invalidDecision("CLIENT_ORIGIN_INVALID");
  if (fetchSite !== undefined && fetchSite !== "same-origin" && fetchSite !== "none") {
    return invalidDecision("CLIENT_ORIGIN_INVALID");
  }
  if (originValue !== undefined) {
    try {
      const origin = new URL(originValue);
      if (
        origin.protocol !== "http:"
        || origin.host !== host.host
        || origin.username !== ""
        || origin.password !== ""
        || origin.pathname !== "/"
        || origin.search !== ""
        || origin.hash !== ""
      ) return invalidDecision("CLIENT_ORIGIN_INVALID");
    } catch {
      return invalidDecision("CLIENT_ORIGIN_INVALID");
    }
  }
  return Object.freeze({ ok: true });
}

function generatedToken(randomBytes: RandomBytes): string {
  const bytes = randomBytes(SESSION_BYTES);
  if (!Buffer.isBuffer(bytes) || bytes.length !== SESSION_BYTES) {
    throw new Error("CLIENT_CONFIGURATION_INVALID");
  }
  return bytes.toString("hex");
}

function safeTokenEqual(left: string, right: string): boolean {
  if (!tokenPattern.test(left) || !tokenPattern.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export function createBrowserSessionStore(options: BrowserSessionStoreOptions = {}): BrowserSessionStore {
  const randomBytes = options.randomBytes ?? nodeRandomBytes;
  const now = options.now ?? Date.now;
  const sessions = new Map<string, StoredSession>();

  const purge = (): void => {
    const current = now();
    for (const [key, session] of sessions) {
      if (session.expiresAt <= current) sessions.delete(key);
    }
    while (sessions.size >= MAX_BROWSER_SESSIONS) {
      const oldest = sessions.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      sessions.delete(oldest);
    }
  };

  return Object.freeze({
    issue(): BrowserSession {
      purge();
      const cookieValue = generatedToken(randomBytes);
      const csrf = generatedToken(randomBytes);
      sessions.set(cookieValue, Object.freeze({
        csrf,
        expiresAt: now() + SESSION_MAX_AGE_SECONDS * 1_000,
      }));
      return Object.freeze({
        cookieValue,
        csrf,
        setCookie: `${BROWSER_SESSION_COOKIE_NAME}=${cookieValue}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}`,
      });
    },
    verify(cookieValue: string | undefined, csrf: string | undefined): boolean {
      if (cookieValue === undefined || csrf === undefined || !tokenPattern.test(cookieValue) || !tokenPattern.test(csrf)) {
        return false;
      }
      const session = sessions.get(cookieValue);
      if (session === undefined || session.expiresAt <= now()) {
        sessions.delete(cookieValue);
        return false;
      }
      return safeTokenEqual(session.csrf, csrf);
    },
  });
}

export function issueBrowserSession(store: BrowserSessionStore): BrowserSession {
  return store.issue();
}

export function verifyMutationSession(
  store: BrowserSessionStore,
  cookieValue: string | undefined,
  csrf: string | undefined,
): boolean {
  return store.verify(cookieValue, csrf);
}

export function clientSecurityError(code: ClientPublicErrorCode): Error {
  return new Error(code);
}
