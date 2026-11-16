import type { ReplayPacket, IntegrityFlag } from "./blackBox.types";

// ═══════════════════════════════════════════════════════════════════════════
// Data Integrity Engine — pure scanner that flags BAD DATA before it
// trains the AI. Project rule: bad data must be flagged before it trains.
//
// Categories:
//   • MISSING_REFERENCE          — packet refers to a record that wasn't found
//   • DUPLICATE_ID               — duplicate ids within a packet's lists
//   • TIME_PARADOX               — execution before decision, outcome before exec
//   • NEGATIVE_OR_INVALID_VALUE  — negative spread / negative latency / etc
//   • CONFIDENCE_OUTCOME_MISMATCH — extreme confidence vs opposite outcome
//   • DANGLING_REPLAY            — packet has neither tradeId nor signalId
//   • STALE_OR_FROZEN_DATA       — entire packet collapsed to one timestamp
//
// Pure: deterministic, no IO.
// ═══════════════════════════════════════════════════════════════════════════

export const INTEGRITY_TUNING = {
  // |confidence - actualWin| at/above this is treated as a critical mismatch.
  confidenceOutcomeMismatchAbs: 0.7,
  // If every record in a packet shares the exact same recordedAtIso AND
  // there are at least this many records, flag as suspicious (frozen feed).
  frozenDataMinRecords: 4,
} as const;

export interface IntegrityScanContext {
  newFlagId(): string;
}

