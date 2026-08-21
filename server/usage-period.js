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

const toSql = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

// UTC instant (ms) of local midnight on calendar day (y, m0, d) in `tz`; `d` may
// overflow/underflow the month. Uses the offset in effect AT that midnight, not
// at `now`: across a DST change they differ by an hour. One refinement is enough
// since midnight is never inside a DST gap for the zones we care about.
function localMidnightUtc(y, m, d, tz) {
  const wall = Date.UTC(y, m, d);
  const guess = wall - localParts(new Date(wall), tz).offset;
  return wall - localParts(new Date(guess), tz).offset;
}

// Returns the UTC 'YYYY-MM-DD HH:MM:SS' start of the period (week = Monday
// 00:00 local, month = 1st 00:00 local), or null for 'all' / unknown values.
export function periodSince(period, now = new Date(), tz = usageTz()) {
  if (period !== 'week' && period !== 'month') return null;
  const { y, m, d } = localParts(now, tz);
  const dow = (new Date(Date.UTC(y, m, d)).getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  return toSql(period === 'week' ? localMidnightUtc(y, m, d - dow, tz) : localMidnightUtc(y, m, 1, tz));
}

// Parses 'YYYY-MM-DD' into [y, m0, d]; null if malformed or not a real date.
function parseDay(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? [y, m - 1, d] : null;
}

// Inclusive local calendar-day range -> { since, until } UTC strings for
// `timestamp >= since AND timestamp < until`. null if invalid or from > to.
export function dayRange(from, to, tz = usageTz()) {
  const a = parseDay(from), b = parseDay(to);
  if (!a || !b || from > to) return null;
  return {
    since: toSql(localMidnightUtc(a[0], a[1], a[2], tz)),
    until: toSql(localMidnightUtc(b[0], b[1], b[2] + 1, tz)),
  };
}

// 'YYYY-MM' of the current month in `tz` (label only).
export function localMonth(now = new Date(), tz = usageTz()) {
  const { y, m } = localParts(now, tz);
  return `${y}-${String(m + 1).padStart(2, '0')}`;
}
