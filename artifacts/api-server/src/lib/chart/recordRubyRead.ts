// Chart Brain v2 — Task 5: flow wiring for decision memory (Slow Brain).
//
// This is the glue that makes the decision-memory layer ACTIVE: every official
// Ruby read / chart trade plan calls recordRubyReadDecision(), which (a) writes
// ONE immutable Decision Receipt capturing what the chart + intelligence layers
// said at decision time, and (b) records the meaningful chart EVENTS implied by
// that read (ruby_recommendation, no_trade, risk_veto, court_conflict,
// setup_stale/invalid) into per-user chart-event memory.
//
// STRICT SAFETY CONTRACT:
//   - Fire-and-forget: callers invoke this with `void` and it is NEVER awaited
//     on the request hot path, so it adds no latency to the Ruby read.
//   - Fail-open: it never throws into the caller. Any error (provider, DB) is
//     swallowed and logged; the user's read is unaffected.
//   - Slow Brain only: this runs on read-only Ruby surfaces. It is never called
//     from the live execution / candle-render / 16-gate dispatch path and can
//     never block a trade.
//   - Per-user: every write carries the caller's userId.

import { buildChartIntelligenceState } from "../data/chart/chartIntelligence.js";
import type { ChartIntelligenceState } from "../data/chart/chartIntelligence.js";
import { isChartTimeframe } from "../data/chart/timeframes.js";
import type { ChartTimeframe } from "../data/chart/timeframes.js";
import { buildRubyDraftRead } from "../assistant/rubyDraftRead.js";
import type { RubyDraftIntent } from "../assistant/rubyDraftRead.js";
import { getAssistantDisplayName } from "../assistant/assistantName.js";
import { logger } from "../logger.js";
import {
  buildSetupFingerprint,
  type ChartSetupFingerprint,
} from "./setupFingerprint.js";
import { createDecisionReceipt, type ReceiptSource } from "./decisionReceipts.js";
import {
  recordChartDecisionEvents,
  type ChartDecisionEventInput,
} from "./chartDecisionMemory.js";

export interface RecordRubyReadArgs {
  userId: number;
  source: ReceiptSource;
  /** The user-facing intent of the read (free-form; defaults to "analyze"). */
  intent?: string | null;
  /** The draft-read intent used to shape the deterministic read. */
  draftReadIntent?: RubyDraftIntent;
  direction?: "BUY" | "SELL" | "NEUTRAL" | null;
  symbol: string;
  timeframe: string;
  limit?: number;
  /** Optional pre-built state to avoid a second build on endpoints that have one. */
  state?: ChartIntelligenceState;
}

/**
 * Derive the meaningful chart events implied by a Ruby read from its (already
 * deterministic) setup fingerprint. Always emits a ruby_recommendation; adds
 * no_trade / risk_veto / court_conflict / setup_stale / setup_invalid honestly
 * when the fingerprint says so. Never fabricates.
 */
function deriveEvents(
  args: RecordRubyReadArgs,
  fp: ChartSetupFingerprint,
  headline: string | null,
  receiptRef: string | null,
  assistant: string,
): ChartDecisionEventInput[] {
  const base = {
    userId: args.userId,
    symbol: args.symbol,
    timeframe: args.timeframe,
    // Event direction is BUY|SELL|null — a NEUTRAL read carries no direction.
    direction: fp.direction === "NEUTRAL" ? null : fp.direction,
    regime: fp.regime,
    setupStage: fp.stage,
    readinessScore: fp.readinessScore,
    qualityLabel: fp.qualityLabel,
    receiptRef,
  } as const;

  const events: ChartDecisionEventInput[] = [
    {
      ...base,
      eventType: "ruby_recommendation",
      summary: headline ?? `${assistant} read recorded for ${args.symbol} ${args.timeframe}.`,
    },
  ];

  const vetoed = fp.riskStatus === "veto";
  if (fp.direction === "NEUTRAL" || vetoed) {
    events.push({
      ...base,
      eventType: "no_trade",
      summary: vetoed
        ? `${assistant} held back — risk veto in play.`
        : `${assistant} saw no clear directional edge — no trade.`,
    });
  }
  if (vetoed) {
    events.push({ ...base, eventType: "risk_veto", summary: "Risk-AI vetoed this setup." });
  }
  if (fp.agentAgreement === "conflict") {
    events.push({
      ...base,
      eventType: "court_conflict",
      summary: "Agents disagreed on this read.",
    });
  }
  if (fp.freshnessBucket === "stale") {
    events.push({ ...base, eventType: "setup_stale", summary: "Setup has gone stale." });
  }
  if (/invalid/i.test(fp.stage)) {
    events.push({
      ...base,
      eventType: "setup_invalid",
      summary: "Setup invalidated by structure.",
    });
  }
  return events;
}

/**
 * Fire-and-forget: record an immutable receipt + the implied chart events for an
 * official Ruby read. Call with `void recordRubyReadDecision(...)`. Never throws,
 * never blocks, never on the live path.
 */
export function recordRubyReadDecision(args: RecordRubyReadArgs): void {
  // Detach from the request lifecycle entirely. Any failure is contained here.
  void (async () => {
    try {
      // The intelligence engine accepts only canonical ARX timeframes. If a
      // caller passes a non-canonical timeframe (and gave us no prebuilt state),
      // we honestly skip rather than fabricate a state for an unsupported TF.
      const tf = args.timeframe.toUpperCase();
      if (!args.state && !isChartTimeframe(tf)) return;
      const state =
        args.state ??
        (await buildChartIntelligenceState(
          args.symbol,
          tf as ChartTimeframe,
          args.limit ?? 300,
        ));
      const draftRead = buildRubyDraftRead(
        state,
        args.draftReadIntent ?? "analyze",
        null,
      );
      const receipt = await createDecisionReceipt({
        userId: args.userId,
        state,
        draftRead,
        source: args.source,
        intent: args.intent ?? draftRead.intent ?? "analyze",
        direction: args.direction ?? null,
      });

      // Events are recorded even if the receipt write failed (receiptRef null),
      // so chart-event memory still captures the flow honestly.
      const fp = buildSetupFingerprint(state, {
        direction: args.direction ?? undefined,
      });
      const assistant = await getAssistantDisplayName(args.userId);
      const events = deriveEvents(
        args,
        fp,
        draftRead.headline ?? null,
        receipt?.receiptId ?? null,
        assistant,
      );
      await recordChartDecisionEvents(events);
    } catch (err) {
      logger.warn(
        { err, userId: args.userId, symbol: args.symbol, source: args.source },
        "recordRubyReadDecision: best-effort decision-memory write failed (ignored)",
      );
    }
  })();
}
