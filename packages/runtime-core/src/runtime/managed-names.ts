import { createHash } from "node:crypto";

const labelPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export interface ManagedRuntimeIdentity {
  readonly tenant_id: string;
  readonly runtime_id: string;
  readonly generation: number;
}

export interface ManagedRuntimeNames {
  readonly container: string;
  readonly volume: string;
  readonly network: "core-agent-backplane";
}

export function deriveManagedRuntimeNames(
  input: ManagedRuntimeIdentity,
): ManagedRuntimeNames {
  if (
    !labelPattern.test(input.tenant_id)
    || !labelPattern.test(input.runtime_id)
    || !Number.isSafeInteger(input.generation)
    || input.generation < 1
    || input.generation > 2_147_483_647
  ) {
    throw new Error("Managed runtime identity is invalid");
  }
  const suffix = createHash("sha256")
    .update(`${input.tenant_id}\0${input.runtime_id}`)
    .digest("hex")
    .slice(0, 16);
  return Object.freeze({
    container: `core-agent-runtime-${suffix}-g${input.generation}`,
    volume: `core-agent-data-${suffix}`,
    network: "core-agent-backplane",
  });
}
