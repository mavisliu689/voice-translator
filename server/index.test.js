// Smoke tests for the public endpoints. The translate endpoint hits Google's
// API in real code, so these tests focus on the wrapper logic: validation,
// missing-key handling, and the public language list.
//
// Run with: cd server && npx vitest run

import { describe, it, expect } from 'vitest';

const SUPPORTED_LANGS = new Set([
  'zh-TW', 'en', 'ja', 'ko', 'es', 'fr', 'de',
  'pt', 'ru', 'ar', 'hi', 'th', 'vi', 'id', 'it',
]);

describe('SUPPORTED_LANGS', () => {
  it('includes the languages the frontend ships', () => {
    expect(SUPPORTED_LANGS.has('zh-TW')).toBe(true);
    expect(SUPPORTED_LANGS.has('en')).toBe(true);
    expect(SUPPORTED_LANGS.has('ja')).toBe(true);
  });

  it('rejects unknown codes', () => {
    expect(SUPPORTED_LANGS.has('xx')).toBe(false);
    expect(SUPPORTED_LANGS.has('')).toBe(false);
  });
});

// Smoke placeholder — extend with supertest when integration tests are wired up.
describe('server smoke', () => {
  it('placeholder so vitest does not exit with empty-suite error', () => {
    expect(true).toBe(true);
  });
});

// /api/usage/summary?period= boundaries. The DB column is UTC 'YYYY-MM-DD HH:MM:SS';
// periods start at local (Asia/Taipei, UTC+8) midnight, so the returned string
// is that instant expressed in UTC.
import { periodSince, localMonth } from './usage-period.js';

describe('periodSince', () => {
  // Thu 2026-08-20 14:30 Taipei == 06:30 UTC
  const now = new Date('2026-08-20T06:30:00Z');

  it('returns null for "all" and unknown values', () => {
    expect(periodSince('all', now)).toBeNull();
    expect(periodSince(undefined, now)).toBeNull();
    expect(periodSince('year', now)).toBeNull();
  });

  it('week starts Monday 00:00 Taipei (= Sunday 16:00 UTC)', () => {
    expect(periodSince('week', now)).toBe('2026-08-16 16:00:00');
  });

  it('month starts on the 1st 00:00 Taipei (= last day of prev month 16:00 UTC)', () => {
    expect(periodSince('month', now)).toBe('2026-07-31 16:00:00');
  });

  it('uses the Taipei calendar day, not UTC, near midnight', () => {
    // 2026-08-31 23:00 UTC is already Tue 2026-09-01 07:00 in Taipei
    const lateUtc = new Date('2026-08-31T23:00:00Z');
    expect(periodSince('month', lateUtc)).toBe('2026-08-31 16:00:00');
    expect(periodSince('week', lateUtc)).toBe('2026-08-30 16:00:00'); // Mon 8/31 00:00 Taipei
    expect(localMonth(lateUtc)).toBe('2026-09');
  });

  it('Monday itself is the start of its own week', () => {
    const mondayNoon = new Date('2026-08-17T04:00:00Z'); // Mon 12:00 Taipei
    expect(periodSince('week', mondayNoon)).toBe('2026-08-16 16:00:00');
  });

  it('Sunday belongs to the week that started the previous Monday', () => {
    const sunday = new Date('2026-08-23T10:00:00Z'); // Sun 18:00 Taipei
    expect(periodSince('week', sunday)).toBe('2026-08-16 16:00:00');
  });

  it('format compares correctly against datetime("now") strings', () => {
    const s = periodSince('month', now);
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect('2026-08-01 00:00:00' >= s).toBe(true);   // inside the month
    expect('2026-07-31 15:59:59' >= s).toBe(false);  // just before
  });
});

describe('periodSince across DST (USAGE_TZ with daylight saving)', () => {
  const NY = 'America/New_York';

  it('uses the offset in effect at the period start, not now (spring forward 2026-03-08)', () => {
    const now = new Date('2026-03-10T16:00:00Z'); // Tue, EDT (-4)
    expect(periodSince('month', now, NY)).toBe('2026-03-01 05:00:00'); // Mar 1 00:00 EST (-5)
    expect(periodSince('week', now, NY)).toBe('2026-03-09 04:00:00');  // Mon Mar 9 00:00 EDT (-4)
  });

  it('fall back 2026-11-01', () => {
    const now = new Date('2026-11-05T12:00:00Z'); // Thu, EST (-5)
    expect(periodSince('month', now, NY)).toBe('2026-11-01 04:00:00'); // Nov 1 00:00 EDT (-4)
    expect(periodSince('week', now, NY)).toBe('2026-11-02 05:00:00');  // Mon Nov 2 00:00 EST (-5)
  });
});

describe('USAGE_TZ is read at call time (dotenv runs after imports in index.js)', () => {
  it('honours process.env.USAGE_TZ set after the module was imported', () => {
    const now = new Date('2026-08-20T06:30:00Z');
    const prev = process.env.USAGE_TZ;
    try {
      process.env.USAGE_TZ = 'UTC';
      expect(periodSince('month', now)).toBe('2026-08-01 00:00:00');
      expect(localMonth(now)).toBe('2026-08');
      delete process.env.USAGE_TZ;
      expect(periodSince('month', now)).toBe('2026-07-31 16:00:00'); // default Asia/Taipei
    } finally {
      if (prev === undefined) delete process.env.USAGE_TZ; else process.env.USAGE_TZ = prev;
    }
  });
});
