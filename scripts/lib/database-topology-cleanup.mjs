export async function settleTopologyScenario(scenarioFailure, stages) {
  const cleanupFailures = [];
  for (const stage of stages) {
    try {
      await stage.work();
    } catch {
      cleanupFailures.push(stage.category);
    }
  }
  if (cleanupFailures.length > 0) {
    const prefix = scenarioFailure === undefined
      ? "Database topology cleanup failed"
      : "Database topology scenario failed; cleanup failed";
    const error = new Error(
      `${prefix}: ${cleanupFailures.join(", ")}`,
      scenarioFailure === undefined ? undefined : { cause: scenarioFailure },
    );
    Object.defineProperty(error, "cleanupFailures", {
      configurable: false,
      enumerable: true,
      value: Object.freeze([...cleanupFailures]),
      writable: false,
    });
    throw error;
  }
  if (scenarioFailure !== undefined) {
    throw scenarioFailure instanceof Error
      ? scenarioFailure
      : new Error("Database topology scenario failed");
  }
}
