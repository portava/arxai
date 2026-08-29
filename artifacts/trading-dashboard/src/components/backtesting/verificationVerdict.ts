// Backtest verification verdict — the ONE place the word VERIFIED is decided.
//
// Audit rank 41 (read path). The write path now refuses to stamp VERIFIED on a
// run over fabricated candles, but that only governs runs created after the
// fix. Every backtest_runs row written BEFORE it still carries
// dataSource:"synthetic" alongside isVerified:"VERIFIED", and this repo has no
// migration system (CLAUDE.md §2) — those rows keep that pair indefinitely.
//
// So the READ path has to be the gate too: a surface may never display more
// than the code delivers, and a green VERIFIED next to a grey SYNTHETIC badge
// claims evidence that does not exist. Every surface that renders the verdict
// derives it from here, so the rule cannot be applied on one surface and
// forgotten on the next (it had been: ResultsHistoryTab checked dataSource,
// BacktestingTab and BacktestResultsDashboard did not).
//
// Provenance is checked FIRST and independently of the stored flag. Unknown
// provenance is an honest "unknown", never an optimistic default.

export type BacktestVerdictTone = "verified" | "warn" | "muted";

export interface BacktestVerdict {
  /** Short label for the badge/pill. */
  label: string;
  tone: BacktestVerdictTone;
  /** Tooltip: why this label, in plain words. Always present. */
  title: string;
  /** True only for a genuine VERIFIED over real broker bars. */
  isVerified: boolean;
}

export interface VerdictInput {
  /** "broker" = real closed broker bars. Anything else is not broker history. */
  dataSource?: string | null;
  /** Stored flag: "VERIFIED" | "UNVERIFIED" | "SYNTHETIC_NOT_VERIFIABLE" | … */
  isVerified?: string | null;
  status?: string | null;
}

export const SYNTHETIC_VERDICT_TITLE =
  "Simulated over candles ARX fabricated from a deterministic generator — no broker history was used. " +
  "A verification verdict cannot be drawn from this run, whatever the metrics say.";

export const UNKNOWN_PROVENANCE_VERDICT_TITLE =
  "This run does not record where its candles came from. Provenance unknown is not the same as verified, " +
  "so no verification verdict is shown.";

export function backtestVerdict(run: VerdictInput): BacktestVerdict {
  // 1. Provenance gate, before the stored flag is consulted at all.
  if (run.dataSource == null || run.dataSource === "") {
    return {
      label: "NOT VERIFIABLE",
      tone: "muted",
      title: UNKNOWN_PROVENANCE_VERDICT_TITLE,
      isVerified: false,
    };
  }
  if (run.dataSource !== "broker") {
    return {
      label: "NOT VERIFIABLE",
      tone: "muted",
      title: SYNTHETIC_VERDICT_TITLE,
      isVerified: false,
    };
  }
  // 2. Real broker bars — the stored flag is meaningful here.
  if (run.isVerified === "VERIFIED") {
    return {
      label: "VERIFIED",
      tone: "verified",
      title:
        "Backtest verdict over real closed broker bars — a historical simulation result, " +
        "not a live-readiness or execution signal.",
      isVerified: true,
    };
  }
  if (run.status === "INSUFFICIENT_DATA") {
    return {
      label: "INSUFFICIENT DATA",
      tone: "warn",
      title: "Not enough historical candles to verify this backtest run.",
      isVerified: false,
    };
  }
  return {
    label: "UNVERIFIED",
    tone: "muted",
    title: "This backtest run has not met the verification thresholds.",
    isVerified: false,
  };
}
