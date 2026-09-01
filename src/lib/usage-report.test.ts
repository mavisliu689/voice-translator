import { describe, expect, it } from 'vitest';
import { buildUsageReportCsv } from './usage-report';

describe('buildUsageReportCsv', () => {
  it('exports a stable Excel-friendly daily summary per language pair', () => {
    const csv = buildUsageReportCsv({
      period: 'custom',
      from: '2026-08-01',
      to: '2026-08-02',
      daily: [
        {
          date: '2026-08-01',
          source_lang: 'zh-TW',
          target_lang: 'en',
          request_count: 3,
          total_chars: 120,
          total_cost: 0.25,
        },
        {
          date: '2026-08-01',
          source_lang: 'auto',
          target_lang: 'ja',
          request_count: 1,
          total_chars: 10,
          total_cost: 0.0002,
        },
      ],
    });
    expect(csv).toBe(
      '"日期","來源語言","目標語言","請求數","總字元數","估算費用（USD）"\r\n' +
        '"2026-08-01","繁體中文","English","3","120","0.250000"\r\n' +
        '"2026-08-01","自動偵測","Japanese","1","10","0.000200"',
    );
  });
});
