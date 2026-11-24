import { specialistIds, specialistPool, type Triple } from "@workspace/domain/structural";
import { atiDerivQuoteOrigin, type AtiDerivQuoteFrame, type AtiDerivQuoteOrigin } from "../data/atiDerivQuotes.js";
import { resolveDerivSymbol } from "../data/providers/derivProvider.js";
import { loadAtiDerivReplayQuotes } from "../selfTrade/atiDerivQuoteReplay.js";
import { selectAtiSpecialists, type SpecialistSample } from "./atiSpecialistReport.js";
import { readSpecialistTape, specialistPaperPoints, type BoundaryPrices } from "./atiSpecialistTape.js";
import type { StoredForecast } from "./service.js";

type Priced = { sample: SpecialistSample; prices: BoundaryPrices };
type TapeLoader = (origin: AtiDerivQuoteOrigin, end: number) => Promise<readonly AtiDerivQuoteFrame[]>;

function economics(rows: Priced[]) {
  function compare(vote: (s: SpecialistSample) => Triple) {
    let changedSide = 0, active = 0, net = 0, gain = 0;
    for (const { sample, prices } of rows) {
      const base = specialistPaperPoints(vote(sample), prices);
      const pooled = specialistPaperPoints(sample.pool, prices);
      if (base.side !== pooled.side) changedSide++;
      if (base.side !== "FLAT") active++;
      net += base.assumedNet;
      gain += pooled.assumedNet - base.assumedNet;
    }
    return { active, changedSide, meanAssumedNetPoints: rows.length ? net / rows.length : null,
      poolGainPoints: rows.length ? gain / rows.length : null };
  }
  return { pricedWindows: rows.length, pool: compare(s => s.pool), incumbent: compare(s => s.incumbent),
    frequency: compare(s => s.specialist.frequency), specialists: specialistIds.map(id => ({
      id, alone: compare(s => s.specialist.probabilities[id]), omitted: compare(s => specialistPool(s.specialist, id)),
    })) };
}

export async function reportAtiSpecialistCosts(rows: readonly StoredForecast[], load: TapeLoader = loadAtiDerivReplayQuotes) {
  const { cohorts, ...scope } = selectAtiSpecialists(rows);
  const result = [];
  for (const { samples, ...coverage } of cohorts) {
    const priced: Priced[] = [];
    const gaps: { receiptId: string; reason: string }[] = [];
    for (const sample of samples) {
      const anchor = sample.specialist.quoteStudy;
      const symbol = resolveDerivSymbol(coverage.symbol)?.derivId;
      if (!anchor) { gaps.push({ receiptId: sample.row.id, reason: "NO_ISSUANCE_QUOTE" }); continue; }
      const parsed = atiDerivQuoteOrigin.safeParse({ streamId: anchor.streamId, symbol: anchor.symbol, epoch: anchor.epoch });
      if (!parsed.success || symbol !== anchor.symbol || sample.row.recordedAt == null) {
        gaps.push({ receiptId: sample.row.id, reason: "ANCHOR_UNVERIFIED" });
        continue;
      }
      const end = sample.row.forecast.asOf + 15 * 60_000;
      const tape = await load(parsed.data, end + 5000);
      const reading = readSpecialistTape(anchor, symbol, tape, sample.row.issuedAt, sample.row.recordedAt, end);
      if ("prices" in reading) priced.push({ sample, prices: reading.prices });
      else gaps.push({ receiptId: sample.row.id, reason: reading.reason });
    }
    result.push({ ...coverage, scoredWindows: samples.length, ...economics(priced), gaps,
      byTrend: (["UP", "DOWN", "UNESTABLISHED"] as const).map(trend => ({
        trend, ...economics(priced.filter(s => s.sample.specialist.trend === trend)),
      })),
      witnesses: priced.map(({sample, prices}) => ({ receiptId: sample.row.id, ...prices })) });
  }
  return { ...scope, study: "fixed-horizon-bid-ask-v1", mode: "PUBLIC_QUOTE_SIMULATION", unit: "ONE_UNIT_PRICE_POINTS",
    costBasis: { spread: "OBSERVED_BID_ASK", assumedSlippagePointsPerSide: 1, assumedOtherCostPoints: 0,
      observedBrokerCharges: null }, cohorts: result };
}
