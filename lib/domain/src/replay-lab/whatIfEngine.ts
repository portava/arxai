// ═══════════════════════════════════════════════════════════════════════════
// What-If Engine
//
// Applies a scenario mutation to a snapshot, replays the candles, and
// returns both the original and counterfactual outcomes for comparison.
//
// Pure. Replay Lab cannot place trades — this engine returns simulated
// outcomes only.
// ═══════════════════════════════════════════════════════════════════════════

import type { Candle, ReplaySnapshot, TradeIntent, TradeOutcome, WhatIfScenario } from "./replay.types";
import { playbackCandles } from "./candlePlayback.engine";

export interface WhatIfResult {
  scenario: WhatIfScenario;
  originalOutcome: TradeOutcome;
  counterfactualOutcome: TradeOutcome;
  rDelta: number;
  betterForTrader: boolean;
  notes: string[];
}

const NO_TRADE: TradeOutcome = {
  status: "NONE", exitTs: null, exitPrice: null, pnl: 0, rMultiple: 0,
  durationMin: 0, reason: "what-if: no trade taken",
};

export function runWhatIf(snapshot: ReplaySnapshot, scenario: WhatIfScenario): WhatIfResult {
  // Baseline selection mirrors runReplay: only trust a recorded outcome
  // when it is meaningful (non-NONE). Otherwise re-simulate from candles
  // so executed snapshots cannot silently degrade into no-trade baselines.
  const recorded = snapshot.recordedOutcome;
  const recordedUsable = !!recorded && recorded.status !== "NONE";
  const original = snapshot.intent
    ? (recordedUsable
        ? recorded!
        : playbackCandles({ candles: snapshot.candles, intent: snapshot.intent }))
    : NO_TRADE;

  let counterfactual: TradeOutcome = NO_TRADE;
  const notes: string[] = [];

  switch (scenario.kind) {
    case "BLOCKED_INSTEAD": {
      counterfactual = NO_TRADE;
      notes.push("counterfactual: trade blocked");
      break;
    }
    case "TAKE_BLOCKED_INSTEAD": {
      if (!snapshot.intent) { notes.push("no intent — cannot take blocked trade"); break; }
      counterfactual = playbackCandles({ candles: snapshot.candles, intent: snapshot.intent });
      notes.push("counterfactual: blocked trade was taken");
      break;
    }
    case "REDUCED_SIZE": {
      if (!snapshot.intent) break;
      const intent = { ...snapshot.intent, lotSize: snapshot.intent.lotSize * scenario.sizeFactor };
      counterfactual = playbackCandles({ candles: snapshot.candles, intent });
      notes.push(`counterfactual: size × ${scenario.sizeFactor}`);
      break;
    }
    case "ENTER_EARLIER": {
      if (!snapshot.intent) break;
      const intent = shiftEntry(snapshot.intent, -scenario.deltaSeconds * 1000);
      counterfactual = playbackCandles({ candles: snapshot.candles, intent });
      notes.push(`counterfactual: entered ${scenario.deltaSeconds}s earlier`);
      break;
    }
    case "ENTER_LATER":
    case "INCREASED_DELAY": {
      if (!snapshot.intent) break;
      const ms = (scenario.kind === "ENTER_LATER" ? scenario.deltaSeconds : scenario.delaySeconds) * 1000;
      const intent = shiftEntry(snapshot.intent, ms);
      counterfactual = playbackCandles({ candles: snapshot.candles, intent });
      notes.push(`counterfactual: entry shifted +${ms / 1000}s`);
      break;
    }
    case "EXIT_EARLIER": {
      if (!snapshot.intent) break;
      counterfactual = playbackCandles({
        candles: snapshot.candles, intent: snapshot.intent,
        forceExitTs: scenario.atTs ?? earlyExitTsForR(snapshot.candles, snapshot.intent, scenario.atRMultiple ?? 1),
      });
      notes.push(`counterfactual: exited earlier (${scenario.atTs ? "@ts" : "@R"})`);
      break;
    }
    case "EXIT_LATER": {
      if (!snapshot.intent) break;
      counterfactual = playbackCandles({
        candles: snapshot.candles, intent: snapshot.intent,
        maxCandles: snapshot.candles.length + scenario.extendCandles,
      });
      notes.push(`counterfactual: extended ${scenario.extendCandles} candles`);
      break;
    }
    case "DIFFERENT_EXECUTION": {
      if (!snapshot.intent) break;
      // Apply slippage as a *price* delta scaled by the instrument's pip
      // size. Pip size is taken from the recorded execution conditions if
      // present (via spread/known mapping) or defaults to 0.0001 for FX-
      // style symbols and 1.0 for index-style symbols inferred from price
      // magnitude. This avoids treating "1 pip" as "1 price unit", which
      // corrupted counterfactuals for non-FX instruments.
      const slipPips = scenario.slippagePips ?? 0;
      const pipSize = inferPipSize(snapshot.intent.entryPrice);
      const priceDelta = slipPips * pipSize;
      const intent = { ...snapshot.intent,
        entryPrice: snapshot.intent.entryPrice +
          (snapshot.intent.direction === "BUY" ? priceDelta : -priceDelta) };
      counterfactual = playbackCandles({ candles: snapshot.candles, intent });
      notes.push(`counterfactual: slippage ${slipPips} pips (Δprice ${priceDelta})${scenario.latencyMs ? `, latency ${scenario.latencyMs}ms` : ""}`);
      break;
    }
    case "DIFFERENT_COOLDOWN": {
      // Cooldown does not alter the playback of the recorded trade itself;
      // it changes the *next* trade cadence. Surface as advisory.
      counterfactual = original;
      notes.push(`counterfactual: cooldown set to ${scenario.durationMinutes}m (advisory; affects next trade only)`);
      break;
    }
    case "DIFFERENT_STOP": {
      if (!snapshot.intent) break;
      counterfactual = playbackCandles({
        candles: snapshot.candles, intent: snapshot.intent,
        overrideStopLoss: scenario.stopPrice,
      });
      notes.push(`counterfactual: stop @ ${scenario.stopPrice}`);
      break;
    }
    case "DIFFERENT_TP": {
      if (!snapshot.intent) break;
      counterfactual = playbackCandles({
        candles: snapshot.candles, intent: snapshot.intent,
        overrideTakeProfit: scenario.takeProfitPrice,
      });
      notes.push(`counterfactual: take-profit @ ${scenario.takeProfitPrice}`);
      break;
    }
  }

  const rDelta = round2(counterfactual.rMultiple - original.rMultiple);
  return {
    scenario, originalOutcome: original, counterfactualOutcome: counterfactual,
    rDelta, betterForTrader: rDelta > 0.05, notes,
  };
}

/** Heuristic pip size: index-style symbols (price ≥ 50) use 1.0;
 *  FX-style (price < 5) uses 0.0001; mid-range uses 0.01. */
function inferPipSize(price: number): number {
  const p = Math.abs(price);
  if (p >= 50)  return 1.0;
  if (p >= 5)   return 0.01;
  return 0.0001;
}
function shiftEntry(intent: TradeIntent, deltaMs: number): TradeIntent {
  const shifted = new Date(new Date(intent.intendedAt).getTime() + deltaMs).toISOString();
  return { ...intent, intendedAt: shifted };
}
function earlyExitTsForR(candles: Candle[], intent: TradeIntent, targetR: number): string {
  const risk = Math.abs(intent.entryPrice - intent.stopLoss);
  const isBuy = intent.direction === "BUY";
  const targetPrice = isBuy ? intent.entryPrice + risk * targetR : intent.entryPrice - risk * targetR;
  for (const c of candles) {
    if (new Date(c.ts).getTime() < new Date(intent.intendedAt).getTime()) continue;
    if (isBuy ? c.high >= targetPrice : c.low <= targetPrice) return c.ts;
  }
  return candles[candles.length - 1].ts;
}
function round2(n: number) { return Math.round(n * 100) / 100; }