export function scanPacketIntegrity(
  packet: ReplayPacket,
  ctx: IntegrityScanContext,
): { flags: IntegrityFlag[]; reasons: string[] } {
  const flags: IntegrityFlag[] = [];
  const reasons: string[] = [];

  // ── DANGLING_REPLAY ─────────────────────────────────────────────────────
  if (!packet.tradeId && !packet.signalId) {
    flags.push(mk(ctx, `packet:${packet.packetId}`, "DANGLING_REPLAY", "CRITICAL",
      `packet ${packet.packetId} has neither tradeId nor signalId — cannot be linked to any setup`,
      [`isBlocked=${packet.isBlocked}`]));
  }

  // ── MISSING_REFERENCE — propagate build-time blockers ───────────────────
  if (packet.blockers.length > 0) {
    flags.push(mk(ctx, `packet:${packet.packetId}`, "MISSING_REFERENCE", "WARN",
      `packet ${packet.packetId} reported ${packet.blockers.length} build blocker(s)`,
      [...packet.blockers]));
  }

  // ── MISSING_REFERENCE — independently re-validate cross-links so a packet
  //    constructed elsewhere (or with incomplete blockers) cannot pass. ──
  const decisionIdSet     = new Set(packet.decisions.map((d) => d.decisionId));
  const marketTruthIdSet  = new Set(packet.marketTruths.map((m) => m.marketTruthId));
  for (const e of packet.executions) {
    if (!decisionIdSet.has(e.decisionId)) {
      flags.push(mk(ctx, `execution:${e.executionId}`, "MISSING_REFERENCE", "CRITICAL",
        `execution ${e.executionId} references unknown decisionId ${e.decisionId}`,
        [`decisionId=${e.decisionId}`]));
    }
  }
  for (const d of packet.decisions) {
    if (d.marketTruthId && !marketTruthIdSet.has(d.marketTruthId)) {
      flags.push(mk(ctx, `decision:${d.decisionId}`, "MISSING_REFERENCE", "CRITICAL",
        `decision ${d.decisionId} references unknown marketTruthId ${d.marketTruthId}`,
        [`marketTruthId=${d.marketTruthId}`]));
    }
  }
  if (packet.outcome) {
    if (packet.outcome.decisionId && !decisionIdSet.has(packet.outcome.decisionId)) {
      flags.push(mk(ctx, `outcome:${packet.outcome.outcomeId}`, "MISSING_REFERENCE", "CRITICAL",
        `outcome ${packet.outcome.outcomeId} references unknown decisionId ${packet.outcome.decisionId}`,
        [`decisionId=${packet.outcome.decisionId}`]));
    }
    if (packet.tradeId && packet.outcome.tradeId !== packet.tradeId) {
      flags.push(mk(ctx, `outcome:${packet.outcome.outcomeId}`, "MISSING_REFERENCE", "CRITICAL",
        `outcome.tradeId ${packet.outcome.tradeId} ≠ packet.tradeId ${packet.tradeId}`,
        []));
    }
  }
  for (const e of packet.executions) {
    if (packet.tradeId && e.tradeId !== packet.tradeId) {
      flags.push(mk(ctx, `execution:${e.executionId}`, "MISSING_REFERENCE", "CRITICAL",
        `execution.tradeId ${e.tradeId} ≠ packet.tradeId ${packet.tradeId}`,
        []));
    }
  }

  // ── DUPLICATE_ID within each inner list ─────────────────────────────────
  dupCheck(flags, ctx, packet.packetId, "decisionId",  packet.decisions.map((d) => d.decisionId));
  dupCheck(flags, ctx, packet.packetId, "executionId", packet.executions.map((e) => e.executionId));
  dupCheck(flags, ctx, packet.packetId, "behaviorId",  packet.behaviors.map((b) => b.behaviorId));
  dupCheck(flags, ctx, packet.packetId, "marketTruthId",
           packet.marketTruths.map((m) => m.marketTruthId));

  // ── NEGATIVE_OR_INVALID_VALUE ───────────────────────────────────────────
  for (const m of packet.marketTruths) {
    if (m.spreadPips < 0 || m.latencyMs < 0 || m.bid <= 0 || m.ask <= 0 || m.ask < m.bid) {
      flags.push(mk(ctx, `marketTruth:${m.marketTruthId}`, "NEGATIVE_OR_INVALID_VALUE", "CRITICAL",
        `marketTruth ${m.marketTruthId} has invalid bid/ask/spread/latency`,
        [`bid=${m.bid}`, `ask=${m.ask}`, `spreadPips=${m.spreadPips}`, `latencyMs=${m.latencyMs}`]));
    }
  }
  for (const e of packet.executions) {
    if (e.latencyMs < 0 || e.spreadPipsAtFill < 0
        || e.fillPrice <= 0 || e.requestedPrice <= 0 || e.filledSizeLots <= 0) {
      flags.push(mk(ctx, `execution:${e.executionId}`, "NEGATIVE_OR_INVALID_VALUE", "CRITICAL",
        `execution ${e.executionId} has invalid numeric fields`,
        [`latencyMs=${e.latencyMs}`, `spreadPipsAtFill=${e.spreadPipsAtFill}`,
         `fillPrice=${e.fillPrice}`, `requestedPrice=${e.requestedPrice}`,
         `filledSizeLots=${e.filledSizeLots}`]));
    }
  }

  // ── TIME_PARADOX ────────────────────────────────────────────────────────
  // For each execution, the linked decision must come at or before it; for
  // the outcome, both decisions and executions must come at or before.
  const decisionById = new Map(packet.decisions.map((d) => [d.decisionId, d] as const));
  for (const e of packet.executions) {
    const d = decisionById.get(e.decisionId);
    if (d && e.recordedAtIso < d.recordedAtIso) {
      flags.push(mk(ctx, `execution:${e.executionId}`, "TIME_PARADOX", "CRITICAL",
        `execution ${e.executionId} occurred BEFORE its decision ${d.decisionId}`,
        [`exec ${e.recordedAtIso} < decision ${d.recordedAtIso}`]));
    }
  }
  if (packet.outcome) {
    const oIso = packet.outcome.recordedAtIso;
    for (const d of packet.decisions) {
      if (oIso < d.recordedAtIso) {
        flags.push(mk(ctx, `outcome:${packet.outcome.outcomeId}`, "TIME_PARADOX", "CRITICAL",
          `outcome occurred BEFORE decision ${d.decisionId}`,
          [`outcome ${oIso} < decision ${d.recordedAtIso}`]));
        break;
      }
    }
    for (const e of packet.executions) {
      if (oIso < e.recordedAtIso) {
        flags.push(mk(ctx, `outcome:${packet.outcome.outcomeId}`, "TIME_PARADOX", "CRITICAL",
          `outcome occurred BEFORE execution ${e.executionId}`,
          [`outcome ${oIso} < execution ${e.recordedAtIso}`]));
        break;
      }
    }
  }

  // ── CONFIDENCE_OUTCOME_MISMATCH ─────────────────────────────────────────
  if (packet.outcome) {
    const actualWin = packet.outcome.pnlR > 0 ? 1 : 0;
    for (const d of packet.decisions) {
      if (typeof d.confidence01 === "number") {
        const err = Math.abs(d.confidence01 - actualWin);
        if (err >= INTEGRITY_TUNING.confidenceOutcomeMismatchAbs) {
          flags.push(mk(ctx, `decision:${d.decisionId}`, "CONFIDENCE_OUTCOME_MISMATCH", "WARN",
            `decision ${d.decisionId} confidence ${d.confidence01.toFixed(2)} vs actualWin ${actualWin} (err ${err.toFixed(2)})`,
            [`pnlR=${packet.outcome.pnlR.toFixed(3)}`,
             `threshold=${INTEGRITY_TUNING.confidenceOutcomeMismatchAbs}`]));
        }
      }
    }
  }

  // ── STALE_OR_FROZEN_DATA ────────────────────────────────────────────────
  const allIsos: string[] = [
    ...packet.decisions.map((d) => d.recordedAtIso),
    ...packet.executions.map((e) => e.recordedAtIso),
    ...packet.marketTruths.map((m) => m.recordedAtIso),
    ...packet.behaviors.map((b) => b.recordedAtIso),
  ];
  if (packet.outcome) allIsos.push(packet.outcome.recordedAtIso);
  if (allIsos.length >= INTEGRITY_TUNING.frozenDataMinRecords) {
    const distinct = new Set(allIsos);
    if (distinct.size === 1) {
      flags.push(mk(ctx, `packet:${packet.packetId}`, "STALE_OR_FROZEN_DATA", "WARN",
        `every record in packet ${packet.packetId} shares the same timestamp ${[...distinct][0]} — possible frozen feed`,
        [`recordCount=${allIsos.length}`]));
    }
  }

  reasons.push(`scanned packet ${packet.packetId}: ${flags.length} flag(s)`);
  return { flags, reasons };
}

