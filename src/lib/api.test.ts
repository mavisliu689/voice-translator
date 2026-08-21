import { describe, it, expect } from 'vitest';
import { usageSummaryQuery } from './api';

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
