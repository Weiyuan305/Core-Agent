import { describe, expect, it, vi } from "vitest";

import { runControlPlaneWeb } from "../src/server/main.js";

function validEnvironment(port = "4173"): NodeJS.ProcessEnv {
  return { CORE_AGENT_WEB_PORT: port };
}

describe("managed Web host lifecycle", () => {
  it("listens only inside a ready managed session and cleans up in order", async () => {
    const events: string[] = [];
    const controller = new AbortController();
    const session = { context: {}, operations: {} };
    const app = {
      async listen(input: { host: string; port: number }) {
        events.push(`listen:${input.host}:${input.port}`);
        controller.abort();
      },
      async close() {
        events.push("app.close");
      },
    };

    await runControlPlaneWeb({
      controller,
      environment: validEnvironment("4317"),
      output: (line) => events.push(line),
      dependencies: {
        async runManagedSession(options) {
          events.push("runtime.ready");
          await options.use(session);
          events.push("runtime.cleanup");
        },
        createPort(candidate) {
          expect(candidate).toBe(session);
          return {} as never;
        },
        async buildApp(options) {
          expect(options.staticRoot).toMatch(/\/dist\/client$/u);
          events.push("app.build");
          return app as never;
        },
      },
    });

    expect(events).toEqual([
      "runtime.ready",
      "app.build",
      "listen:127.0.0.1:4317",
      "WEB_READY http://127.0.0.1:4317",
      "app.close",
      "runtime.cleanup",
    ]);
  });

  it("closes the app when waiting is interrupted", async () => {
    const controller = new AbortController();
    const close = vi.fn(async () => undefined);
    let listening!: () => void;
    const didListen = new Promise<void>((resolve) => { listening = resolve; });
    const run = runControlPlaneWeb({
      controller,
      environment: validEnvironment(),
      output: () => undefined,
      dependencies: {
        async runManagedSession(options) {
          await options.use({ context: {}, operations: {} });
        },
        createPort: () => ({} as never),
        async buildApp() {
          return {
            async listen() { listening(); },
            close,
          } as never;
        },
      },
    });

    await didListen;
    expect(close).not.toHaveBeenCalled();
    controller.abort();
    await run;
    expect(close).toHaveBeenCalledOnce();
  });

  it.each(["0", "1023", "65536", " 4173", "not-a-port"])(
    "rejects an invalid configured port without invoking the runtime: %s",
    async (port) => {
      const runManagedSession = vi.fn();
      await expect(runControlPlaneWeb({
        environment: validEnvironment(port),
        dependencies: {
          runManagedSession,
          createPort: () => ({} as never),
          buildApp: async () => ({} as never),
        },
      })).rejects.toThrowError("WEB_CONFIGURATION_INVALID");
      expect(runManagedSession).not.toHaveBeenCalled();
    },
  );

  it("does not pass Web-only configuration into managed runtime validation", async () => {
    const controller = new AbortController();
    controller.abort();
    const runManagedSession = vi.fn(async (options) => {
      expect(options.environment).not.toHaveProperty("CORE_AGENT_WEB_PORT");
      expect(options.environment.CORE_AGENT_REAL_HERMES_SMOKE).toBe("1");
      await options.use({ context: {}, operations: {} });
    });
    await runControlPlaneWeb({
      controller,
      environment: { CORE_AGENT_WEB_PORT: "4173" },
      output: () => undefined,
      dependencies: {
        runManagedSession,
        createPort: () => ({} as never),
        buildApp: async () => ({ listen: async () => undefined, close: async () => undefined } as never),
      },
    });
    expect(runManagedSession).toHaveBeenCalledOnce();
  });
});
