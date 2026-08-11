import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const bootstrapUrl = pathToFileURL(new URL("../../scripts/bootstrap-test-database-roles.mjs", import.meta.url).pathname).href;
const bootstrap = await import(`${bootstrapUrl}?red=${Date.now()}`).catch(() => ({}));

test("test database role bootstrap uses a protected file and exact idempotent prerequisites", async (t) => {
  assert.equal(typeof bootstrap.bootstrapTestDatabaseRoles, "function");
  const root = await mkdtemp(join(tmpdir(), "core-agent-test-role-bootstrap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const passwordFile = join(root, "database-password");
  await writeFile(passwordFile, "synthetic-test-bootstrap-material-000001", { mode: 0o600 });
  await chmod(passwordFile, 0o600);
  const calls = [];
  const client = {
    connect: async () => calls.push(["connect"]),
    query: async (statement) => calls.push(["query", statement]),
    end: async () => calls.push(["end"]),
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await bootstrap.bootstrapTestDatabaseRoles({
      environment: {
        CONTROL_PLANE_TEST_DATABASE_URL: "postgresql://core_agent_ci@127.0.0.1:5432/core_agent_runtime",
        CONTROL_PLANE_TEST_DATABASE_PASSWORD_FILE: passwordFile,
      },
      clientFactory: (options) => {
        assert.equal(options.connectionString, "postgresql://core_agent_ci@127.0.0.1:5432/core_agent_runtime");
        assert.equal(options.password, "synthetic-test-bootstrap-material-000001");
        return client;
      },
    });
  }

  const statements = calls.filter(([kind]) => kind === "query").map(([, statement]) => statement);
  assert.equal(statements.length, 2);
  for (const statement of statements) {
    assert.match(statement, /CREATE ROLE core_agent_app NOLOGIN/u);
    assert.match(statement, /CREATE ROLE core_agent_identity NOLOGIN/u);
    assert.doesNotMatch(statement, /PASSWORD|core_agent_migrator|core_agent_bootstrap/u);
  }
  assert.equal(calls.filter(([kind]) => kind === "connect").length, 2);
  assert.equal(calls.filter(([kind]) => kind === "end").length, 2);
});

test("test database role bootstrap rejects unsafe connection and credential surfaces without reflection", async (t) => {
  assert.equal(typeof bootstrap.bootstrapTestDatabaseRoles, "function");
  const root = await mkdtemp(join(tmpdir(), "core-agent-test-role-rejections-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const privateValue = "synthetic-test-rejection-material-000002";
  const safe = join(root, "safe");
  await writeFile(safe, privateValue, { mode: 0o600 });
  await chmod(safe, 0o600);
  const base = {
    CONTROL_PLANE_TEST_DATABASE_URL: "postgresql://core_agent_ci@127.0.0.1:5432/core_agent_runtime",
    CONTROL_PLANE_TEST_DATABASE_PASSWORD_FILE: safe,
  };
  const cases = [
    { ...base, CONTROL_PLANE_TEST_DATABASE_URL: "postgresql://core_agent_ci:embedded@127.0.0.1:5432/core_agent_runtime" },
    { ...base, CONTROL_PLANE_TEST_DATABASE_URL: "postgresql://core_agent_ci@database.example/core_agent_runtime" },
    { ...base, CONTROL_PLANE_TEST_DATABASE_URL: "postgresql://another_role@127.0.0.1:5432/core_agent_runtime" },
    { ...base, CONTROL_PLANE_TEST_DATABASE_PASSWORD_FILE: join(root, "missing") },
  ];
  const permissive = join(root, "permissive");
  await writeFile(permissive, privateValue, { mode: 0o644 });
  cases.push({ ...base, CONTROL_PLANE_TEST_DATABASE_PASSWORD_FILE: permissive });

  for (const environment of cases) {
    await assert.rejects(
      bootstrap.bootstrapTestDatabaseRoles({ environment, clientFactory: () => assert.fail("must not connect") }),
      (error) => error?.message === "test database role bootstrap failed" && !error.message.includes(privateValue),
    );
  }
});
