import { describe, expect, it } from 'vitest';
import { buildUsageReportCsv } from './usage-report';

describe('buildUsageReportCsv', () => {
  it('exports a stable Excel-friendly daily summary', () => {
    const csv = buildUsageReportCsv({
      period: 'custom',
      from: '2026-08-01',
      to: '2026-08-02',
      daily: [{ date: '2026-08-01', request_count: 3, total_chars: 120, total_cost: 0.25 }],
    });
    expect(csv).toBe(
      '"日期","請求數","總字元數","估算費用（USD）"\r\n"2026-08-01","3","120","0.250000"',
    );
  });
});