// Convenience wrapper to scan many packets at once.
export function scanManyPackets(
  packets: readonly ReplayPacket[],
  ctx: IntegrityScanContext,
): { flags: IntegrityFlag[]; reasons: string[] } {
  const allFlags: IntegrityFlag[] = [];
  const reasons: string[] = [];
  for (const p of packets) {
    const r = scanPacketIntegrity(p, ctx);
    allFlags.push(...r.flags);
    reasons.push(...r.reasons);
  }
  reasons.push(`scanned ${packets.length} packets — ${allFlags.length} total flag(s)`);
  return { flags: allFlags, reasons };
}

// ── helpers ────────────────────────────────────────────────────────────────
function mk(
  ctx: IntegrityScanContext,
  recordRef: string,
  category: IntegrityFlag["category"],
  severity: IntegrityFlag["severity"],
  description: string,
  reasons: string[],
): IntegrityFlag {
  return { flagId: ctx.newFlagId(), recordRef, category, severity, description, reasons };
}

function dupCheck(
  flags: IntegrityFlag[],
  ctx: IntegrityScanContext,
  packetId: string,
  label: string,
  ids: readonly string[],
): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      flags.push(mk(ctx, `packet:${packetId}`, "DUPLICATE_ID", "CRITICAL",
        `duplicate ${label} ${id} inside packet ${packetId}`,
        [`label=${label}`, `id=${id}`]));
    }
    seen.add(id);
  }
}
