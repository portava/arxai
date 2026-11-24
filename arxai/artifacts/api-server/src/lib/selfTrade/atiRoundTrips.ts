import { createHash } from "node:crypto";

import type { AtiEntryStrategy } from "./atiStrategyOrigin.js";

type Mode = "LIVE" | "DEMO";
type Charge = { currency: string; commission: number | null; fee: number | null; swap: number | null };
type FillBenchmark = {
  source: "COMMAND_QUOTES"; decisionSpreadPriceUnits: number | null; submissionSpreadPriceUnits: number | null;
  adverseMovementBeforeSubmissionPriceUnits: number | null; adverseSlippagePriceUnits: number | null;
  adverseFillVsDecisionMidPriceUnits: number | null;
} | { source: "BROKER_TRIGGER"; triggerPrice: number | null; adverseMovementFromTriggerPriceUnits: number | null };
export interface AtiPositionLeg {
  accountBinding: string; brokerSymbol: string; positionId: string; order: string; deal: string;
  leg: "ENTRY" | "EXIT"; side: "BUY" | "SELL"; volume: number; fillPrice: number; brokerFilledAtMs: number;
  entryStrategy?: AtiEntryStrategy | null; commandId: string | null; closedPositionDealTickets: string[] | null; charges: Charge | null; benchmark: FillBenchmark;
}

// Align the decimal representations carried by the terminal receipts, including scientific notation.
function decimalUnits(values: readonly number[]) {
  const decimals = values.map(value => {
    const [mantissa, exponent = "0"] = String(value).split("e");
    const [whole, fraction = ""] = mantissa!.split(".");
    return { coefficient: BigInt(whole! + fraction), places: fraction.length - Number(exponent) };
  });
  const places = decimals.reduce((max, decimal) => Math.max(max, decimal.places), 0);
  const units = decimals.map(decimal => decimal.coefficient * 10n ** BigInt(places - decimal.places));
  return { places, units };
}

export function exactAtiLotUnits(volumes: readonly number[]) {
  return decimalUnits(volumes).units;
}

function signedCashTotal(values: readonly number[]) {
  if (!values.length || !values.every(Number.isFinite)) return null;
  const { units, places } = decimalUnits(values);
  const total = Number(`${units.reduce((sum, n) => sum + n, 0n)}e-${places}`);
  return Number.isFinite(total) ? total : null;
}

export function atiPositionKey(mode: Mode, accountBinding: string, positionId: string) {
  return createHash("sha256").update(JSON.stringify(["ATI_POSITION", mode, accountBinding, positionId])).digest("hex");
}

