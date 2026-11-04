// Small client-side CSV helpers. Only data already on screen is written; no
// request is made.

export type CsvValue = string | number | boolean | null | undefined;

export function csvCell(v: CsvValue): string {
  const s = v == null ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: CsvValue[][]): string {
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
}

export function csvTimestamp(d: Date = new Date()): string {
  return d.toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

export function downloadCsv(filename: string, rows: CsvValue[][]): void {
  const blob = new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
