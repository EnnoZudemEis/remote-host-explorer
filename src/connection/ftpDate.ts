const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * Parses the date column of a Unix-style FTP LIST line ("Nov 17 09:30" or
 * "Nov 17  2024") into ms since epoch. The server timezone is unknown, so the
 * value is interpreted as UTC; use the server's `timeOffsetMinutes` to correct.
 * Entries with a time but no year are assumed to lie within the last year.
 */
export function parseListDate(raw: string | undefined, now: Date = new Date()): number | undefined {
  if (!raw) return undefined;
  const m = /^([A-Za-z]{3})\s+(\d{1,2})\s+(?:(\d{1,2}):(\d{2})|(\d{4}))$/.exec(raw.trim());
  if (!m) return undefined;
  const month = MONTHS.indexOf(m[1].toLowerCase());
  if (month < 0) return undefined;
  const day = Number(m[2]);
  if (m[5]) return Date.UTC(Number(m[5]), month, day);
  let ts = Date.UTC(now.getUTCFullYear(), month, day, Number(m[3]), Number(m[4]));
  // A date more than a day in the future must belong to the previous year.
  if (ts > now.getTime() + 86400000) ts = Date.UTC(now.getUTCFullYear() - 1, month, day, Number(m[3]), Number(m[4]));
  return ts;
}
