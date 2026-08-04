export type DockerFailureCode = "DEPENDENCY_UNAVAILABLE" | "DEPENDENCY_TIMEOUT";

export class BoundedDockerError extends Error {
  public constructor(
    public readonly code: DockerFailureCode,
    summary: string,
  ) {
    super(`${code}: ${summary}`);
  }
}

export function dockerFailure(code: DockerFailureCode, summary: string): BoundedDockerError {
  return new BoundedDockerError(code, summary);
}

export function redactDockerError(error: unknown): BoundedDockerError {
  if (error instanceof BoundedDockerError) return error;
  return dockerFailure("DEPENDENCY_UNAVAILABLE", "Docker runtime operation failed");
}
