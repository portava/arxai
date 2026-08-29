// ── B4/B5 — Edge decay → auto-demote (pure decision core) ───────────────────
//
// Wires the EXISTING statistical machinery to the flywheel: the CUSUM /
// Page–Hinkley detectors (@workspace/domain/change-point) run over a cohort's
// reconciled reward series, and a DOWNWARD structural break — or a posterior
// whose measured mean has gone non-positive on adequate sample — is a decay
// verdict. On decay:
//
//   1. the cohort's shadow allocation weight is forced to 0 (bandit.ts reads
//      the `decayed` flag), and
//   2. the meta-strategy controller's reduce-only seam is NOTIFIED — via the
//      injected notifier the composition root (index.ts) wires to the shadow
//      registry's demote() (the same seam metaStrategyController mirrors
//      reductions into). Auto-DEMOTE is the allowed direction; nothing in the
//      flywheel imports or calls promote() (source-pinned).
//
// HONESTY: a series too short for the detectors yields decayed=false with
// reason INSUFFICIENT_SERIES — silence, not a fabricated break. Detection can
// only REMOVE shadow weight; there is no "recovery" verdict here (recovery is
// the owner-gated promotion machinery's business).
//
// FLYWHEEL INVARIANT: pure — no IO, no clock, no randomness; imports only the
// pure change-point domain package and the local posterior module.

import {
  detectSeriesBreak,
  type SeriesBreakResult,
} from "@workspace/domain/change-point";
import { type NigPosterior, posteriorStatus } from "./posterior.js";

/** Reward series shorter than this cannot even feed the mean-decay check. */
export const FLYWHEEL_DECAY_MIN_SERIES = 20;
/** Change-point baseline sized for per-trade reward series (they are short). */
export const FLYWHEEL_DECAY_BASELINE_COUNT = 30;

export interface EdgeDecayEvidence {
  strategyId: string;
  cohortKey: string;
  /** Chronological RECONCILED net-log-return series for the cohort. */
  rewardSeries: readonly number[];
  posterior: NigPosterior | null;
}

export interface EdgeDecayVerdict {
  strategyId: string;
  cohortKey: string;
  decayed: boolean;
  reasons: string[];
  detection: SeriesBreakResult | null;
}

/**
 * PURE — decide whether a cohort's edge has decayed. Conservative: decay
 * requires either a DOWNWARD change-point alarm on the reward series or a
 * non-positive posterior mean on an adequate sample. Insufficient evidence is
 * honest silence (decayed=false with the reason recorded).
 */
export function decideEdgeDecay(e: EdgeDecayEvidence): EdgeDecayVerdict {
  const reasons: string[] = [];
  const series = e.rewardSeries.filter((x) => Number.isFinite(x));

  let detection: SeriesBreakResult | null = null;
  if (series.length >= FLYWHEEL_DECAY_MIN_SERIES) {
    detection = detectSeriesBreak([...series], {
      cusum: { baselineCount: FLYWHEEL_DECAY_BASELINE_COUNT },
      pageHinkley: { baselineCount: FLYWHEEL_DECAY_BASELINE_COUNT },
    });
    const downAlarm =
      (detection.cusum.alarm && detection.cusum.direction === "DOWN") ||
      (detection.pageHinkley.alarm && detection.pageHinkley.direction === "DOWN");
    if (downAlarm) {
      reasons.push(
        "CHANGE_POINT_DOWN: CUSUM/Page–Hinkley detected a downward structural break in the reconciled reward series",
      );
      return { strategyId: e.strategyId, cohortKey: e.cohortKey, decayed: true, reasons, detection };
    }
    if (detection.cusum.reason === "INSUFFICIENT_SERIES" && detection.pageHinkley.reason === "INSUFFICIENT_SERIES") {
      reasons.push("INSUFFICIENT_SERIES: detectors cannot see this series yet — silent, nothing fabricated");
    }
  } else {
    reasons.push(
      `INSUFFICIENT_SERIES: ${series.length} < ${FLYWHEEL_DECAY_MIN_SERIES} reconciled rewards — detectors not run`,
    );
  }

  // Posterior mean gone non-positive on an adequate sample: the measured edge
  // itself has evaporated even without a sharp break.
  if (e.posterior !== null && posteriorStatus(e.posterior.n) === "OK" && e.posterior.mu <= 0) {
    reasons.push(
      `POSTERIOR_MEAN_NONPOSITIVE: mu ${e.posterior.mu.toExponential(3)} on n=${e.posterior.n} — the measured edge has decayed away`,
    );
    return { strategyId: e.strategyId, cohortKey: e.cohortKey, decayed: true, reasons, detection };
  }

  if (reasons.length === 0) reasons.push("NO_DECAY: no downward break, posterior mean positive");
  return { strategyId: e.strategyId, cohortKey: e.cohortKey, decayed: false, reasons, detection };
}

/**
 * The reduce-only notification seam. The flywheel NEVER imports the shadow
 * registry (its transitive closure reaches scan/risk engines the flywheel
 * invariant forbids); instead the composition root (index.ts) injects an
 * implementation that calls the registry's own demote() — the same seam the
 * meta-strategy controller uses for its reductions. The interface can only
 * express a reduction: there is no level, no target state, no promote verb.
 */
export type DemotionNotifier = (strategyId: string, reason: string) => void;
