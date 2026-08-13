function failure() {
  return new Error("CI execution proof failed");
}

export function assertNodeTestSummaries(output, expectedCounts) {
  if (
    typeof output !== "string"
    || !Array.isArray(expectedCounts)
    || expectedCounts.length === 0
    || expectedCounts.some((count) => !Number.isSafeInteger(count) || count <= 0)
    || /(?:node:test|--test)[^\n]*recursive|recursive[^\n]*(?:node:test|--test)/iu.test(output)
  ) throw failure();

  const markerLines = output.match(/^(?:ℹ|#) (?:tests|pass|fail|cancelled|skipped|todo) [^\r\n]*$/gmu) ?? [];
  const summaries = [...output.matchAll(
    /^(?:ℹ|#) tests (\d+)\r?\n(?:ℹ|#) suites \d+\r?\n(?:ℹ|#) pass (\d+)\r?\n(?:ℹ|#) fail (\d+)\r?\n(?:ℹ|#) cancelled (\d+)\r?\n(?:ℹ|#) skipped (\d+)\r?\n(?:ℹ|#) todo (\d+)\r?\n(?:ℹ|#) duration_ms [^\r\n]+$/gmu,
  )].map((match) => match.slice(1, 7).map(Number));

  if (summaries.length !== expectedCounts.length || markerLines.length !== expectedCounts.length * 6) {
    throw failure();
  }
  for (const [index, [tests, pass, fail, cancelled, skipped, todo]] of summaries.entries()) {
    const expected = expectedCounts[index];
    if (tests !== expected || pass !== expected || fail !== 0 || cancelled !== 0 || skipped !== 0 || todo !== 0) {
      throw failure();
    }
  }
}
