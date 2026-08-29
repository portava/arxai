import { useEffect, useState } from "react";

interface CoachReport {
  coach_report_id: string;
  generated_at: string;
  liveTradingStatus: string;
  reportType: string;
  traderStatus: {
    readinessScore: number;
    readinessGrade: string;
    readinessLevel: string;
    governorStatus: string;
    paperTradingAllowed: boolean;
    autopilotAllowed: boolean;
    liveTradingAllowed: boolean;
  };
  performanceSummary: Record<string, unknown>;
  topStrengths: string[];
  topWeaknesses: string[];
  repeatedMistakes: { tag: string; count: number; severity: number; symbol: string; recommendedGuardrail: string }[];
  activeRiskFlags: { code: string; message: string; severity?: string }[];
  currentFocusAreas: string[];
  nextBestActions: string[];
  preSessionChecklist: { id: string; label: string; required: boolean; auto?: boolean }[];
  postSessionReviewQuestions: string[];
  warnings: string[];
  coachingSummary: string;
}

interface PlaybookEntry {
  id: number;
  playbookEntryId: string;
  title: string;
  status: string;
  symbol: string;
  setupName: string;
  actionBias: string;
  confidenceLevel: string;
  sampleSize: number;
  winRate: number;
  edgeScore: number;
  avgPnl: number;
  mistakeWarnings: unknown[];
}

interface WeeklyPlan {
  week_start: string;
  week_end: string;
  mainGoal: string;
  focusAreas: string[];
  rulesToPractice: string[];
  mistakesToReduce: string[];
  setupsToStudy: string[];
  setupsToAvoid: string[];
  paperTradingTargets: { maxTradesPerDay: number; maxLossPerDay: number; requiredDebriefs: number };
  successCriteria: string[];
  warnings: string[];
}

const STATUS_BADGE: Record<string, string> = {
  ACTIVE: "bg-success text-white",
  WATCHLIST: "bg-warning text-black",
  REVIEW: "bg-warning text-white",
  AVOID: "bg-danger text-white",
};

const GOV_BADGE: Record<string, string> = {
  PAPER_ALLOWED: "bg-success text-white",
  PAPER_CAUTION: "bg-warning text-black",
  PAPER_PAUSED: "bg-warning text-white",
  WATCH_ONLY: "bg-danger text-white",
  LOCKED: "bg-danger/15 text-white",
  UNKNOWN: "bg-muted text-white",
};

