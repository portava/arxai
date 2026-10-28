import { useEffect, useState } from "react";

interface Report {
  session_report_id: string;
  paper_session_id: string;
  status: string;
  duration_minutes: number;
  /** True while the session has not ended (duration runs to report time). */
  duration_in_progress?: boolean;
  total_trades: number;
  wins: number;
  losses: number;
  break_even: number;
  /** Closes with no recorded result. */
  unclassified?: number;
  net_pnl: number;
  /** Over closes with a recorded result; null when none has one. */
  win_rate: number | null;
  rule_violations: Array<{ code: string; limit?: number; actual?: number }>;
  mistakes_detected: Array<Record<string, unknown>>;
  lessons_generated: Array<Record<string, unknown>>;
  coach_summary: string;
  next_best_actions: string[];
  warnings: Array<Record<string, unknown>>;
}

interface Session { paper_session_id: string; status: string; }

// Pull the server's own explanation out of a failed response body
// ({ error } or a REJECTED { result: { reason } } envelope).
function serverReason(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { error?: unknown; result?: { reason?: unknown } };
  if (typeof b.error === "string" && b.error.trim()) return b.error;
  if (b.result && typeof b.result.reason === "string" && b.result.reason.trim()) return b.result.reason;
  return null;
}

async function readBody(r: Response): Promise<unknown> {
  try { return await r.json(); } catch { return null; }
}

export default function SessionReport() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  // A failed read or a refused generate is NOT "no report yet": a report may
  // exist, or generation was refused. Say which, with the server's reason.
  const [error, setError] = useState<string | null>(null);
  const [sessionsError, setSessionsError] = useState<string | null>(null);

  async function loadSessions() {
    try {
      const r = await fetch("/api/paper-sessions?limit=20");
      const d = (await readBody(r)) as { sessions?: Session[] } | null;
      if (!r.ok) {
        const why = serverReason(d);
        setSessionsError(`Could not load your paper sessions (HTTP ${r.status}${why ? `: ${why}` : ""}).`);
        return;
      }
      setSessionsError(null);
      setSessions(d?.sessions ?? []);
      if (!selected && d?.sessions?.length) setSelected(d.sessions[0].paper_session_id);
    } catch {
      setSessionsError("Could not load your paper sessions — the request did not complete.");
    }
  }
  useEffect(() => { void loadSessions(); }, []);

  async function loadReport(id: string) {
    setReport(null);
    setError(null);
    try {
      const r = await fetch(`/api/paper-sessions/${id}/report`);
      const d = (await readBody(r)) as { report?: Report } | null;
      if (r.ok && d?.report) { setReport(d.report); return; }
      const why = serverReason(d);
      // Only the route's explicit "no report yet" 404 is a true empty state.
      if (r.status === 404 && why && /no report yet/i.test(why)) return;
      setError(`Could not load the report for this session (HTTP ${r.status}${why ? `: ${why}` : ""}). A report may still exist.`);
    } catch {
      setError("Could not load the report for this session — the request did not complete. A report may still exist.");
    }
  }
  useEffect(() => { if (selected) void loadReport(selected); }, [selected]);

  async function generate() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/paper-sessions/${selected}/report`, { method: "POST", headers: { "x-security-role": "OWNER", "content-type": "application/json" }, body: "{}" });
      const d = (await readBody(r)) as { report?: Report } | null;
      if (r.ok && d?.report) { setReport(d.report); return; }
      const why = serverReason(d);
      setError(`Report was not generated (HTTP ${r.status}${why ? `: ${why}` : ""}).`);
    } catch {
      setError("Report was not generated — the request did not complete.");
    } finally { setBusy(false); }
  }

  // The breakdown must sum to the total: a close with no recorded result is
  // shown as unclassified (derived from the counts when an older server omits
  // the field), never silently dropped.
  const unclassified = report
    ? Math.max(report.unclassified ?? 0, report.total_trades - report.wins - report.losses - report.break_even, 0)
    : 0;
  const classified = report ? report.wins + report.losses + report.break_even : 0;
  const inProgress = report ? (report.duration_in_progress ?? report.status !== "COMPLETE") : false;

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Session Report</h1>
          <p className="text-sm text-muted-foreground">Reports on your paper practice sessions. These sessions place no live orders.</p>
        </div>
        <div className="flex gap-2">
          <select value={selected} onChange={e => setSelected(e.target.value)} className="border rounded px-2 py-1">
            <option value="">Select session…</option>
            {sessions.map(s => <option key={s.paper_session_id} value={s.paper_session_id}>{s.paper_session_id} ({s.status})</option>)}
          </select>
          <button onClick={() => void generate()} disabled={!selected || busy} className="px-4 py-2 rounded bg-slate-900 text-white">
            {busy ? "Generating…" : "Generate report"}
          </button>
        </div>
      </div>

      {sessionsError && <div className="text-sm text-rose-500">{sessionsError}</div>}
      {error && <div className="text-sm text-rose-500">{error}</div>}

      {report ? (
        <div className="space-y-3">
          <div className="rounded border p-4">
            <div className="text-sm text-muted-foreground">Report ID: {report.session_report_id} · Status: {report.status}</div>
            <div>Duration: {report.duration_minutes}m{inProgress ? " so far (session not ended)" : ""} · Trades: {report.total_trades} ({report.wins}W/{report.losses}L/{report.break_even}BE{unclassified > 0 ? `, ${unclassified} unclassified` : ""})</div>
            <div>Net P&L (¢): {report.net_pnl} · Win rate: {report.win_rate == null ? "not available (no close has a recorded result)" : `${report.win_rate}% of ${classified} with a recorded result`}</div>
          </div>
          <div className="rounded border p-4">
            <div className="font-semibold">Coach summary</div>
            <div className="text-sm">{report.coach_summary}</div>
          </div>
          <div className="rounded border p-4">
            <div className="font-semibold">Rule violations ({report.rule_violations.length})</div>
            {report.rule_violations.length === 0 ? <div className="text-emerald-600 text-sm">None.</div>
              : <ul className="list-disc pl-5 text-sm">{report.rule_violations.map((v,i)=><li key={i}>{v.code}: limit {v.limit} actual {v.actual}</li>)}</ul>}
          </div>
          <div className="rounded border p-4">
            <div className="font-semibold">Next best actions</div>
            <ul className="list-disc pl-5 text-sm">{report.next_best_actions.map((a,i)=><li key={i}>{a}</li>)}</ul>
          </div>
        </div>
      ) : !error ? <div className="text-sm text-muted-foreground">No report yet — pick a session and generate.</div> : null}
    </div>
  );
}
