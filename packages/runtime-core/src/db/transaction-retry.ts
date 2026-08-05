import type { Kysely, Transaction } from "kysely";

import type { RuntimeDatabase } from "./database.js";

const maximumAttempts = 3;

export class DatabaseTransactionRetryExhaustedError extends Error {
  public constructor() { super("Database concurrency retry exhausted"); }
}

export class DatabaseTransactionRetryAbortedError extends Error {
  public constructor() { super("Database transaction retry aborted"); }
}

function ownStringData(value: unknown, key: string): string | undefined {
  try {
    if (typeof value !== "object" || value === null) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string"
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

export function isRetryableDatabaseTransactionError(error: unknown): boolean {
  const code = ownStringData(error, "code");
  return code === "40P01" || code === "40001";
}

export function isDatabaseTransactionRetryExhaustedError(error: unknown): error is DatabaseTransactionRetryExhaustedError {
  return error instanceof DatabaseTransactionRetryExhaustedError;
}

export async function withDatabaseTransactionRetry<T>(
  db: Kysely<RuntimeDatabase>,
  work: (trx: Transaction<RuntimeDatabase>) => Promise<T>,
  options: { readonly isolationLevel?: "serializable"; readonly signal?: AbortSignal } = {},
): Promise<T> {
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    if (options.signal?.aborted) throw new DatabaseTransactionRetryAbortedError();
    try {
      const transaction = db.transaction();
      const configured = options.isolationLevel === undefined
        ? transaction
        : transaction.setIsolationLevel(options.isolationLevel);
      return await configured.execute(work);
    } catch (error) {
      if (!isRetryableDatabaseTransactionError(error)) throw error;
      if (attempt === maximumAttempts) throw new DatabaseTransactionRetryExhaustedError();
    }
  }
  throw new DatabaseTransactionRetryExhaustedError();
}