function assessPosition(mode: Mode, legs: AtiPositionLeg[], duplicates: Set<string>) {
  const ordered = [...legs].sort((a, b) => a.brokerFilledAtMs - b.brokerFilledAtMs || a.deal.localeCompare(b.deal));
  const tickets = ordered.map(row => row.deal).sort();
  const manifests = ordered.filter(row => row.leg === "EXIT" && row.closedPositionDealTickets);
  const entry = ordered.find(row => row.leg === "ENTRY");
  const last = ordered[ordered.length - 1]!;
  const gaps: string[] = [];
  if (!manifests.length) gaps.push("NO_CLOSED_POSITION_HISTORY");
  if (!entry) gaps.push("OPENING_DEAL_UNAVAILABLE");
  if (tickets.some(deal => duplicates.has(JSON.stringify([last.accountBinding, deal])))) gaps.push("DUPLICATE_DEAL_CLAIM");
  if (manifests.some(row => JSON.stringify([...row.closedPositionDealTickets!].sort()) !== JSON.stringify(tickets)))
    gaps.push("POSITION_HISTORY_AND_RECEIPTS_DIFFER");
  if (manifests.length && !manifests.some(row => row.brokerFilledAtMs === last.brokerFilledAtMs))
    gaps.push("CLOSING_DEAL_UNCONFIRMED");
  if (entry && ordered.some(row => (row.side === entry.side) !== (row.leg === "ENTRY")))
    gaps.push("POSITION_SIDE_MISMATCH");
  const lots = exactAtiLotUnits(ordered.map(row => row.volume));
  let balance = 0n;
  for (let i = 0; i < ordered.length; i++) {
    const row = ordered[i]!;
    const prior = ordered[i - 1];
    if (prior && prior.brokerFilledAtMs === row.brokerFilledAtMs && prior.leg !== row.leg)
      gaps.push("SAME_TIME_LEG_ORDER_UNVERIFIED");
    balance += (row.leg === "ENTRY" ? 1n : -1n) * lots[i]!;
    if (balance < 0n || (balance === 0n && i + 1 < ordered.length)) gaps.push("INVALID_POSITION_VOLUME_PATH");
  }
  if (balance !== 0n) gaps.push("ENTRY_EXIT_VOLUME_MISMATCH");
  if (ordered.some(row => row.brokerSymbol !== last.brokerSymbol)) gaps.push("POSITION_SYMBOL_MISMATCH");
  const reconciled = gaps.length === 0;
  const currency = ordered[0]!.charges?.currency;
  const sameCurrency = !!currency && ordered.every(row => row.charges?.currency === currency);
  function signedAmount(field: "commission" | "fee" | "swap") {
    if (!sameCurrency || !ordered.every(row => row.charges?.[field] != null)) return null;
    return signedCashTotal(ordered.map(row => row.charges![field]!));
  }
  const positionKey = atiPositionKey(mode, last.accountBinding, last.positionId);
  return { positionKey, brokerSymbol: last.brokerSymbol, positionId: last.positionId,
    state: reconciled ? "OBSERVED_BROKER_ROUND_TRIP" as const : "UNRESOLVED" as const, gaps: [...new Set(gaps)],
    deals: ordered.map(({ commandId, order, deal, leg, side, volume, fillPrice, brokerFilledAtMs, benchmark, charges, entryStrategy }) =>
      ({ commandId, order, deal, leg, side, volume, fillPrice, brokerFilledAtMs, benchmark, charges, entryStrategy: entryStrategy ?? null })),
    charges: reconciled && sameCurrency ? { currency, commission: signedAmount("commission"), fee: signedAmount("fee"), swap: signedAmount("swap") } : null };
}

/** Called separately for one owner and one account mode. The full terminal history
 * must match the available receipts, including any split fills or protective exits. */
export function atiRoundTrips(mode: Mode, legs: AtiPositionLeg[], dealsWithoutPositionId: number) {
  const groups = new Map<string, AtiPositionLeg[]>();
  const seen = new Set<string>(), duplicates = new Set<string>();
  for (const row of legs) {
    const ticket = JSON.stringify([row.accountBinding, row.deal]);
    if (seen.has(ticket)) duplicates.add(ticket);
    seen.add(ticket);
    const key = JSON.stringify([row.accountBinding, row.positionId]);
    const rows = groups.get(key);
    if (rows) rows.push(row); else groups.set(key, [row]);
  }
  const positions = [...groups.values()].map(rows => assessPosition(mode, rows, duplicates)).sort((a, b) => a.positionKey.localeCompare(b.positionKey));
  return { positions, dealsWithoutPositionId, reconciled: positions.filter(row => row.state === "OBSERVED_BROKER_ROUND_TRIP").length };
}

type Position = ReturnType<typeof assessPosition>;
type Deal = Position["deals"][number];

function volumeWeightedCost(deals: Deal[], select: (deal: Deal) => number | null) {
  let coveredFills = 0, volume = 0, sum = 0;
  for (const deal of deals) {
    const value = select(deal);
    if (value == null) continue;
    coveredFills++;
    volume += deal.volume;
    sum += deal.volume * value;
  }
  return { coveredFills, totalFills: deals.length, volumeWeightedMeanPriceUnits:
    volume > 0 && Number.isFinite(sum) && Number.isFinite(volume) ? sum / volume : null };
}

