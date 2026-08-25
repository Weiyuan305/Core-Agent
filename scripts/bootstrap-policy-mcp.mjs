import { readFile } from "node:fs/promises";

import { createRuntimeDatabase, bootstrapBuiltinPolicy } from "@core-agent/runtime-core";
import { Pool } from "pg";

const databaseUrl = process.env.CONTROL_PLANE_DATABASE_URL;
const reviewerActorId = process.env.POLICY_MCP_REVIEWER_ACTOR_ID;
if (databaseUrl === undefined || reviewerActorId === undefined) throw new Error("Policy MCP bootstrap configuration is incomplete");
const document = JSON.parse(await readFile(new URL("../infra/policy-mcp/synthetic-bindings.json", import.meta.url), "utf8"));
const db = createRuntimeDatabase(new Pool({ connectionString: databaseUrl }));
try {
  await bootstrapBuiltinPolicy(db, reviewerActorId, document);
  process.stdout.write("Policy MCP catalog is ready\n");
} finally {
  await db.destroy();
}
