import type { SkillPillar, TraderSkillProfile } from "./types";

interface Row { key: SkillPillar; label: string; score: number; noEvidence: string }

// What each pillar is measured from — named when a pillar has no evidence.
const ROWS: Array<Omit<Row, "score"> & { field: keyof TraderSkillProfile }> = [
  { key: "discipline",  label: "Discipline",        field: "disciplineScore",       noEvidence: "no post-trade debriefs yet" },
  { key: "execution",   label: "Execution",         field: "executionScore",        noEvidence: "no debrief checklists yet" },
  { key: "risk",        label: "Risk control",      field: "riskScore",             noEvidence: "no journal entries or closed paper trades yet" },
  { key: "emotional",   label: "Emotional control", field: "emotionalControlScore", noEvidence: "no post-trade debriefs yet" },
  { key: "consistency", label: "Consistency",       field: "consistencyScore",      noEvidence: "no edge reports yet" },
  { key: "planning",    label: "Planning",          field: "planningScore",         noEvidence: "no trade plans or debriefs yet" },
  { key: "review",      label: "Review cadence",    field: "reviewScore",           noEvidence: "no weekly reviews yet" },
  { key: "practice",    label: "Practice",          field: "practiceScore",         noEvidence: "no closed paper trades yet" },
];

function ScoreBar({ row, noData, hasNewEvidence }: { row: Row; noData: boolean; hasNewEvidence: boolean }) {
  // Not measured in this snapshot. With evidence added since, "no ... yet" is
  // no longer true: say it was not measured then, and to recalculate.
  const why = hasNewEvidence
    ? "not measured when this profile was calculated (there was no evidence for it then); there is evidence since, so recalculate to score it"
    : row.noEvidence;
  const pct = Math.max(0, Math.min(100, row.score));
  const tone = pct >= 75 ? "bg-emerald-500"
             : pct >= 60 ? "bg-sky-500"
             : pct >= 45 ? "bg-amber-500"
             : "bg-red-500";
  return (
    <div data-pillar={row.key}>
      <div className="mb-0.5 flex items-center justify-between text-[10px] text-slate-300">
        <span>{row.label}</span>
        {noData
          ? <span className="italic text-slate-500" title={`Not measured: ${why}.`}>no data</span>
          : <span className="font-mono">{Math.round(pct)}</span>}
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
        {!noData && <div className={`h-full ${tone}`} style={{ width: `${pct}%` }} />}
      </div>
      {noData && <p className="mt-0.5 text-[10px] text-slate-500">Not measured: {why}.</p>}
    </div>
  );
}

/**
 * `unmeasured` — pillars the server found no evidence for when this profile
 * was calculated (their stored 0 was not measured). null = the server could
 * not check; undefined = not supplied. `newEvidence` — the unmeasured pillars
 * that have evidence now (a recalculation would score them).
 */
export function SkillBreakdownCard({ profile, unmeasured, newEvidence }: {
  profile: TraderSkillProfile; unmeasured?: SkillPillar[] | null; newEvidence?: SkillPillar[] | null;
}) {
  const rows: Row[] = ROWS.map((r) => ({ key: r.key, label: r.label, noEvidence: r.noEvidence, score: profile[r.field] as number }));
  // Only a stored 0 can be "no data"; a pillar that scored was measured.
  const noData = new Set((unmeasured ?? []).filter((k) => rows.find((r) => r.key === k)?.score === 0));
  const fresh = new Set((newEvidence ?? []).filter((k) => noData.has(k)));
  const freshLabels = rows.filter((r) => fresh.has(r.key)).map((r) => r.label);
  const noDataLabels = rows.filter((r) => noData.has(r.key) && !fresh.has(r.key)).map((r) => r.label);
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-3">
      <h3 className="mb-2 text-sm font-semibold text-slate-200">Skill breakdown</h3>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {rows.map((r) => <ScoreBar key={r.key} row={r} noData={noData.has(r.key)} hasNewEvidence={fresh.has(r.key)} />)}
      </div>
      {freshLabels.length > 0 && (
        <p className="mt-2 text-[10px] text-amber-400" data-testid="skill-new-evidence">
          {freshLabels.join(", ")}: not measured in this profile, because there was no evidence when it was calculated.
          There is evidence since. Recalculate to score {freshLabels.length === 1 ? "it" : "them"}; until then {freshLabels.length === 1 ? "it counts" : "they count"} as 0 in the total.
        </p>
      )}
      {noDataLabels.length > 0 && (
        <p className="mt-2 text-[10px] text-amber-400">
          No data for {noDataLabels.join(", ")}: there is no evidence for {noDataLabels.length === 1 ? "this pillar" : "these pillars"} yet,
          so {noDataLabels.length === 1 ? "it was" : "they were"} not measured. {noDataLabels.length === 1 ? "It counts" : "They count"} as 0 in the total until there is.
        </p>
      )}
      {unmeasured === null && (
        <p className="mt-2 text-[10px] text-amber-400">
          Which pillars have evidence could not be checked, so a 0 here may mean there is no data for it rather than a measured 0.
        </p>
      )}
      <p className="mt-2 text-[10px] italic text-slate-500">
        Equal-weighted across 8 process pillars. Sample-capped — thin evidence cannot produce a high score.
      </p>
    </div>
  );
}