export function reportAtiEntryStrategies(input: Position[]) {
  const positions = input.map(position => {
    const entries = position.deals.filter(row => row.leg === "ENTRY");
    const first = entries[0]?.entryStrategy;
    const attribution = position.state !== "OBSERVED_BROKER_ROUND_TRIP" ? "POSITION_UNRESOLVED" as const
      : !first || entries.some(row => !row.entryStrategy) ? "ENTRY_STRATEGY_UNVERIFIED" as const
      : entries.some(row => row.entryStrategy?.cohortKey !== first.cohortKey) ? "MULTIPLE_ENTRY_STRATEGIES" as const
      : "VERIFIED_ENTRY_STRATEGY" as const;
    const entryStrategy = first && attribution === "VERIFIED_ENTRY_STRATEGY"
      ? { cohortKey: first.cohortKey, strategy: first.strategy } : null;
    return { ...position, attribution, entryStrategy };
  });
  const groups = new Map<string, Position[]>();
  for (const position of positions) {
    if (!position.entryStrategy) continue;
    const key = position.entryStrategy.cohortKey, group = groups.get(key);
    if (group) group.push(position); else groups.set(key, [position]);
  }
  const byEntryStrategy = [...groups].map(([cohortKey, group]) => {
    const deals = group.flatMap(p => p.deals);
    const strategy = deals.find(row => row.leg === "ENTRY" && row.entryStrategy)!.entryStrategy!.strategy;
    const commands = deals.filter(row => row.benchmark.source === "COMMAND_QUOTES");
    const protective = deals.filter(row => row.benchmark.source === "BROKER_TRIGGER");
    const entry = commands.filter(row => row.leg === "ENTRY");
    const currencies = [...new Set(group.flatMap(p => p.charges ? [p.charges.currency] : []))].sort();
    const signedDealCharges = currencies.map(currency => {
      const same = group.filter(p => p.charges?.currency === currency);
      function cash(...fields: Array<"commission" | "fee" | "swap">) {
        const amounts: number[] = [];
        let coveredPositions = 0;
        for (const position of same) {
          const values = position.deals.flatMap(deal => fields.map(field => deal.charges![field]));
          if (!values.every((value): value is number => value !== null && Number.isFinite(value))) continue;
          coveredPositions++;
          for (const value of values) amounts.push(value);
        }
        return { coveredPositions, signedCashOnCoveredPositions: signedCashTotal(amounts) };
      }
      return { currency, positionsInCurrency: same.length, commission: cash("commission"), fee: cash("fee"),
        swap: cash("swap"), combinedDealCharges: cash("commission", "fee", "swap") };
    });
    return { cohortKey, strategy, positionKeys: group.map(p => p.positionKey), closedPositions: group.length,
      decisionToFill: volumeWeightedCost(entry, row => row.benchmark.source === "COMMAND_QUOTES" ? row.benchmark.adverseFillVsDecisionMidPriceUnits : null),
      decisionSpread: volumeWeightedCost(entry, row => row.benchmark.source === "COMMAND_QUOTES" ? row.benchmark.decisionSpreadPriceUnits : null),
      movementBeforeSubmission: volumeWeightedCost(entry, row => row.benchmark.source === "COMMAND_QUOTES" ? row.benchmark.adverseMovementBeforeSubmissionPriceUnits : null),
      submissionSpread: volumeWeightedCost(commands, row => row.benchmark.source === "COMMAND_QUOTES" ? row.benchmark.submissionSpreadPriceUnits : null),
      commandSlippage: volumeWeightedCost(commands, row => row.benchmark.source === "COMMAND_QUOTES" ? row.benchmark.adverseSlippagePriceUnits : null),
      triggerMovement: volumeWeightedCost(protective, row => row.benchmark.source === "BROKER_TRIGGER" ? row.benchmark.adverseMovementFromTriggerPriceUnits : null),
      positionsWithoutSingleChargeCurrency: group.filter(p => !p.charges).length, signedDealCharges };
  });
  return { positions, byEntryStrategy, entryAttributionCoverage: {
    reconciledPositions: positions.filter(row => row.state === "OBSERVED_BROKER_ROUND_TRIP").length,
    attributed: positions.filter(row => row.attribution === "VERIFIED_ENTRY_STRATEGY").length,
    missingEntryStrategy: positions.filter(row => row.attribution === "ENTRY_STRATEGY_UNVERIFIED").length,
    mixedEntryStrategies: positions.filter(row => row.attribution === "MULTIPLE_ENTRY_STRATEGIES").length,
  } };
}
