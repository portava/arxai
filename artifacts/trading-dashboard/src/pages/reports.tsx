// Phase 11E — Reporting Center page.
// Lists user's report history; lets them generate new reports (CSV/JSON/HTML),
// download, delete. First-time empty state included.
import { useEffect, useState } from "react";
import { FileText } from "lucide-react";
import { cn } from "@/lib/utils";

const REPORT_TYPES = [
  ["account_summary", "Account Summary"],
  ["trading_session_summary", "Trading Session Summary"],
  ["paper_trades", "Demo Trades"],
  ["performance_calendar", "Performance Calendar"],
  ["trade_journal", "Trade Journal"],
  ["ai_trade_reviews", "AI Trade Reviews"],
  ["risk_governor", "Risk Governor"],
  ["playbook_performance", "Playbook Performance"],
  ["coaching_summary", "Coaching Summary"],
  ["full_trading_archive", "Full Trading Archive"],
] as const;
const FORMATS = [["json", "JSON"], ["csv", "CSV"], ["html", "HTML (PDF fallback)"]] as const;

type ReportRow = {
  id: number; reportType: string; format: string; status: string; title: string;
  fileName: string | null; fileSize: number | null; rowCount: number | null;
  downloadUrl: string | null; errorMessage: string | null;
  createdAt: string; completedAt: string | null;
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { credentials: "include", ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  return r.json() as Promise<T>;
}

export default function ReportsPage() {
  const [reports, setReports] = useState<ReportRow[]>([]);
  const [emptyHints, setEmptyHints] = useState<string[]>([]);
  const [reportType, setReportType] = useState<string>("paper_trades");
  const [format, setFormat] = useState<string>("csv");
  const [dateRangeStart, setStart] = useState("");
  const [dateRangeEnd, setEnd] = useState("");
  const [symbol, setSymbol] = useState("");
  const [strategyTag, setStrategy] = useState("");
  const [status, setStatus] = useState("");
  const [includeJournal, setIncJ] = useState(true);
  const [includeAIReviews, setIncR] = useState(true);
  const [includeRiskEvents, setIncE] = useState(true);
  const [includePlaybooks, setIncP] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    const r = await api<{ reports: ReportRow[]; isEmpty: boolean; emptyHints: string[] }>("/api/me/reports");
    setReports(r.reports ?? []);
    setEmptyHints(r.emptyHints ?? []);
  }
  useEffect(() => { void refresh(); }, []);

  async function generate() {
    setBusy(true); setErr(null);
    try {
      const r = await api<{ report?: ReportRow; error?: string }>("/api/me/reports/generate", {
        method: "POST",
        body: JSON.stringify({
          reportType, format,
          dateRangeStart: dateRangeStart || null,
          dateRangeEnd: dateRangeEnd || null,
          symbol: symbol || null, strategyTag: strategyTag || null, status: status || null,
          includeJournal, includeAIReviews, includeRiskEvents, includePlaybooks,
          includeCalendar: true,
        }),
      });
      if (r.error) setErr(r.error);
      await refresh();
    } finally { setBusy(false); }
  }

  async function del(id: number) {
    await fetch(`/api/me/reports/${id}`, { method: "DELETE", credentials: "include" });
    await refresh();
  }

  return (
    <div className="mx-auto w-full max-w-[1280px] space-y-4 pb-32 md:pb-6" data-testid="reports-page">
      {/* Hero */}
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/25">
          <FileText className="h-5 w-5" />
        </span>
        <div>
          <h1 className="text-2xl font-bold leading-tight">Reports</h1>
          <p className="text-sm text-txt-secondary">Generate account, trade, and performance reports. Read-only — not financial advice.</p>
        </div>
      </div>

      {/* Generate */}
      <div className="rounded-2xl border border-border bg-card p-4">
        <h2 className="mb-3 text-sm font-semibold">Generate Report</h2>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Field label="Report type">
            <select className={selectCls} value={reportType} onChange={(e) => setReportType(e.target.value)} data-testid="report-type-select">
              {REPORT_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </Field>
          <Field label="Format">
            <select className={selectCls} value={format} onChange={(e) => setFormat(e.target.value)} data-testid="report-format-select">
              {FORMATS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </Field>
          <Field label="Symbol (optional)">
            <input className={inputCls} placeholder="EURUSD" value={symbol} onChange={(e) => setSymbol(e.target.value)} />
          </Field>
          <Field label="Date range start">
            <input type="date" className={inputCls} value={dateRangeStart} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field label="Date range end">
            <input type="date" className={inputCls} value={dateRangeEnd} onChange={(e) => setEnd(e.target.value)} />
          </Field>
          <Field label="Strategy tag">
            <input className={inputCls} placeholder="BOS" value={strategyTag} onChange={(e) => setStrategy(e.target.value)} />
          </Field>
          <Field label="Status filter">
            <select className={selectCls} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Any</option><option value="closed">closed</option><option value="open">open</option>
              <option value="cancelled">cancelled</option><option value="planned">planned</option>
            </select>
          </Field>
        </div>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-sm text-txt-secondary">
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={includeJournal} onChange={(e) => setIncJ(e.target.checked)} />Include journal</label>
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={includeAIReviews} onChange={(e) => setIncR(e.target.checked)} />Include AI reviews</label>
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={includeRiskEvents} onChange={(e) => setIncE(e.target.checked)} />Include risk events</label>
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={includePlaybooks} onChange={(e) => setIncP(e.target.checked)} />Include playbooks</label>
        </div>
        <button className="mt-4 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50"
                disabled={busy} onClick={() => void generate()} data-testid="generate-report-btn">
          {busy ? "Generating…" : "Generate report"}
        </button>
        {err && <div className="mt-2 text-sm text-danger">{err}</div>}
      </div>

      {/* History */}
      <div className="rounded-2xl border border-border bg-card p-4">
        <h2 className="mb-3 text-sm font-semibold">Report History</h2>
        {reports.length === 0 ? (
          <div className="space-y-1 py-4 text-sm text-txt-muted" data-testid="reports-empty-state">
            {(emptyHints.length ? emptyHints : ["No reports yet.", "Your reports will appear here once generated."]).map((h) => <div key={h}>{h}</div>)}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-border text-left text-xs text-txt-muted">
                <th className="py-2 pr-3 font-medium">Title</th><th className="py-2 pr-3 font-medium">Type</th><th className="py-2 pr-3 font-medium">Format</th>
                <th className="py-2 pr-3 font-medium">Status</th><th className="py-2 pr-3 font-medium">Rows</th><th className="py-2 pr-3 font-medium">Created</th><th></th>
              </tr></thead>
              <tbody>
                {reports.map((r) => (
                  <tr key={r.id} className="border-b border-border/50 last:border-0" data-testid={`report-row-${r.id}`}>
                    <td className="py-2.5 pr-3 text-foreground">{r.title}</td>
                    <td className="py-2.5 pr-3 text-txt-secondary">{r.reportType}</td>
                    <td className="py-2.5 pr-3 uppercase text-txt-muted">{r.format}</td>
                    <td className="py-2.5 pr-3">
                      <span className={cn("rounded-md border px-1.5 py-0.5 text-[10px] font-semibold",
                        r.status === "completed" ? "border-success/40 bg-success/10 text-success"
                        : r.status === "failed" ? "border-danger/40 bg-danger/10 text-danger"
                        : "border-warning/40 bg-warning/10 text-warning")}>{r.status}</span>
                      {r.errorMessage ? <span className="ml-1 text-[11px] text-txt-muted">{r.errorMessage}</span> : null}
                    </td>
                    <td className="py-2.5 pr-3 text-txt-secondary">{r.rowCount ?? 0}</td>
                    <td className="py-2.5 pr-3 text-txt-muted">{new Date(r.createdAt).toLocaleString()}</td>
                    <td className="py-2.5 text-right">
                      {r.downloadUrl && r.status === "completed" && (
                        <a className="mr-3 text-primary hover:underline" href={r.downloadUrl} download={r.fileName ?? undefined}>Download</a>
                      )}
                      <button className="text-danger hover:underline" onClick={() => void del(r.id)} data-testid={`delete-report-${r.id}`}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

const selectCls = "rounded-lg border border-border bg-background/40 px-2.5 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary";
const inputCls = "rounded-lg border border-border bg-background/40 px-2.5 py-1.5 text-sm text-foreground placeholder:text-txt-muted focus:outline-none focus:ring-2 focus:ring-primary";
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-txt-secondary">
      <span>{label}</span>
      {children}
    </label>
  );
}
