const scenario = process.env.CLEANUP_TEST_DATABASE_CHILD_SCENARIO;
const startupDelayMs = Number(process.env.CLEANUP_TEST_DATABASE_CHILD_STARTUP_DELAY_MS ?? "125");
let dropAttempts = 0;
let remainingChecks = 0;
let statementTimeoutMs = 0;

async function sendDiagnostic(message) {
  if (process.send === undefined) return;
  await new Promise((resolve, reject) => {
    process.send(message, (error) => {
      if (error === null) resolve();
      else reject(error);
    });
  });
}

export class Client {
  constructor(config) {
    statementTimeoutMs = Number(config.statement_timeout);
  }

  async connect() {
    if (scenario === "drop-connect-failure") throw new Error("synthetic connection failure");
    if (scenario === "startup-delay") {
      await new Promise((resolve) => setTimeout(resolve, startupDelayMs));
    }
  }

  async end() {
    if (scenario === "drop-end-hang") await new Promise(() => undefined);
  }

  async query(sql, values) {
    if (/pg_terminate_backend/iu.test(sql)) {
      return { rows: scenario === "termination-failure" ? [{ pg_terminate_backend: false }] : [] };
    }
    if (/count\(\*\)/iu.test(sql)) {
      remainingChecks += 1;
      const remaining = scenario === "delayed-backends"
        || (scenario === "delayed-backends-release" && remainingChecks === 1)
        ? "1"
        : "0";
      if (scenario === "delayed-backends-release") {
        await sendDiagnostic({ type: "remaining", remaining, sql, values });
      }
      return { rows: [{ remaining }] };
    }
    if (sql.startsWith("drop database")) {
      dropAttempts += 1;
      if (scenario === "transient-drop") await sendDiagnostic({ type: "drop", sql });
      if (scenario === "statement-timeout-drop") {
        const requiredDropMs = 1_100;
        await new Promise((resolve) => setTimeout(resolve, Math.min(requiredDropMs, statementTimeoutMs + 25)));
        if (statementTimeoutMs < requiredDropMs) throw new Error("synthetic per-statement timeout");
      }
      if (scenario === "transient-drop" && dropAttempts === 1) {
        throw new Error("exact target still has a backend");
      }
      return { rows: [] };
    }
    if (/select exists/iu.test(sql)) {
      return { rows: [{ exists: scenario === "statement-timeout-drop" ? dropAttempts < 1 : dropAttempts < 2 }] };
    }
    throw new Error(`unexpected query: ${sql}`);
  }
}
