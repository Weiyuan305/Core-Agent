const scenario = process.env.CLEANUP_TEST_DATABASE_CHILD_SCENARIO;
let dropAttempts = 0;

export class Client {
  async connect() {}

  async end() {}

  async query(sql) {
    if (/pg_terminate_backend/iu.test(sql)) {
      return { rows: scenario === "termination-failure" ? [{ pg_terminate_backend: false }] : [] };
    }
    if (/count\(\*\)/iu.test(sql)) {
      return { rows: [{ remaining: scenario === "delayed-backends" ? "1" : "0" }] };
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
