import { z } from "zod/v4";
import type { ForecastPaperGrade } from "@workspace/domain/structural";
import type { ObservedNoFill, SampledBracketPath } from "../tradeEngine/paperLevels.js";

const positive = z.number().positive();
const time = z.number().int().positive();
const tapeHash = z.hash("sha256");
const returns = z.object({
  quoteSideR: z.number(), assumedR: z.number().nullable(), measuredSlippageR: z.number().nullable(), measuredR: z.number().nullable(),
}).strict();

const retestLeg = z.discriminatedUnion("state", [
  z.object({ state: z.literal("SIMULATED_FILL"), entry: positive, entryAtMs: time, entryDelayMs: positive,
    exit: positive, exitAtMs: time, exitReason: z.enum(["STOP", "TARGET"]), sizeRatio: positive, riskPriceUnits: positive,
    returns, tapeHash }).strict(),
  z.object({ state: z.literal("NO_FILL"), reason: z.enum(["ENTRY_WINDOW_EXPIRED", "BRACKET_INVALIDATED", "FIRST_QUOTE_NOT_EXECUTABLE"]),
    atMs: time, tapeHash }).strict(),
  z.object({ state: z.literal("UNRESOLVED"), reason: z.enum(["HOLD_WINDOW_ENDED", "QUOTE_HISTORY_INCOMPLETE", "INVALID_PLAN"]),
    observedEntry: z.object({ atMs: time, price: positive, delayMs: positive }).strict().nullable() }).strict(),
]);

export const atiRetestComparison = z.object({
  state: z.literal("RETEST_COMPARISON"), quoteSource: z.enum(["deriv_public", "mt5_broker"]),
  mt5Mode: z.enum(["LIVE", "DEMO"]).nullable(),
  plannedRiskPriceUnits: positive, baseline: retestLeg, challenger: retestLeg,
}).strict();

export type AtiRetestComparison = z.infer<typeof atiRetestComparison>;
export type AtiRetestLeg = z.infer<typeof retestLeg>;
export type AtiReplayGrade = ForecastPaperGrade & {
  path?: SampledBracketPath; noFill?: ObservedNoFill;
  replay?: { tapeHash: string }; derivReplay?: { tapeHash: string };
};

export function gradeRetestLeg(raw: AtiReplayGrade, input: {
  side: "BUY" | "SELL"; stop: number; plannedRisk: number; sizeRatio: number; decisionAt: number; asOf: number; complete: boolean;
  costs: { assumed: number | null; measuredSlippage: number | null; measured: number | null };
}): AtiRetestLeg | null {
  const { decisionAt, asOf, side, stop } = input;
  const entered = raw.path?.entry;
  const observedEntry = entered && entered.atMs > decisionAt && entered.atMs <= asOf && Number.isFinite(entered.price) && entered.price > 0
    ? { atMs: entered.atMs, price: entered.price, delayMs: entered.atMs - decisionAt } : null;
  if (raw.state === "SKIPPED" && raw.noFill?.tapeHash && raw.noFill.atMs > decisionAt && raw.noFill.atMs <= asOf) {
    return { state: "NO_FILL", reason: raw.noFill.reason, atMs: raw.noFill.atMs, tapeHash: raw.noFill.tapeHash };
  }
  if (raw.state !== "TARGET" && raw.state !== "STOP") {
    if (!input.complete) return null;
    return { state: "UNRESOLVED", reason: raw.state === "OPEN" ? "HOLD_WINDOW_ENDED" : "QUOTE_HISTORY_INCOMPLETE", observedEntry };
  }
  const { exit, observedAt: exitAtMs } = raw;
  const tapeHash = raw.replay?.tapeHash ?? raw.derivReplay?.tapeHash;
  if (!observedEntry || !tapeHash || exit == null || !Number.isFinite(exit) || exit <= 0 ||
      exitAtMs == null || exitAtMs < observedEntry.atMs || exitAtMs > asOf) {
    return { state: "UNRESOLVED", reason: "QUOTE_HISTORY_INCOMPLETE", observedEntry };
  }
  const direction = side === "BUY" ? 1 : -1;
  const riskPriceUnits = direction * (observedEntry.price - stop);
  const pnl = direction * (exit - observedEntry.price);
  const scaledR = (cost: number | null) => {
    if (cost == null) return null;
    const result = (pnl - cost) / input.plannedRisk * input.sizeRatio;
    return Number.isFinite(result) ? result : null;
  };
  const quoteSideR = scaledR(0);
  if (quoteSideR == null || !(riskPriceUnits > 0)) return { state: "UNRESOLVED", reason: "INVALID_PLAN", observedEntry };
  return { state: "SIMULATED_FILL", entry: observedEntry.price, entryAtMs: observedEntry.atMs, entryDelayMs: observedEntry.delayMs,
    exit, exitAtMs, exitReason: raw.state, sizeRatio: input.sizeRatio, riskPriceUnits,
    returns: { quoteSideR, assumedR: scaledR(input.costs.assumed),
      measuredSlippageR: scaledR(input.costs.measuredSlippage), measuredR: scaledR(input.costs.measured) }, tapeHash };
}
