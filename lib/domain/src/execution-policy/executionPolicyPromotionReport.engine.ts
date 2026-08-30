// ── Capability #27 — THE EXECUTION-POLICY PROMOTION REPORT (pure) ────────────
//
// The promotion gate (executionPolicyPromotion.engine.ts) already DECIDES.
// This module makes the decision VISIBLE in the same shape as the conformal
// coverage report, so the owner can answer one question before pressing
// anything: has enough shadow evidence accumulated, and what does it measure?
//
// THE BAR (unchanged — this report only reads it):
//   * ≥ PROMOTION_MIN_QUALIFYING_RECOMMENDATIONS journaled shadow
//     recommendations whose fill quality was MEASURED for BOTH shapes,
//   * of which ≥ PROMOTION_MIN_MEASURED_ADVANTAGE showed a non-tie measured
//     fill-quality advantage,
//   * of which ≥ PROMOTION_MIN_ADVANTAGE_CONSISTENCY_01 favored the SAME
//     shape (a chooser whose evidence flip-flops has proven nothing).
//
// WHY THE ANSWER TODAY IS `INSUFFICIENT_HISTORY`
// ----------------------------------------------
// `recordExecutionPolicyShadowRecommendation` — the only writer of the
// EXECUTION_POLICY_SHADOW_RECOMMENDATION journal — has NO production call
// site. So the journal is empty, and empty here does not mean "few trades":
// it means nothing writes the feed. `feed.writerWired: false` says that out
// loud, because an owner reading a bare `0` cannot tell the two apart.
//
// SAFETY:
//   * READ-ONLY BY CONSTRUCTION. This is a pure function over evidence the
//     caller already read. It cannot refresh, unlock, enable, or revert.
//     `barMet` does not unlock anything either — only the existing
//     `decideOwnerPress` path can reach ENABLED, and only from an owner press.
//   * The report never claims a measurement it does not have: an unreadable
//     journal is `SOURCE_UNREADABLE` with `sampleSize: null`, never `0`.

import {
  buildEvidenceGateReport,
  type EvidenceGateReport,
  type EvidenceGateVerdict,
  type EvidenceMeasurement,
  type EvidenceWindow,
} from "../evidence-gate/evidenceGateReport.types.js";
import { MIN_FILL_SAMPLE } from "./executionPolicyChooser.engine.js";
import {
  PROMOTION_MIN_ADVANTAGE_CONSISTENCY_01,
  PROMOTION_MIN_MEASURED_ADVANTAGE,
  PROMOTION_MIN_QUALIFYING_RECOMMENDATIONS,
  type PromotionEvidence,
  type PromotionStatus,
} from "./executionPolicyPromotion.engine.js";

/** The audit event type the shadow chooser journals its recommendations as. */
export const EXECUTION_POLICY_SHADOW_JOURNAL_FEED = "EXECUTION_POLICY_SHADOW_RECOMMENDATION";

export interface ExecutionPolicyPromotionReportInput {
  /** Evidence already evaluated from the journal. `null` = THE READ FAILED —
   *  which is not the same fact as an empty journal. */
  evidence: PromotionEvidence | null;
  sourceError?: string | null;
  /** Is there a production writer for the shadow journal? Source-pinned. */
  writerWired: boolean;
  writerNote: string;
  /** Journal rows examined; `null` when the read failed. */
  journalRowsSeen: number | null;
  unreadableRows?: number;
  /** Current promotion ladder status, or null when it could not be read. */
  currentStatus: PromotionStatus | null;
  statusReadError?: string | null;
  /** Chronological span of the journaled recommendations, when known. */
  window: EvidenceWindow | null;
  nowIso: string;
}

export interface ExecutionPolicyPromotionReport extends EvidenceGateReport {
  promotion: {
    currentStatus: PromotionStatus | null;
    statusReadError: string | null;
    ladder: string[];
    /** Thresholds echoed so the surface never hard-codes its own copy. */
    thresholds: {
      minQualifyingRecommendations: number;
      minMeasuredAdvantage: number;
      minAdvantageConsistency01: number;
      minFillSample: number;
    };
  };
  fillQuality: {
    qualifyingCount: number | null;
    measuredAdvantageCount: number | null;
    dominantAdvantageShape: string | null;
    advantageConsistency01: number | null;
  };
}

const GATE_ID = "execution-policy-promotion";
const TITLE = "Execution-policy promotion (capability #27) — the shadow chooser";

const LADDER = [
  "SHADOW — recommendations are advisory; this is the current mode",
  "PRESS_UNLOCKED — evidence threshold met; grants NOTHING, only unlocks the press",
  "ENABLED — owner press only; nothing auto-enables",
];

