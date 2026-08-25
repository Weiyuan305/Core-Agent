// The deterministic Policy/MCP slice owns its PostgreSQL reset and lifecycle in
// one place so the workspace PostgreSQL gate and the integration gate execute
// the exact same HTTP, Python-plugin, proof-concurrency, and revocation proof.
import "../../packages/runtime-core/tests/policy-mcp-postgres.test.js";
