// Truth evidence classes — plain-English "what is observed vs estimated".
//
// Renders the per-claim classification of the ONE per-symbol Truth Snapshot
// (already capped client-side by resolveSymbolTruthEvidence, which can only
// downgrade a server class). Each row says whether a value is a verified
// observation, an ARX estimate, stale, or unavailable — and why.
//
// Display-only: nothing here gates, permits, or places a trade. With no
// classification (older server / no snapshot) this renders nothing rather than
// inventing one.

import type {
  TruthClaimEvidence,
  TruthEvidence,
  TruthEvidenceClass,
} from "@workspace/domain/truth";
import {
  TRUTH_EVIDENCE_CLASS_LABEL,
  TRUTH_EVIDENCE_CLASSES,
  TRUTH_EVIDENCE_REASON_TEXT,
} from "@workspace/domain/truth";

const CLASS_TONE: Record<TruthEvidenceClass, string> = {
  verified: "bg-success/15 text-success",
  estimate: "bg-primary/15 text-primary",
  stale: "bg-warning/15 text-warning",
  unavailable: "bg-muted text-txt-muted",
};

const ROWS: { key: string; label: string; pick: (e: TruthEvidence) => TruthClaimEvidence }[] = [
  { key: "price", label: "Price", pick: (e) => e.price },
  { key: "lastCandle", label: "Last candle", pick: (e) => e.lastCandle },
  { key: "lastTick", label: "Last tick", pick: (e) => e.lastTick },
  { key: "news", label: "Economic calendar", pick: (e) => e.news },
  { key: "scanner", label: "Scanner read", pick: (e) => e.components.scanner },
  { key: "flame", label: "Momentum read", pick: (e) => e.components.flame },
  { key: "timing", label: "Timing read", pick: (e) => e.components.timing },
  { key: "scalp", label: "Scalp read", pick: (e) => e.components.scalp },
  { key: "levels", label: "Entry, stop and target", pick: (e) => e.levels },
  { key: "verdict", label: "Overall read", pick: (e) => e.verdict },
];

/** "14:03:05 UTC" — the data time a claim rests on; never build time. */
function observedLabel(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return `${new Date(ms).toISOString().slice(11, 19)} UTC`;
}

export function TruthEvidenceClasses({
  evidence,
  testid = "truth-evidence-classes",
}: {
  evidence: TruthEvidence | null | undefined;
  testid?: string;
}) {
  if (!evidence) return null;
  const rows = ROWS.map((r) => ({ ...r, claim: r.pick(evidence) }));
  const counts = TRUTH_EVIDENCE_CLASSES.map((c) => ({
    cls: c,
    n: rows.filter((r) => r.claim.evidenceClass === c).length,
  })).filter((c) => c.n > 0);

  return (
    <details className="rounded-xl border border-border bg-background/40 p-3 text-xs" data-testid={testid}>
      <summary className="cursor-pointer select-none text-txt-secondary" data-testid={`${testid}-summary`}>
        <span className="font-medium text-foreground">What's observed vs estimated</span>
        {" · "}
        {counts.map((c) => `${c.n} ${TRUTH_EVIDENCE_CLASS_LABEL[c.cls].toLowerCase()}`).join(" · ")}
      </summary>
      <ul className="mt-2 space-y-1.5">
        {rows.map((r) => {
          const at = observedLabel(r.claim.observedAt);
          return (
            <li
              key={r.key}
              className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5"
              data-testid={`${testid}-${r.key}`}
              data-evidence-class={r.claim.evidenceClass}
            >
              <span className="min-w-[9rem] text-txt-secondary">{r.label}</span>
              <span className={`rounded px-1.5 py-0.5 font-medium ${CLASS_TONE[r.claim.evidenceClass]}`}>
                {TRUTH_EVIDENCE_CLASS_LABEL[r.claim.evidenceClass]}
              </span>
              <span className="text-txt-muted">
                {TRUTH_EVIDENCE_REASON_TEXT[r.claim.reason]}
                {at ? ` Data time ${at}.` : ""}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-txt-muted">
        Estimates are ARX calculations, not observations. This is advice only — it never places or permits a trade.
      </p>
    </details>
  );
}
