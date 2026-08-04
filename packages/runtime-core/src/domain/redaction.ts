const secretFieldPattern = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|credential|token)/i;
const bearerPattern = /\bBearer\s+[^\s]+/gi;
const basicPattern = /\bBasic\s+[^\s]+/gi;
const credentialValuePattern = /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;

function redactString(value: string, registered: readonly string[]): string {
  let redacted = value.replace(bearerPattern, "[REDACTED]").replace(basicPattern, "[REDACTED]");
  for (const secret of registered) {
    if (secret.length > 0) redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted.replace(credentialValuePattern, "[REDACTED]");
}

function redactValue(value: unknown, registered: readonly string[]): unknown {
  if (typeof value === "string") return redactString(value, registered);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, registered));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    secretFieldPattern.test(key) ? "[REDACTED]" : redactValue(item, registered),
  ]));
}

export interface Redactor {
  redact<T>(value: T): T;
}

export function createRedactor(registeredMaterial: readonly string[]): Redactor {
  return { redact: <T>(value: T): T => redactValue(value, registeredMaterial) as T };
}

export function redactSummary(value: string, maximumLength: number, redactor: Redactor): string {
  if (!Number.isSafeInteger(maximumLength) || maximumLength < 1) throw new RangeError("maximumLength must be positive");
  return redactor.redact(value).slice(0, maximumLength);
}
