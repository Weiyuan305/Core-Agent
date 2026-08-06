import assert from "node:assert/strict";
import test from "node:test";

import { prepareSupervisorSocketVolume } from "../../scripts/prepare-supervisor-socket-volume.mjs";

function directory({ uid, gid, mode }) {
  return {
    uid: BigInt(uid),
    gid: BigInt(gid),
    mode: BigInt(0o040000 | mode),
    isDirectory: () => true,
  };
}

test("Supervisor socket volume initializer assigns the exact runtime identity and private mode", async () => {
  const calls = [];
  const metadata = [
    directory({ uid: 12002, gid: 12002, mode: 0o700 }),
    directory({ uid: 501, gid: 20, mode: 0o700 }),
  ];

  await prepareSupervisorSocketVolume({
    environment: {
      CORE_AGENT_RUNTIME_UID: "501",
      CORE_AGENT_SUPERVISOR_SOCKET_GID: "20",
    },
    inspect: async (path, options) => {
      calls.push(["inspect", path, options]);
      return metadata.shift();
    },
    changeOwner: async (...args) => calls.push(["chown", ...args]),
    changeMode: async (...args) => calls.push(["chmod", ...args]),
  });

  assert.deepEqual(calls, [
    ["inspect", "/run/core-agent/supervisor", { bigint: true }],
    ["chown", "/run/core-agent/supervisor", 501, 20],
    ["chmod", "/run/core-agent/supervisor", 0o700],
    ["inspect", "/run/core-agent/supervisor", { bigint: true }],
  ]);
});

test("Supervisor socket volume initializer fails closed on identities and final metadata", async () => {
  for (const environment of [
    { CORE_AGENT_RUNTIME_UID: "0", CORE_AGENT_SUPERVISOR_SOCKET_GID: "20" },
    { CORE_AGENT_RUNTIME_UID: "501", CORE_AGENT_SUPERVISOR_SOCKET_GID: "020" },
  ]) {
    await assert.rejects(
      prepareSupervisorSocketVolume({
        environment,
        inspect: async () => assert.fail("invalid identities must fail before filesystem access"),
      }),
      /Supervisor socket volume preparation failed/u,
    );
  }

  await assert.rejects(
    prepareSupervisorSocketVolume({
      environment: {
        CORE_AGENT_RUNTIME_UID: "501",
        CORE_AGENT_SUPERVISOR_SOCKET_GID: "20",
      },
      inspect: async () => directory({ uid: 501, gid: 20, mode: 0o755 }),
      changeOwner: async () => undefined,
      changeMode: async () => undefined,
    }),
    /Supervisor socket volume preparation failed/u,
  );
});