export function buildExecutionPolicyPromotionReport(
  input: ExecutionPolicyPromotionReportInput,
): ExecutionPolicyPromotionReport {
  const unreadableRows = input.unreadableRows ?? 0;
  const thresholds = {
    minQualifyingRecommendations: PROMOTION_MIN_QUALIFYING_RECOMMENDATIONS,
    minMeasuredAdvantage: PROMOTION_MIN_MEASURED_ADVANTAGE,
    minAdvantageConsistency01: PROMOTION_MIN_ADVANTAGE_CONSISTENCY_01,
    minFillSample: MIN_FILL_SAMPLE,
  };
  const feedBase = {
    feedId: EXECUTION_POLICY_SHADOW_JOURNAL_FEED,
    writerWired: input.writerWired,
    writerNote: input.writerNote,
    unreadableRows,
  };

  const ev = input.evidence;

  let verdict: EvidenceGateVerdict;
  let verdictReason: string;
  let measurements: EvidenceMeasurement[];

  if (ev === null) {
    verdict = "SOURCE_UNREADABLE";
    verdictReason =
      `the ${EXECUTION_POLICY_SHADOW_JOURNAL_FEED} journal could not be read — ` +
      `no promotion claim can be made either way (${input.sourceError ?? "no reason reported"})`;
    measurements = [
      notMeasured("qualifyingCount", `Recommendations with BOTH shapes measured (n≥${MIN_FILL_SAMPLE} fills each)`,
        `≥ ${PROMOTION_MIN_QUALIFYING_RECOMMENDATIONS}`, "journal unreadable"),
      notMeasured("measuredAdvantageCount", "Of those, with a non-tie measured fill-quality advantage",
        `≥ ${PROMOTION_MIN_MEASURED_ADVANTAGE}`, "journal unreadable"),
      notMeasured("advantageConsistency01", "Share of those favoring the SAME shape",
        `≥ ${PROMOTION_MIN_ADVANTAGE_CONSISTENCY_01}`, "journal unreadable"),
    ];
  } else {
    measurements = [
      {
        key: "qualifyingCount",
        label: `Recommendations with BOTH shapes measured (n≥${MIN_FILL_SAMPLE} fills each)`,
        value: ev.qualifyingCount,
        unit: "count",
        target: `≥ ${PROMOTION_MIN_QUALIFYING_RECOMMENDATIONS}`,
        met: ev.qualifyingCount >= PROMOTION_MIN_QUALIFYING_RECOMMENDATIONS,
        note: `${ev.recommendationsSeen} readable shadow recommendations journaled in total`,
      },
      {
        key: "measuredAdvantageCount",
        label: "Of those, with a non-tie measured fill-quality advantage",
        value: ev.measuredAdvantageCount,
        unit: "count",
        target: `≥ ${PROMOTION_MIN_MEASURED_ADVANTAGE}`,
        met: ev.measuredAdvantageCount >= PROMOTION_MIN_MEASURED_ADVANTAGE,
        note: "advantage = lower median adverse slippage for one shape; a tie counts as no advantage",
      },
      ev.advantageConsistency01 === null
        ? notMeasured("advantageConsistency01", "Share of those favoring the SAME shape",
            `≥ ${PROMOTION_MIN_ADVANTAGE_CONSISTENCY_01}`,
            "no non-tie advantage evidence exists, so consistency is unmeasurable")
        : {
            key: "advantageConsistency01",
            label: "Share of those favoring the SAME shape",
            value: Math.round(ev.advantageConsistency01 * 1e6) / 1e6,
            unit: "ratio",
            target: `≥ ${PROMOTION_MIN_ADVANTAGE_CONSISTENCY_01}`,
            met: ev.advantageConsistency01 >= PROMOTION_MIN_ADVANTAGE_CONSISTENCY_01,
            note: `dominant shape: ${ev.dominantAdvantageShape ?? "none (exact tie between shapes)"}`,
          },
    ];

    const belowSampleBar =
      ev.qualifyingCount < PROMOTION_MIN_QUALIFYING_RECOMMENDATIONS ||
      ev.measuredAdvantageCount < PROMOTION_MIN_MEASURED_ADVANTAGE;

    if (belowSampleBar) {
      verdict = "INSUFFICIENT_HISTORY";
      verdictReason =
        ev.recommendationsSeen === 0
          ? `no shadow recommendations have been journaled — 0 of the ${PROMOTION_MIN_QUALIFYING_RECOMMENDATIONS} qualifying recommendations the bar requires` +
            (input.writerWired
              ? ""
              : "; and nothing in production writes this journal, so it will not accumulate on its own")
          : `not enough measured evidence yet: ${ev.qualifyingCount}/${PROMOTION_MIN_QUALIFYING_RECOMMENDATIONS} qualifying, ` +
            `${ev.measuredAdvantageCount}/${PROMOTION_MIN_MEASURED_ADVANTAGE} with a measured advantage`;
    } else if (!ev.thresholdMet) {
      verdict = "BAR_NOT_MET";
      verdictReason =
        `sample is large enough to judge, and the evidence does NOT clear the bar: ` +
        (ev.advantageConsistency01 === null
          ? "no dominant shape (exact tie) — the chooser has not proven a direction"
          : `${(ev.advantageConsistency01 * 100).toFixed(0)}% consistency for ${ev.dominantAdvantageShape} < the required ${PROMOTION_MIN_ADVANTAGE_CONSISTENCY_01 * 100}%`);
    } else {
      verdict = "BAR_MET";
      verdictReason =
        `evidence threshold MET: ${ev.qualifyingCount} qualifying, ${ev.measuredAdvantageCount} with a measured advantage, ` +
        `${((ev.advantageConsistency01 ?? 0) * 100).toFixed(0)}% consistent for ${ev.dominantAdvantageShape}. ` +
        `This UNLOCKS the owner press and grants nothing by itself — the mode stays shadow until the press.`;
    }
  }

  const pressUnavailableReason =
    verdict === "BAR_MET"
      ? input.currentStatus === "ENABLED"
        ? "already ENABLED — there is nothing left to press"
        : input.currentStatus !== "PRESS_UNLOCKED"
          ? `the stored ladder status is ${input.currentStatus ?? "unreadable"}; open GET /api/admin/execution-policy once (that read refreshes the ladder) so the press seam is unlocked, then press`
          : null
      : null;

  const base = buildEvidenceGateReport({
    gateId: GATE_ID,
    title: TITLE,
    verdict,
    verdictReason,
    bar: {
      description:
        `≥ ${PROMOTION_MIN_QUALIFYING_RECOMMENDATIONS} journaled shadow recommendations with fill quality measured for BOTH shapes ` +
        `(each at n≥${MIN_FILL_SAMPLE} fills), of which ≥ ${PROMOTION_MIN_MEASURED_ADVANTAGE} show a non-tie measured advantage, ` +
        `of which ≥ ${PROMOTION_MIN_ADVANTAGE_CONSISTENCY_01 * 100}% favor the same shape`,
      requiredSampleSize: PROMOTION_MIN_QUALIFYING_RECOMMENDATIONS,
    },
    sampleSize: ev === null ? null : ev.recommendationsSeen,
    window: input.window,
    feed: { ...feedBase, rowsRead: input.journalRowsSeen, sourceError: input.sourceError ?? null },
    measurements,
    ownerPress: {
      label: 'POST /api/admin/execution-policy/enable  { confirm: true, reason: "…" }',
      steps: [
        "Read this report and confirm the verdict is BAR_MET.",
        "Open Admin → Governance → Execution-policy promotion (#27).",
        'Type a reason (it is written to the admin audit log) and type ENABLE to arm the button.',
        "Press ENABLE. The server re-collects and re-verifies the evidence AT PRESS TIME and refuses if it no longer holds.",
        "Reverting to SHADOW is always accepted — authority only shrinks on the way back.",
      ],
      // Explicit: the bar being met is NECESSARY but not sufficient — the
      // ladder must also be unlocked, and an already-ENABLED mode has nothing
      // left to press. `buildEvidenceGateReport` additionally forces this
      // false for every verdict but BAR_MET.
      available: pressUnavailableReason === null,
      unavailableReason: pressUnavailableReason,
      whatItChanges: [
        "It records ENABLED on the promotion ladder. That is the whole change.",
        "TODAY: no dispatch path consumes ENABLED — resolveExecutionPolicyMode has no execution-path caller, so the chooser stays observably shadow. Wiring the first consumer is a separate reviewed change.",
        "Once a consumer exists, ENABLED would let the chooser's recommended execution shape be used instead of the default path — never to place an order the gates did not already allow.",
        "Nothing auto-enables: automatic refresh can only move SHADOW ↔ PRESS_UNLOCKED, and the return type of decideAutomaticTransition forbids ENABLED.",
      ],
    },
    generatedAtIso: input.nowIso,
  });

  return {
    ...base,
    promotion: {
      currentStatus: input.currentStatus,
      statusReadError: input.statusReadError ?? null,
      ladder: LADDER,
      thresholds,
    },
    fillQuality: {
      qualifyingCount: ev?.qualifyingCount ?? null,
      measuredAdvantageCount: ev?.measuredAdvantageCount ?? null,
      dominantAdvantageShape: ev?.dominantAdvantageShape ?? null,
      advantageConsistency01: ev?.advantageConsistency01 ?? null,
    },
  };
}

function notMeasured(
  key: string,
  label: string,
  target: string,
  why: string,
): EvidenceMeasurement {
  return {
    key,
    label,
    value: null,
    unit: "count",
    target,
    met: null,
    note: `NOT MEASURED — ${why}`,
  };
}
