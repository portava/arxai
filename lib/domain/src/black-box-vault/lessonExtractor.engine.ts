import type { ReplayPacket, Lesson, OutcomeTruthRecord } from "./blackBox.types";

// ═══════════════════════════════════════════════════════════════════════════
// Lesson Extractor — pure function that scans a ReplayPacket and returns
// structured Lessons. Categories detected:
//   • CONFIDENCE_CALIBRATION — predicted high but lost (or vice versa)
//   • EDGE_DECAY            — repeated misses for this strategy/regime
//                              (caller supplies recentMissRate via opts)
//   • REGIME_MISMATCH       — outcome contradicts regime expectation
//   • EXECUTION_QUALITY     — slippage / latency outside tolerances
//   • RULE_BREAK            — operator overrode a DENIED decision
//
// Pure: no IO. Deterministic. Returns Lessons + structured reasons.
// ═══════════════════════════════════════════════════════════════════════════

export const LESSON_TUNING = {
  // Calibration deemed "miscalibrated" when |confidence - actualWin| >= this.
  calibrationErrorAbsHigh: 0.35,
  // Slippage warning threshold (pips).
  slippagePipsHigh: 3.0,
  // Latency warning threshold (ms).
  latencyMsHigh: 500,
  // Edge-decay miss rate (caller-supplied) treated as suspicious.
  edgeDecayRecentMissRate: 0.6,
} as const;

export interface LessonExtractionContext {
  /** Optional recent miss rate for the strategy×regime in this packet. */
  recentStrategyMissRate01?: number;
  /** Caller-supplied id factory for stable lessonIds across runs. */
  newLessonId(): string;
  recordedAtIso: string;
}

