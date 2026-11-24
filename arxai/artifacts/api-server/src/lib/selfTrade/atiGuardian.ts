import { z } from "zod/v4";
import { createHash } from "node:crypto";
import { evaluateManagementAction, type TradeThesis } from "@workspace/domain/self-trade";
import { crossedPaperLevel } from "../tradeEngine/paperLevels.js";

export const guardianComparisonPolicy = {
  version: "guardian-early-breakeven-v1",
  baseline: "SELF_TRADE_L3_SAMPLED_QUOTES",
  challengerBreakEvenR: 0.75,
  amendmentTiming: "NEXT_LATER_RELEASED_QUOTE",
  partialClose: "ALERT_ONLY",
} as const;

export const ATI_GUARDIAN_GRADE_VERSION = "ati-guardian-pair-1h-v1";
const price = z.number().positive();
const time = z.number().int().positive();
const exitSchema = z.object({ at: time, price, reason: z.string(), quoteSideR: z.number(),
  assumedNetR: z.number().nullable(), measuredSlippageR: z.number().nullable(), measuredNetR: z.number().nullable() }).strict();
const legSchema = z.object({ stop: price, pending: z.object({ at: time, stop: price.nullable(), reason: z.string() }).strict().nullable(),
  amendments: z.number().int().nonnegative(), exit: exitSchema.nullable() }).strict();
export const atiGuardianGrade = z.object({
  state: z.literal("GUARDIAN_COMPARISON"), status: z.enum(["SETTLED_PAIR", "NO_FILL", "UNRESOLVED"]),
  policyVersion: z.literal(guardianComparisonPolicy.version), quoteSource: z.enum(["deriv_public", "mt5_broker"]),
  mt5Mode: z.enum(["LIVE", "DEMO"]).nullable(), sizeRatio: z.union([z.literal(0.5), z.literal(1)]),
  entry: z.object({ price, at: time }).strict().nullable(), samples: z.number().int().nonnegative(), sampleHash: z.hash("sha256").nullable(), archivePrefixHash: z.hash("sha256").nullable(),
  baseline: legSchema, challenger: legSchema, pairedDeltaR: z.number().nullable(),
  noFill: z.object({ atMs: time, reason: z.string(), tapeHash: z.hash("sha256") }).strict().nullable(),
  reason: z.string().nullable(),
}).strict();
export type AtiGuardianGrade = z.infer<typeof atiGuardianGrade>;

type Costs = { assumed: number | null; measuredSlippage: number | null; measured: number | null };
type Leg = z.infer<typeof legSchema>;

export function replayGuardianPair(thesis: TradeThesis, size: number, costs: Costs) {
  const leg = (): Leg => ({ stop: thesis.stopLoss, pending: null, amendments: 0, exit: null });
  const baseline = leg(), challenger = leg();
  const direction = thesis.side === "BUY" ? 1 : -1;
  const digest = createHash("sha256");
  let entered: { price: number; at: number } | null = null;
  let samples = 0;
  let archivePrefixHash: string | null = null;

  function advance(state: Leg, early: boolean, entry: number, mark: number, at: number) {
    if (state.exit) return;
    const risk = direction * (entry - thesis.stopLoss);
    const action = state.pending && state.pending.at < at ? state.pending : null;
    if (action) {
      state.pending = null;
      if (action.stop != null) { state.stop = action.stop; state.amendments++; }
    }
    const hit = crossedPaperLevel({ direction: thesis.side, stopLoss: state.stop, takeProfit: thesis.takeProfits[0]!.from }, mark);
    if (hit || (action && action.stop == null)) {
      const pnl = direction * (mark - entry);
      const net = (cost: number | null) => cost == null ? null : size * (pnl - cost) / risk;
      state.exit = { at, price: mark, reason: hit?.hit ?? action!.reason, quoteSideR: size * pnl / risk,
        assumedNetR: net(costs.assumed), measuredSlippageR: net(costs.measuredSlippage), measuredNetR: net(costs.measured) };
      return;
    }
    if (state.pending) return;
    const beMoved = direction * (state.stop - entry) >= 0;
    const verdict = evaluateManagementAction({ side: thesis.side, entryPrice: entry, currentPrice: mark,
      stopLoss: thesis.stopLoss, currentSl: state.stop, takeProfits: thesis.takeProfits, invalidation: thesis.invalidation,
      beMoved, partialsTaken: 0, autonomyLevel: 3 });
    if (verdict.action === "EXIT" || verdict.newStopLoss != null) {
      state.pending = { at, stop: verdict.newStopLoss, reason: verdict.reason };
    } else if (early && verdict.action === "HOLD" && !beMoved && verdict.rMultiple >= guardianComparisonPolicy.challengerBreakEvenR) {
      state.pending = { at, stop: entry, reason: "EARLY_BREAK_EVEN" };
    }
  }

  return {
    observe(entry: number, mark: number, at: number, prefixHash?: string) {
      if (baseline.exit && challenger.exit) return;
      archivePrefixHash = prefixHash ?? null;
      entered ??= { price: entry, at };
      samples++;
      digest.update(JSON.stringify([entry, mark, at]));
      advance(baseline, false, entry, mark, at);
      advance(challenger, true, entry, mark, at);
    },
    result() {
      return { entry: entered, samples, archivePrefixHash, sampleHash: samples ? digest.copy().digest("hex") : null, baseline, challenger,
        pairedDeltaR: baseline.exit && challenger.exit ? challenger.exit.quoteSideR - baseline.exit.quoteSideR : null };
    },
  };
}