export default function TraderCoachPage() {
  const [coach, setCoach] = useState<CoachReport | null>(null);
  const [playbook, setPlaybook] = useState<PlaybookEntry[]>([]);
  const [weekly, setWeekly] = useState<WeeklyPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  async function loadAll() {
    setLoading(true); setErr(null);
    try {
      const base = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");
      const [c, p, w] = await Promise.all([
        fetch(`${base}/api/trader-coach/status`).then(r => r.json()),
        fetch(`${base}/api/trader-coach/playbook?limit=200`).then(r => r.json()),
        fetch(`${base}/api/trader-coach/weekly`).then(r => r.json()),
      ]);
      setCoach(c.coach);
      setPlaybook(p.playbook ?? []);
      setWeekly(w.weekly);
    } catch (e) {
      setErr(String(e).slice(0, 200));
    } finally {
      setLoading(false);
    }
  }

  async function regeneratePlaybook() {
    const base = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");
    await fetch(`${base}/api/trader-coach/playbook/generate`, { method: "POST" });
    await loadAll();
  }

  useEffect(() => { void loadAll(); }, []);

  if (loading) return <div className="text-txt-secondary">Loading Trader Coach…</div>;
  if (err) return <div className="text-danger">Failed to load: {err}</div>;
  if (!coach) return <div>No coach data.</div>;

  const govBadge = GOV_BADGE[coach.traderStatus.governorStatus] ?? GOV_BADGE.UNKNOWN;

  return (
    <div className="space-y-6 text-foreground">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">Trader Coach</h1>
        <span className="px-2 py-1 rounded text-xs bg-primary/15">DEMO ONLY</span>
        <span className="px-2 py-1 rounded text-xs bg-muted">LIVE TRADING DISABLED</span>
        <span className={`px-2 py-1 rounded text-xs ${govBadge}`}>Governor: {coach.traderStatus.governorStatus === "PAPER_ALLOWED" ? "DEMO_ALLOWED" : coach.traderStatus.governorStatus === "PAPER_CAUTION" ? "DEMO_CAUTION" : coach.traderStatus.governorStatus === "PAPER_PAUSED" ? "DEMO_PAUSED" : coach.traderStatus.governorStatus}</span>
        <span className="px-2 py-1 rounded text-xs bg-muted">
          Readiness {coach.traderStatus.readinessScore}/{coach.traderStatus.readinessGrade} ({coach.traderStatus.readinessLevel})
        </span>
        <button onClick={loadAll} className="ml-auto px-3 py-1 bg-primary rounded text-sm">Refresh</button>
      </header>

      <section className="bg-card p-4 rounded">
        <h2 className="text-lg font-semibold mb-2">Coaching summary</h2>
        <p className="text-sm text-txt-secondary">{coach.coachingSummary}</p>
      </section>

      <div className="grid md:grid-cols-2 gap-4">
        <section className="bg-card p-4 rounded">
          <h3 className="font-semibold mb-2">Current focus areas</h3>
          <ul className="list-disc pl-5 text-sm space-y-1">
            {coach.currentFocusAreas.map((f, i) => <li key={i}>{f}</li>)}
            {coach.currentFocusAreas.length === 0 && <li className="text-txt-muted">No focus areas yet.</li>}
          </ul>
        </section>
        <section className="bg-card p-4 rounded">
          <h3 className="font-semibold mb-2">Next best actions</h3>
          <ul className="list-disc pl-5 text-sm space-y-1">
            {coach.nextBestActions.map((a, i) => <li key={i}>{a}</li>)}
            {coach.nextBestActions.length === 0 && <li className="text-txt-muted">No actions yet.</li>}
          </ul>
        </section>
      </div>

      <div className="grid md:grid-cols-3 gap-4">
        <section className="bg-card p-4 rounded">
          <h3 className="font-semibold mb-2 text-success">Top strengths</h3>
          <ul className="list-disc pl-5 text-sm space-y-1">
            {coach.topStrengths.map((s, i) => <li key={i}>{s}</li>)}
            {coach.topStrengths.length === 0 && <li className="text-txt-muted">Build sample size first.</li>}
          </ul>
        </section>
        <section className="bg-card p-4 rounded">
          <h3 className="font-semibold mb-2 text-danger">Top weaknesses</h3>
          <ul className="list-disc pl-5 text-sm space-y-1">
            {coach.topWeaknesses.map((s, i) => <li key={i}>{s}</li>)}
            {coach.topWeaknesses.length === 0 && <li className="text-txt-muted">None identified.</li>}
          </ul>
        </section>
        <section className="bg-card p-4 rounded">
          <h3 className="font-semibold mb-2 text-warning">Repeated mistakes</h3>
          <ul className="list-disc pl-5 text-sm space-y-1">
            {coach.repeatedMistakes.map((m, i) => (
              <li key={i}>{m.tag} <span className="text-txt-muted">({m.count}× / sev {m.severity})</span></li>
            ))}
            {coach.repeatedMistakes.length === 0 && <li className="text-txt-muted">None yet.</li>}
          </ul>
        </section>
      </div>

      <section className="bg-card p-4 rounded">
        <h3 className="font-semibold mb-2">Daily Prep — pre-session checklist</h3>
        <ul className="text-sm space-y-1">
          {coach.preSessionChecklist.map(item => (
            <li key={item.id} className="flex gap-2">
              <input type="checkbox" disabled={item.auto} />
              <span>{item.label}</span>
              {item.auto && <span className="text-xs text-primary">(auto-checked)</span>}
            </li>
          ))}
        </ul>
      </section>

      <section className="bg-card p-4 rounded">
        <div className="flex items-center mb-2">
          <h3 className="font-semibold">Playbook entries ({playbook.length})</h3>
          <button onClick={regeneratePlaybook} className="ml-auto px-3 py-1 bg-primary rounded text-xs">Regenerate playbook</button>
        </div>
        {playbook.length === 0 ? (
          <p className="text-sm text-txt-muted">No playbook entries yet — capture more demo trades and learning events.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-txt-secondary">
              <tr>
                <th className="p-1">Status</th>
                <th className="p-1">Symbol</th>
                <th className="p-1">Setup</th>
                <th className="p-1">Bias</th>
                <th className="p-1">Confidence</th>
                <th className="p-1 text-right">Sample</th>
                <th className="p-1 text-right">Win %</th>
                <th className="p-1 text-right">Edge</th>
              </tr>
            </thead>
            <tbody>
              {playbook.map(e => (
                <tr key={e.id} className="border-t border-border">
                  <td className="p-1"><span className={`px-2 py-0.5 rounded text-xs ${STATUS_BADGE[e.status] ?? "bg-muted"}`}>{e.status}</span></td>
                  <td className="p-1">{e.symbol}</td>
                  <td className="p-1">{e.setupName}</td>
                  <td className="p-1">{e.actionBias}</td>
                  <td className="p-1">{e.confidenceLevel}</td>
                  <td className="p-1 text-right">{e.sampleSize}</td>
                  <td className="p-1 text-right">{e.winRate.toFixed(1)}</td>
                  <td className="p-1 text-right">{e.edgeScore.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {weekly && (
        <section className="bg-card p-4 rounded">
          <h3 className="font-semibold mb-2">Weekly Plan ({weekly.week_start} → {weekly.week_end})</h3>
          <p className="text-sm mb-2"><strong>Main goal:</strong> {weekly.mainGoal}</p>
          <div className="grid md:grid-cols-2 gap-4 text-sm">
            <div>
              <h4 className="font-semibold text-warning">Practice rules</h4>
              <ul className="list-disc pl-5">{weekly.rulesToPractice.map((r, i) => <li key={i}>{r}</li>)}</ul>
            </div>
            <div>
              <h4 className="font-semibold text-danger">Mistakes to reduce</h4>
              <ul className="list-disc pl-5">{weekly.mistakesToReduce.map((m, i) => <li key={i}>{m}</li>)}</ul>
            </div>
            <div>
              <h4 className="font-semibold text-success">Setups to study</h4>
              <ul className="list-disc pl-5">{weekly.setupsToStudy.map((s, i) => <li key={i}>{s}</li>)}</ul>
            </div>
            <div>
              <h4 className="font-semibold text-warning">Setups to avoid</h4>
              <ul className="list-disc pl-5">{weekly.setupsToAvoid.map((s, i) => <li key={i}>{s}</li>)}</ul>
            </div>
            <div className="md:col-span-2">
              <h4 className="font-semibold">Success criteria</h4>
              <ul className="list-disc pl-5">{weekly.successCriteria.map((s, i) => <li key={i}>{s}</li>)}</ul>
            </div>
          </div>
        </section>
      )}

      <section className="bg-card p-4 rounded">
        <h3 className="font-semibold mb-2">Post-session review questions</h3>
        <ol className="list-decimal pl-5 text-sm space-y-1">
          {coach.postSessionReviewQuestions.map((q, i) => <li key={i}>{q}</li>)}
        </ol>
      </section>

      <section className="bg-warning/15 border border-warning/40 p-4 rounded">
        <h3 className="font-semibold mb-2 text-warning">Warnings</h3>
        <ul className="list-disc pl-5 text-sm space-y-1">
          {coach.warnings.map((w, i) => <li key={i}>{w}</li>)}
        </ul>
      </section>
    </div>
  );
}
