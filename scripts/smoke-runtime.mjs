#!/usr/bin/env node

const port = process.env.CORE_AGENT_API_SERVER_PORT ?? "18642";
const apiKey = process.env.CORE_AGENT_API_SERVER_KEY;
const baseUrl = `http://127.0.0.1:${port}`;

if (!apiKey) {
  process.stderr.write(
    "CORE_AGENT_API_SERVER_KEY is required; load .env.runtime before running smoke tests\n"
  );
  process.exit(1);
}

async function request(path, { authenticated = true } = {}) {
  const headers = authenticated
    ? { authorization: `Bearer ${apiKey}` }
    : {};
  return fetch(`${baseUrl}${path}`, { headers });
}

async function expectStatus(path, expectedStatuses, options) {
  const allowedStatuses = Array.isArray(expectedStatuses)
    ? expectedStatuses
    : [expectedStatuses];
  const response = await request(path, options);
  if (!allowedStatuses.includes(response.status)) {
    const body = await response.text();
    throw new Error(
      `${path}: expected ${allowedStatuses.join(" or ")}, received ${response.status}: ${body}`
    );
  }
  return response;
}

await expectStatus("/health", 200, { authenticated: false });
await expectStatus("/v1/models", [401, 403], { authenticated: false });
await expectStatus("/v1/models", 200);

for (const profile of ["consultant-a", "consultant-b"]) {
  const response = await expectStatus(`/p/${profile}/v1/models`, 200);
  const payload = await response.json();
  if (!Array.isArray(payload.data) || payload.data.length === 0) {
    throw new Error(`${profile}: /v1/models returned no models`);
  }
}

process.stdout.write("Core-Agent Hermes runtime smoke test passed\n");
