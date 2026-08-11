import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function method(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, start);
  return source.slice(from, source.indexOf(end, from + start.length));
}

function ordered(source: string, fragments: readonly string[]): void {
  let offset = 0;
  for (const fragment of fragments) {
    const next = source.indexOf(fragment, offset);
    assert.notEqual(next, -1, `missing or reversed lock fragment: ${fragment}`);
    offset = next + fragment.length;
  }
}

test("provision completion and Conversation admission share tenant profile runtime job lock order", async () => {
  const worker = await readFile(join(root, "repositories", "worker-runtime.ts"), "utf8");
  const conversation = await readFile(join(root, "services", "create-conversation.ts"), "utf8");
  const finish = method(worker, "public async finishProvision", "public async failProvisionJob");
  const create = method(conversation, "return serializable", "const conversation:");

  assert.match(finish, /selectFrom\("profiles"\)\.select\("profile_id"\)[\s\S]*provisionTransaction/);
  ordered(finish, [
    'selectFrom("tenants")', '.forUpdate()',
    'selectFrom("profiles")', '.orderBy("profile_id")', '.forUpdate()',
    'selectFrom("runtime_containers")', '.forUpdate()',
    'selectFrom("worker_jobs")', '.forUpdate()',
  ]);
  assert.match(finish, /claimed\.job_kind !== "provision_runtime"[\s\S]*claimed\.payload_ref !== job\.runtimeId[\s\S]*claimed\.container_id !== job\.runtimeId[\s\S]*claimed\.effect_state !== "pre_effect"/);
  ordered(create, [
    'selectFrom("tenants")', '.forShare()',
    'selectFrom("profiles")', '.forShare()',
    'selectFrom("runtime_containers")', '.forShare()',
  ]);
});

test("tenant provisioning locks global Actor authority before Tenant Membership and Profile", async () => {
  const provision = await readFile(join(root, "services", "provision-tenant.ts"), "utf8");
  const resources = await readFile(join(root, "repositories", "resources.ts"), "utf8");
  const transaction = method(provision, "return serializable", "const secretReferences");
  const actorInsert = method(resources, "public async insert(actor", "public async find(actorId");

  ordered(transaction, [
    "const actors = [",
    "...graph.actors",
    "actor_id: context.actorId",
    "].sort(compareActorIds)",
    "for (const actor of actors)",
    "repositories.actors.insert",
    'insertInto("tenants")',
    "repositories.memberships.insert",
    "repositories.profiles.insert",
  ]);
  assert.match(actorInsert, /selectFrom\("actors"\)[\s\S]*\.forNoKeyUpdate\(\)/);
});

test("every Agent Run transaction that locks a run follows conversation run worker-job order", async () => {
  const source = await readFile(join(root, "repositories", "worker-agent-run.ts"), "utf8");
  for (const [start, end] of [
    ["public async begin", "public async persistDelta"],
    ["public async persistDelta", "public async markDispatched"],
    ["public async markDispatched", "public async complete"],
    ["public async complete", "public async retry"],
    ["public async fail", "\n  }\n}"],
  ] as const) {
    const body = method(source, start, end);
    ordered(body, [
      "resolveRunConversationId",
      'selectFrom("conversations")', '.forUpdate()',
      'selectFrom("agent_runs")', '.forUpdate()',
      "lockedOwnedJob",
    ]);
    assert.match(body, /run\.conversation_id !== conversationId/);
  }
});
