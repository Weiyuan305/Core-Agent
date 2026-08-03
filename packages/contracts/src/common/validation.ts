export interface ContractViolation {
  code: string;
  path: string;
  message: string;
}

export function violation(
  code: string,
  path: string,
  message: string,
): ContractViolation {
  return { code, path, message };
}
