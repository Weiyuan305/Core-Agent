const utcTimestampPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/u;

function leapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/**
 * Parses the closed UTC subset emitted by Supabase/PostgreSQL: an RFC3339
 * calendar timestamp ending in `Z`, with zero through nine fractional digits.
 * The returned epoch is truncated to milliseconds because JavaScript Date and
 * the pg driver expose millisecond precision at this boundary.
 */
export function strictUtcTimestampMilliseconds(value: string): number | undefined {
  const match = utcTimestampPattern.exec(value);
  if (match === null) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] ?? "";
  const days = [31, leapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]!
    || hour > 23 || minute > 59 || second > 59) return undefined;
  const milliseconds = fraction.length === 0 ? "000" : `${fraction}000`.slice(0, 3);
  const normalized = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${milliseconds}Z`;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}
