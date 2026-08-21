import { describe, it, expect } from 'vitest';
import { usageSummaryQuery, appendRecords } from './api';

describe('usageSummaryQuery', () => {
  it('maps presets to ?period= and "all" to no query', () => {
    expect(usageSummaryQuery('week')).toBe('?period=week');
    expect(usageSummaryQuery('month')).toBe('?period=month');
    expect(usageSummaryQuery('all')).toBe('');
  });

  it('sends from/to for a custom range and nothing without one', () => {
    expect(usageSummaryQuery('custom', { from: '2026-08-01', to: '2026-08-20' })).toBe('?from=2026-08-01&to=2026-08-20');
    expect(usageSummaryQuery('custom')).toBe('');
  });
});

describe('appendRecords', () => {
  const rec = (id: number) => ({ id, timestamp: '', source_lang: 'en', target_lang: 'ja', char_count: 1, estimated_cost_usd: 0 });
  it('appends new rows and drops ids already shown (offset shifted by a new translation)', () => {
    const merged = appendRecords([rec(5), rec(4)], [rec(4), rec(3), rec(2)]);
    expect(merged.map((r) => r.id)).toEqual([5, 4, 3, 2]);
  });
});
