// Period boundaries for /api/usage/summary.
//
// `translations.timestamp` is written by SQLite's datetime('now') => UTC
// 'YYYY-MM-DD HH:MM:SS'. Admins think in local (Taiwan) calendar days, so
// "this week" / "this month" start at local midnight, converted back to UTC
// in the same string format so it compares correctly against the column.

// Read at call time (not import time): index.js runs dotenv.config() after its
// static imports, so a module-level constant would never see server/.env.
const usageTz = () => process.env.USAGE_TZ || 'Asia/Taipei';

const fmts = new Map();
function fmtFor(tz) {
  if (!fmts.has(tz)) {
    fmts.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
      hourCycle: 'h23',
    }));
  }
  return fmts.get(tz);
}

// Local calendar fields of `instant` in `tz` plus the UTC offset in effect (ms).
function localParts(instant, tz) {
  const p = {};
  for (const { type, value } of fmtFor(tz).formatToParts(instant)) p[type] = value;
  const asUtc = Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return { y: +p.year, m: p.month - 1, d: +p.day, offset: asUtc - instant.getTime() };
}

// Returns the UTC 'YYYY-MM-DD HH:MM:SS' start of the period (week = Monday
// 00:00 local, month = 1st 00:00 local), or null for 'all' / unknown values.
export function periodSince(period, now = new Date(), tz = usageTz()) {
  if (period !== 'week' && period !== 'month') return null;
  const { y, m, d, offset } = localParts(now, tz);
  const dow = (new Date(Date.UTC(y, m, d)).getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  const startLocal = period === 'week' ? Date.UTC(y, m, d - dow) : Date.UTC(y, m, 1);
  // Use the offset in effect AT the period start, not now: across a DST change
  // they differ by an hour. One refinement is enough since midnight is never
  // inside a DST gap for the zones we care about.
  const guess = startLocal - offset;
  const start = startLocal - localParts(new Date(guess), tz).offset;
  return new Date(start).toISOString().slice(0, 19).replace('T', ' ');
}

// 'YYYY-MM' of the current month in `tz` (label only).
export function localMonth(now = new Date(), tz = usageTz()) {
  const { y, m } = localParts(now, tz);
  return `${y}-${String(m + 1).padStart(2, '0')}`;
}
