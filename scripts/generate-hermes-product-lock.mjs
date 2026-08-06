#!/usr/bin/env node

const versionPattern = /^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const sourceCommitPattern = /^[a-f0-9]{40}$/u;

class ReleaseError extends Error {
  constructor(code) {
    super(code);
    this.name = "ReleaseError";
  }
}

export function validateReleaseVersion(value) {
  if (typeof value !== "string" || !versionPattern.test(value) || value === "latest") {
    throw new ReleaseError("RELEASE_VERSION_INVALID");
  }
  return value;
}

export function validateSourceCommit(value) {
  if (typeof value !== "string" || !sourceCommitPattern.test(value)) {
    throw new ReleaseError("RELEASE_SOURCE_COMMIT_INVALID");
  }
  return value;
}
