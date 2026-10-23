// ═══════════════════════════════════════════════════════════════════════════
// Replay Stress Injection
//
// Mutates a snapshot's candles / execution / market context to simulate:
//   • SPREAD_SPIKE       — widen spread for the entry bar(s)
//   • SLIPPAGE           — apply price-scaled slippage at entry
//   • LATENCY            — push entry timestamp forward by N ms
//   • FAKE_BREAKOUT      — extend the wick beyond the stop in the entry bar
//   • VOLATILITY_SHOCK   — multiply candle ranges by a factor
//   • DELAYED_EXECUTION  — delay entry by N candles
//
// Returns a mutated snapshot suitable for re-running through runReplay or
// runWhatIf. Pure.
// ═══════════════════════════════════════════════════════════════════════════

import { z } from "zod/v4";
import type { Candle, ReplaySnapshot } from "../replay.types";

export const StressInjectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("SPREAD_SPIKE"),    extraSpreadPips: z.number().positive() }),
  z.object({ kind: z.literal("SLIPPAGE"),        slippagePips: z.number() }),
  z.object({ kind: z.literal("LATENCY"),         latencyMs: z.number().nonnegative() }),
  z.object({ kind: z.literal("FAKE_BREAKOUT"),   pierceFraction: z.number().positive().default(1.2) }),
  z.object({ kind: z.literal("VOLATILITY_SHOCK"),rangeMultiplier: z.number().positive() }),
  z.object({ kind: z.literal("DELAYED_EXECUTION"),delayCandles: z.number().int().positive() }),
]);
export type StressInjection = z.infer<typeof StressInjectionSchema>;

export interface StressInjectionResult {
  kind: StressInjection["kind"];
  mutatedSnapshot: ReplaySnapshot;
  notes: string[];
}

function inferPipSize(price: number): number {
  const p = Math.abs(price);
  if (p >= 50) return 1.0;
  if (p >= 5)  return 0.01;
  return 0.0001;
}

export function injectReplayStress(
  snapshot: ReplaySnapshot, stress: StressInjection,
): StressInjectionResult {
  const notes: string[] = [];
  let mutated: ReplaySnapshot = { ...snapshot, candles: snapshot.candles.map(c => ({ ...c })) };

  switch (stress.kind) {
    case "SPREAD_SPIKE": {
      mutated = {
        ...mutated,
        market: { ...mutated.market, spreadPips: mutated.market.spreadPips + stress.extraSpreadPips },
      };
      notes.push(`spread widened by ${stress.extraSpreadPips} pips`);
      break;
    }
    case "SLIPPAGE": {
      if (mutated.intent) {
        const pip = inferPipSize(mutated.intent.entryPrice);
        const delta = stress.slippagePips * pip;
        const sign = mutated.intent.direction === "BUY" ? 1 : -1;
        mutated = { ...mutated,
          intent: { ...mutated.intent, entryPrice: mutated.intent.entryPrice + sign * delta } };
        notes.push(`slippage ${stress.slippagePips} pips → entry shifted ${sign * delta}`);
      }
      break;
    }
    case "LATENCY": {
      if (mutated.intent) {
        const newTs = new Date(new Date(mutated.intent.intendedAt).getTime() + stress.latencyMs).toISOString();
        mutated = { ...mutated, intent: { ...mutated.intent, intendedAt: newTs } };
      }
      if (mutated.execution) {
        mutated = { ...mutated,
          execution: { ...mutated.execution, latencyMs: mutated.execution.latencyMs + stress.latencyMs } };
      }
      notes.push(`latency added ${stress.latencyMs}ms`);
      break;
    }
    case "FAKE_BREAKOUT": {
      if (mutated.intent) {
        const intent = mutated.intent;
        const stopDist = Math.abs(intent.entryPrice - intent.stopLoss);
        const pierce = stopDist * stress.pierceFraction;
        // Find the actual entry bar — first candle whose ts >= intendedAt.
        // Falls back to the first candle if all bars precede intent.
        const entryMs = new Date(intent.intendedAt).getTime();
        let entryIdx = mutated.candles.findIndex(c => new Date(c.ts).getTime() >= entryMs);
        if (entryIdx === -1) entryIdx = 0;
        const candles: Candle[] = mutated.candles.map((c, i) => {
          if (i !== entryIdx) return c;
          if (intent.direction === "BUY") return { ...c, low:  Math.min(c.low,  intent.stopLoss - pierce) };
          return { ...c, high: Math.max(c.high, intent.stopLoss + pierce) };
        });
        mutated = { ...mutated, candles };
        notes.push(`fake breakout: entry-bar #${entryIdx} pierced stop by ${stress.pierceFraction}×`);
      }
      break;
    }
    case "VOLATILITY_SHOCK": {
      const candles: Candle[] = mutated.candles.map(c => {
        const mid = (c.high + c.low) / 2;
        const halfRange = ((c.high - c.low) / 2) * stress.rangeMultiplier;
        return { ...c,
          high: mid + halfRange,
          low:  mid - halfRange,
          open:  mid + (c.open  - mid) * stress.rangeMultiplier,
          close: mid + (c.close - mid) * stress.rangeMultiplier,
        };
      });
      mutated = { ...mutated, candles,
        market: { ...mutated.market,
          realizedVolPct: mutated.market.realizedVolPct * stress.rangeMultiplier,
          volatilityBand: stress.rangeMultiplier >= 2 ? "EXTREME" : mutated.market.volatilityBand } };
      notes.push(`volatility shock × ${stress.rangeMultiplier}`);
      break;
    }
    case "DELAYED_EXECUTION": {
      // Locate the original entry bar, then push entry forward by N bars.
      // If the delay would exit the candle window, clamp to the last bar
      // and surface a note so callers can see boundary behavior explicitly.
      if (mutated.intent) {
        const entryMs = new Date(mutated.intent.intendedAt).getTime();
        const startIdx = Math.max(0,
          mutated.candles.findIndex(c => new Date(c.ts).getTime() >= entryMs));
        const targetIdx = startIdx + stress.delayCandles;
        const lastIdx = mutated.candles.length - 1;
        if (targetIdx <= lastIdx) {
          mutated = { ...mutated,
            intent: { ...mutated.intent, intendedAt: mutated.candles[targetIdx].ts } };
          notes.push(`execution delayed ${stress.delayCandles} bars → entry now bar #${targetIdx}`);
        } else if (lastIdx > startIdx) {
          mutated = { ...mutated,
            intent: { ...mutated.intent, intendedAt: mutated.candles[lastIdx].ts } };
          notes.push(`delay ${stress.delayCandles} bars exceeds window (${lastIdx - startIdx} bars available); clamped to last bar`);
        } else {
          notes.push(`delay ${stress.delayCandles} bars exceeds window with no room to delay; no-op`);
        }
      }
      break;
    }
  }

  return { kind: stress.kind, mutatedSnapshot: mutated, notes };
}
