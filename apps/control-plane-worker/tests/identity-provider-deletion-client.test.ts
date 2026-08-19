import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { IdentityProviderDeletionClient } from "../src/identity-provider-deletion-client.js";

test("provider deletion uses the protected service credential transiently and treats absent users idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "core-agent-task9-provider-"));
  const keyFile = join(root, "service-role-key");
  const serviceKey = "service-role-key-material-opaque-123456789";
  await writeFile(keyFile, serviceKey, { mode: 0o600 });
  await chmod(keyFile, 0o600);
  const calls: Array<{ method: string; url: string; authorization: string | null; apikey: string | null }> = [];
  let inspection = 0;
  const client = new IdentityProviderDeletionClient({
    providerUrl: "http://127.0.0.1:54321",
    serviceRoleKeyFile: keyFile,
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      calls.push({
        method: String(init?.method), url: String(input),
        authorization: headers.get("authorization"), apikey: headers.get("apikey"),
      });
      if (init?.method === "GET") {
        inspection += 1;
        return new Response(null, { status: inspection === 1 ? 200 : 404 });
      }
      return new Response(null, { status: 404 });
    },
  });
  try {
    assert.equal(await client.inspectProviderSubject("provider_subject_01"), "present");
    assert.equal(await client.inspectProviderSubject("provider_subject_01"), "absent");
    await client.deleteProviderSubject("provider_subject_01");
    assert.deepEqual(calls.map(({ method }) => method), ["GET", "GET", "DELETE"]);
    for (const call of calls) {
      assert.equal(call.url, "http://127.0.0.1:54321/auth/v1/admin/users/provider_subject_01");
      assert.equal(call.authorization, `Bearer ${serviceKey}`);
      assert.equal(call.apikey, serviceKey);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provider deletion maps dependency bodies and credentials to fixed bounded failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "core-agent-task9-provider-failure-"));
  const keyFile = join(root, "service-role-key");
  await writeFile(keyFile, "service-role-key-material-opaque-987654321", { mode: 0o600 });
  await chmod(keyFile, 0o600);
  const client = new IdentityProviderDeletionClient({
    providerUrl: "https://provider.example.test",
    serviceRoleKeyFile: keyFile,
    fetch: async () => new Response("Bearer leaked-provider-token", { status: 503 }),
  });
  try {
    await assert.rejects(client.inspectProviderSubject("provider_subject_01"), (error: unknown) => {
      assert.equal(error instanceof Error ? error.message : "", "Identity provider deletion inspection failed");
      return true;
    });
    await assert.rejects(client.deleteProviderSubject("provider_subject_01"), (error: unknown) => {
      assert.equal(error instanceof Error ? error.message : "", "Identity provider deletion failed");
      return true;
    });
    await assert.rejects(client.inspectProviderSubject("../../unsafe"), /provider subject is invalid/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
