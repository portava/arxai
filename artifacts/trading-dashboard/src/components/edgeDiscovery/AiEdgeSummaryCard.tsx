import type { EdgeBehaviourBasis, EdgeReport } from "./types";

// Behaviour scores are shown as numbers only when the server says they were
// measured from debriefs on this slice's own trades. Otherwise the stored
// values are placeholders (0 with no debriefs) or, on older reports, an
// account-wide average identical for every slice. Execution is not measured
// by post-trade debriefs, so it is never shown as a score.
const BASIS_NOTE: Record<Exclude<EdgeBehaviourBasis, "SLICE_DEBRIEFS">, string> = {
  NOT_MEASURED: "No post-trade debrief is linked to a trade in this slice, so behaviour was not measured.",
  ACCOUNT_WIDE_LEGACY: "This older report averaged behaviour over all your debriefs, not this slice. Regenerate the report for per-slice scores.",
};

export function AiEdgeSummaryCard({ report, behaviourBasis }: { report: EdgeReport; behaviourBasis?: EdgeBehaviourBasis }) {
  const basis: EdgeBehaviourBasis = behaviourBasis ?? report.behaviourBasis ?? "ACCOUNT_WIDE_LEGACY";
  const measured = basis === "SLICE_DEBRIEFS";
  const score = (v: number) => (measured ? String(Math.round(v)) : "Not measured");
  return (
    <div className="rounded-lg border border-violet-700 bg-violet-950/20 p-3">
      <div className="mb-1 flex items-center justify-between">
        <h4 className="text-sm font-semibold text-violet-200">Edge summary</h4>
        <span className="text-[10px] uppercase tracking-wide text-violet-400/80">historical, not predictive</span>
      </div>
      <p className="text-xs leading-relaxed text-slate-100">{report.aiSummary}</p>
      <dl className="mt-2 grid grid-cols-3 gap-1 text-[10px] text-slate-300">
        <div><dt className="text-slate-500">Discipline</dt><dd className="font-mono">{score(report.disciplineScoreAvg)}</dd></div>
        <div><dt className="text-slate-500">Execution</dt><dd className="font-mono">Not measured</dd></div>
        <div><dt className="text-slate-500">Emotional</dt><dd className="font-mono">{score(report.emotionalScoreAvg)}</dd></div>
      </dl>
      {!measured && <p className="mt-1 text-[10px] text-slate-400">{BASIS_NOTE[basis as Exclude<EdgeBehaviourBasis, "SLICE_DEBRIEFS">]}</p>}
    </div>
  );
}
