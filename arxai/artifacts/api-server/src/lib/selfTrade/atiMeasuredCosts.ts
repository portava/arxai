import type { AtiMt5QuoteOrigin } from "../data/atiMt5QuoteOrigin.js";
import { readAtiHistoricalCostSamples } from "./atiExecutionCosts.js";

type Side = "BUY" | "SELL";
type Leg = "ENTRY" | "EXIT";
type Sample = {
  commandId: string; order: string; deal: string; availableAt: number; volume: number;
  leg: Leg; side: Side; slippage: number | null; commission: number | null; fee: number | null;
};
type Estimate = { sampleCount: number; medianPriceUnits: number | null };

function median(values: number[]): Estimate {
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return {
    sampleCount: values.length,
    medianPriceUnits: values.length === 0 ? null : values.length % 2 ? values[middle]!
      : values[middle - 1]! / 2 + values[middle]! / 2,
  };
}

function estimateLeg(samples: Sample[], leg: Leg, side: Side) {
  const selected = samples.filter((sample) => sample.leg === leg && sample.side === side);
  return {
    deals: selected.length,
    slippage: median(selected.flatMap((sample) => sample.slippage == null ? [] : [sample.slippage])),
    slippageCommissionAndFee: median(selected.flatMap(({ slippage, commission, fee }) => {
      if (slippage == null || commission == null || fee == null) return [];
      const total = slippage + commission + fee;
      return Number.isFinite(total) ? [total] : [];
    })),
  };
}

export async function freezeAtiMeasuredCosts(ownerId: number, symbol: string, sourceIdentity: string,
  origin: AtiMt5QuoteOrigin, decisionAt: Date) {
  const observed = await readAtiHistoricalCostSamples(ownerId, symbol, origin, decisionAt);
  const samples: Sample[] = observed.map(({ commandId, availableAt, result }) => ({
    commandId, availableAt, order: result.order, deal: result.deal, volume: result.volume, leg: result.leg, side: result.side,
    slippage: result.adverseSlippagePriceUnits,
    commission: result.adverseChargesPriceUnits?.commission ?? null, fee: result.adverseChargesPriceUnits?.fee ?? null,
  })).sort((a, b) => a.availableAt - b.availableAt || a.commandId.localeCompare(b.commandId));
  return {
    version: "mt5-command-deal-median-v1" as const,
    sourceIdentity,
    availableBeforeMs: +decisionAt,
    mode: origin.mode,
    brokerSymbol: origin.brokerSymbol,
    scope: "COMMANDED_SLIPPAGE_COMMISSION_FEE" as const,
    chargeBasis: "BROKER_TICK_VALUE_PER_FILLED_LOT" as const,
    samples,
    entry: { BUY: estimateLeg(samples, "ENTRY", "BUY"), SELL: estimateLeg(samples, "ENTRY", "SELL") },
    exit: { BUY: estimateLeg(samples, "EXIT", "BUY"), SELL: estimateLeg(samples, "EXIT", "SELL") },
  };
}

export type AtiMeasuredCostProfile = Awaited<ReturnType<typeof freezeAtiMeasuredCosts>>;

export function selectAtiMeasuredCosts(profile: AtiMeasuredCostProfile | null, origin: AtiMt5QuoteOrigin,
  sourceIdentity: string | null, decisionAtMs: number) {
  return profile && profile.sourceIdentity === sourceIdentity && profile.mode === origin.mode &&
    profile.brokerSymbol === origin.brokerSymbol &&
    profile.availableBeforeMs <= decisionAtMs ? profile : null;
}

export function measuredRoundTripCosts(profile: AtiMeasuredCostProfile, side: Side) {
  const entry = profile.entry[side];
  const exit = profile.exit[side === "BUY" ? "SELL" : "BUY"];
  const sum = (a: Estimate, b: Estimate) => a.medianPriceUnits == null || b.medianPriceUnits == null
    ? null : a.medianPriceUnits + b.medianPriceUnits;
  return { slippage: sum(entry.slippage, exit.slippage),
    slippageCommissionAndFee: sum(entry.slippageCommissionAndFee, exit.slippageCommissionAndFee) };
}
