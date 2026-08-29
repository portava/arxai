import { useEffect, useState } from "react";

interface Report {
  session_report_id: string;
  paper_session_id: string;
  status: string;
  duration_minutes: number;
  total_trades: number;
  wins: number;
  losses: number;
  break_even: number;
  net_pnl: number;
  win_rate: number;
  // `unit` names the scale of `limit`/`actual` so the pair can never be read
  // against each other in different units (this is where the old
  // "limit 150 actual 15000" came from — dollars against cents).
  rule_violations: Array<{ code: string; limit?: number; actual?: number; unit?: string }>;
  mistakes_detected: Array<Record<string, unknown>>;
  lessons_generated: Array<Record<string, unknown>>;
  coach_summary: string;
  next_best_actions: string[];
  warnings: Array<Record<string, unknown>>;
}

interface Session { paper_session_id: string; status: string; }

export default function SessionReport() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);

  async function loadSessions() {
    const r = await fetch("/api/paper-sessions?limit=20");
    const d = await r.json();
    setSessions(d.sessions ?? []);
    if (!selected && d.sessions?.length) setSelected(d.sessions[0].paper_session_id);
  }
  useEffect(() => { void loadSessions(); }, []);

  async function loadReport(id: string) {
    const r = await fetch(`/api/paper-sessions/${id}/report`);
    if (r.ok) { const d = await r.json(); setReport(d.report); } else setReport(null);
  }
  useEffect(() => { if (selected) void loadReport(selected); }, [selected]);

  async function generate() {
    if (!selected) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/paper-sessions/${selected}/report`, { method: "POST", headers: { "x-security-role": "OWNER", "content-type": "application/json" }, body: "{}" });
      const d = await r.json();
      setReport(d.report);
    } finally { setBusy(false); }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Session Report</h1>
          <p className="text-sm text-muted-foreground">Build PP — demo-only session reporting. Live trading remains DISABLED.</p>
        </div>
        <div className="flex gap-2">
          <select value={selected} onChange={e => setSelected(e.target.value)} className="border rounded px-2 py-1">
            <option value="">Select session…</option>
            {sessions.map(s => <option key={s.paper_session_id} value={s.paper_session_id}>{s.paper_session_id} ({s.status})</option>)}
          </select>
          <button onClick={() => void generate()} disabled={!selected || busy} className="px-4 py-2 rounded bg-card text-white">
            {busy ? "Generating…" : "Generate report"}
          </button>
        </div>
      </div>

      {report ? (
        <div className="space-y-3">
          <div className="rounded border p-4">
            <div className="text-sm text-muted-foreground">Report ID: {report.session_report_id} · Status: {report.status}</div>
            <div>Duration: {report.duration_minutes}m · Trades: {report.total_trades} ({report.wins}W/{report.losses}L/{report.break_even}BE)</div>
            <div>Net P&L: {(report.net_pnl / 100).toFixed(2)} USD · Win rate: {report.win_rate}%</div>
          </div>
          <div className="rounded border p-4">
            <div className="font-semibold">Coach summary</div>
            <div className="text-sm">{report.coach_summary}</div>
          </div>
          <div className="rounded border p-4">
            <div className="font-semibold">Rule violations ({report.rule_violations.length})</div>
            {report.rule_violations.length === 0 ? <div className="text-success text-sm">None.</div>
              : <ul className="list-disc pl-5 text-sm">{report.rule_violations.map((v,i)=><li key={i}>{v.code}: limit {v.limit}{v.unit ? ` ${v.unit}` : ""} · actual {v.actual}{v.unit ? ` ${v.unit}` : ""}</li>)}</ul>}
          </div>
          <div className="rounded border p-4">
            <div className="font-semibold">Next best actions</div>
            <ul className="list-disc pl-5 text-sm">{report.next_best_actions.map((a,i)=><li key={i}>{a}</li>)}</ul>
          </div>
        </div>
      ) : <div className="text-sm text-muted-foreground">No report yet — pick a session and generate.</div>}
    </div>
  );
}