export function extractLessons(
  packet: ReplayPacket,
  ctx: LessonExtractionContext,
): { lessons: Lesson[]; reasons: string[]; blockers: string[] } {
  const lessons: Lesson[] = [];
  const reasons: string[] = [];
  const blockers: string[] = [];

  // Defensive: refuse to extract on a packet that itself reports build blockers.
  if (packet.blockers.length > 0) {
    blockers.push(`packet ${packet.packetId} carries ${packet.blockers.length} build blocker(s) — refusing to extract lessons from incomplete data`);
    return { lessons, reasons, blockers };
  }

  // ── 1. RULE_BREAK: operator overrode a DENIED decision ──────────────────
  const deniedDecisionIds = new Set(
    packet.decisions.filter((d) => d.verdict === "DENIED").map((d) => d.decisionId),
  );
  for (const b of packet.behaviors) {
    if (b.behaviorKind === "OVERRIDE_BLOCK"
        && b.targetDecisionId
        && deniedDecisionIds.has(b.targetDecisionId)) {
      lessons.push({
        lessonId: ctx.newLessonId(),
        packetId: packet.packetId,
        category: "RULE_BREAK",
        severity: "CRITICAL",
        description: `Operator overrode DENIED decision ${b.targetDecisionId}`,
        reasons: [`behaviour ${b.behaviorId} kind=OVERRIDE_BLOCK targeted denied decision`],
        recordedAtIso: ctx.recordedAtIso,
      });
    }
  }

  // ── 2. EXECUTION_QUALITY: high slippage / latency ───────────────────────
  for (const e of packet.executions) {
    if (Math.abs(e.slippagePips) > LESSON_TUNING.slippagePipsHigh) {
      lessons.push({
        lessonId: ctx.newLessonId(),
        packetId: packet.packetId,
        category: "EXECUTION_QUALITY",
        severity: "WARN",
        description: `Slippage ${e.slippagePips.toFixed(2)} pips on execution ${e.executionId}`,
        reasons: [`|slippage| ${Math.abs(e.slippagePips).toFixed(2)} > tolerance ${LESSON_TUNING.slippagePipsHigh}`],
        recordedAtIso: ctx.recordedAtIso,
      });
    }
    if (e.latencyMs > LESSON_TUNING.latencyMsHigh) {
      lessons.push({
        lessonId: ctx.newLessonId(),
        packetId: packet.packetId,
        category: "EXECUTION_QUALITY",
        severity: "WARN",
        description: `Execution latency ${e.latencyMs}ms on ${e.executionId}`,
        reasons: [`latency ${e.latencyMs}ms > tolerance ${LESSON_TUNING.latencyMsHigh}ms`],
        recordedAtIso: ctx.recordedAtIso,
      });
    }
  }

  // ── 3 + 4 require an outcome ────────────────────────────────────────────
  const outcome: OutcomeTruthRecord | undefined = packet.outcome;
  if (!outcome) {
    reasons.push(`no outcome on packet ${packet.packetId} — skipping calibration / regime lessons`);
  } else {
    // CONFIDENCE_CALIBRATION
    const decisionWithConfidence = packet.decisions.find((d) => typeof d.confidence01 === "number");
    if (decisionWithConfidence && typeof decisionWithConfidence.confidence01 === "number") {
      const actualWin = outcome.pnlR > 0 ? 1 : 0;
      const errorAbs = Math.abs(decisionWithConfidence.confidence01 - actualWin);
      if (errorAbs >= LESSON_TUNING.calibrationErrorAbsHigh) {
        lessons.push({
          lessonId: ctx.newLessonId(),
          packetId: packet.packetId,
          category: "CONFIDENCE_CALIBRATION",
          severity: errorAbs >= 0.5 ? "CRITICAL" : "WARN",
          description: `Confidence ${decisionWithConfidence.confidence01.toFixed(2)} vs actual win ${actualWin}`,
          reasons: [
            `predictionError ${errorAbs.toFixed(2)} >= threshold ${LESSON_TUNING.calibrationErrorAbsHigh}`,
            `pnlR ${outcome.pnlR.toFixed(3)}`,
          ],
          recordedAtIso: ctx.recordedAtIso,
        });
      }
    } else {
      reasons.push(`no decision carried confidence01 — calibration lesson skipped`);
    }

    // REGIME_MISMATCH — strategy keyed for regime X but outcome was a loss
    // and packet's regime envelope differs from the strategy expectation
    // (we use a simple proxy: any losing trade where regimeId is set logs
    // a low-severity hint so callers can group + dig deeper).
    if (outcome.pnlR < 0 && packet.envelope.regimeId) {
      lessons.push({
        lessonId: ctx.newLessonId(),
        packetId: packet.packetId,
        category: "REGIME_MISMATCH",
        severity: "INFO",
        description: `Loss in regime ${packet.envelope.regimeId} — review regime fit`,
        reasons: [`pnlR ${outcome.pnlR.toFixed(3)} < 0`, `regimeId=${packet.envelope.regimeId}`],
        recordedAtIso: ctx.recordedAtIso,
      });
    }
  }

  // ── 5. EDGE_DECAY — caller-supplied recent miss rate exceeds threshold ──
  const miss = ctx.recentStrategyMissRate01;
  if (typeof miss === "number") {
    const clamped = Math.max(0, Math.min(1, miss));
    if (clamped >= LESSON_TUNING.edgeDecayRecentMissRate) {
      lessons.push({
        lessonId: ctx.newLessonId(),
        packetId: packet.packetId,
        category: "EDGE_DECAY",
        severity: clamped >= 0.8 ? "CRITICAL" : "WARN",
        description: `Recent miss rate ${(clamped * 100).toFixed(0)}% suggests strategy edge decay`,
        reasons: [`recentMissRate ${clamped.toFixed(2)} >= threshold ${LESSON_TUNING.edgeDecayRecentMissRate}`],
        recordedAtIso: ctx.recordedAtIso,
      });
    }
  }

  reasons.push(`extracted ${lessons.length} lesson(s) from packet ${packet.packetId}`);
  return { lessons, reasons, blockers };
}
