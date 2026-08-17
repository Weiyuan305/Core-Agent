const scenario = process.env.CLEANUP_TEST_DATABASE_CHILD_SCENARIO;
let dropAttempts = 0;
let remainingChecks = 0;

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
  async connect() {}

  async end() {}

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
      if (scenario === "transient-drop" && dropAttempts === 1) {
        throw new Error("exact target still has a backend");
      }
      return { rows: [] };
    }
    if (/select exists/iu.test(sql)) {
      return { rows: [{ exists: dropAttempts >= 2 ? false : true }] };
    }
    throw new Error(`unexpected query: ${sql}`);
  }
}
