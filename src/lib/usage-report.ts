import type { UsageHistory } from '../types';

const csvCell = (value: string | number) => `"${String(value).replace(/"/g, '""')}"`;

export function buildUsageReportCsv(history: UsageHistory): string {
  const header = ['日期', '請求數', '總字元數', '估算費用（USD）'];
  const rows = history.daily.map((row) => [
    row.date,
    row.request_count,
    row.total_chars,
    row.total_cost.toFixed(6),
  ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
}

export function downloadUsageReport(history: UsageHistory): void {
  const blob = new Blob(['\uFEFF', buildUsageReportCsv(history)], {
    type: 'text/csv;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `翻譯用量日報_${history.from}_${history.to}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
