import { createHash } from "node:crypto";
import { stableStringify } from "@workspace/features/event-chain";
import { z } from "zod/v4";
import { computeRiskAwareLot, evaluateCorrelationConflict } from "@workspace/domain/self-trade";
import { dailyLossCapAmount, RISK_RULE_IDS } from "../riskGovernor/preTrade.js";

export const atiPortfolioPolicy = {
  version: "ati-paper-portfolio-downsize-v1", sizeMultiplier: 0.5, portfolioBudgetFraction: 0.75,
  dailyLossBudgetFraction: 0.5, drawdownLimitFraction: 0.5, spreadFractionOfInitialRisk: 0.1, confidenceFloor: 60,
} as const;
const positive = z.number().positive(), side = z.enum(["BUY", "SELL"]);
const instrument = z.object({ contractSize: positive, quoteToAccountFx: positive, source: z.string(),
  volumeStep: positive.nullable(), minVolume: positive.nullable(), maxVolume: positive.nullable() });
const bookSchema = z.object({
  version: z.literal("paper-governor-book-v1"), ownerId: z.number().int(), accountId: z.number().int(),
  decisionAt: z.iso.datetime(), pendingCount: z.number().int().nonnegative(),
  instruments: z.record(z.string(), instrument), positions: z.array(z.object({ symbol: z.string(), side,
    entryPrice: positive, lots: positive, stopLoss: positive.nullable() })),
});
const auditSchema = z.object({
  source: z.literal("pre_trade_risk_governor"),
  intent: z.object({ userId: z.number().int(), venue: z.literal("PAPER"), action: z.literal("OPEN"),
    symbol: z.string().min(1), side, lots: positive, stopLoss: positive, entryPrice: positive.nullish(), aiConfidence: z.number().min(0).max(100).nullish() }),
  limits: z.looseObject({ maxPortfolioRiskPercent: positive, maxDrawdownPercent: positive.nullable(), maxDailyLossPercent: positive.nullable(), maxDailyLossAmount: positive.nullable() }),
  facts: z.object({ account: z.object({ source: z.string(), currency: z.literal("USD"), equity: positive }),
    daily: z.object({ realizedPnl: z.number(), floatingPnl: z.number() }),
    openPositions: z.number().int().nonnegative(), quote: z.object({ at: z.iso.datetime(), source: z.string(), bid: positive, ask: positive }) }),
  rules: z.array(z.object({ rule: z.string(), outcome: z.enum(["PASS", "BLOCK", "NOT_APPLICABLE"]), measured: z.record(z.string(), z.unknown()).optional() })),
  blockedBy: z.array(z.string()), override: z.null(), atiPortfolioBook: bookSchema,
});
export type PortfolioAuditRow = { id: number; userId: number; eventType: string; decision: string; createdAt: Date; details: unknown };

export function compareAtiPortfolioRisk(row: PortfolioAuditRow, owner: number, account: number) {
  const base = { eventId: row.id, recordedAt: row.createdAt.toISOString() };
  const unavailable = (reason: string) => ({ ...base, state: "UNRESOLVED" as const, reason });
  const header = z.object({ source: z.literal("pre_trade_risk_governor"),
    intent: z.object({ userId: z.literal(owner), venue: z.literal("PAPER"), action: z.literal("OPEN") }),
    facts: z.object({ account: z.object({ source: z.literal(`paper_account:${account}`) }) }),
  }).safeParse(row.details);
  if (row.userId !== owner || !header.success) return unavailable("ACCOUNT_OR_INTENT_UNVERIFIED");
  if (row.eventType === "blocked_trade" && row.decision === "block")
    return { ...base, state: "GOVERNOR_BLOCKED" as const, baselineLots: 0, challengerLots: 0 };
  if (row.eventType !== "risk_check" || row.decision !== "pass") return unavailable("NO_UNOVERRIDDEN_GOVERNOR_PASS");
  const read = auditSchema.safeParse(row.details);
  if (!read.success) return unavailable("FROZEN_RISK_INPUTS_UNAVAILABLE");
  const { facts, intent, limits, rules, atiPortfolioBook: book } = read.data;
  if (book.ownerId !== owner || book.accountId !== account || book.positions.length !== facts.openPositions ||
      Date.parse(book.decisionAt) > +row.createdAt) return unavailable("BOOK_BINDING_OR_TIME_UNVERIFIED");
  if (read.data.blockedBy.length || rules.length !== RISK_RULE_IDS.length || RISK_RULE_IDS.some((id) => !rules.some((r) => r.rule === id)) ||
      rules.some((r) => r.outcome === "BLOCK")) return unavailable("GOVERNOR_RULE_EVIDENCE_CONFLICT");
  if (book.pendingCount) return unavailable("PENDING_ORDER_EXPOSURE_UNKNOWN");
  const quote = facts.quote;
  const quoteAge = Date.parse(book.decisionAt) - Date.parse(quote.at);
  if (quote.source !== "market_data_router:deriv_public" || quote.ask < quote.bid || quoteAge < 0 || quoteAge > 60_000)
    return unavailable("OBSERVED_QUOTE_UNVERIFIED");
  const entry = intent.side === "BUY" ? quote.ask : quote.bid;
  if (intent.entryPrice != null && intent.entryPrice !== entry) return unavailable("DIFFERENT_ENTRY_PRICE");
  const distance = (intent.side === "BUY" ? 1 : -1) * (entry - intent.stopLoss);
  const model = book.instruments[intent.symbol];
  if (!model?.volumeStep || !model.minVolume || !(distance > 0)) return unavailable("SIZE_MODEL_UNVERIFIED");
  const valuePerUnit = model.contractSize * model.quoteToAccountFx;
  const baselineRisk = distance * intent.lots * valuePerUnit;
  const reasons: string[] = [];
  let openRisk = 0, stacked = false;
  for (const position of book.positions) {
    const held = book.instruments[position.symbol];
    if (!held || position.stopLoss == null) return unavailable("OPEN_POSITION_RISK_UNVERIFIED");
    openRisk += Math.abs(position.entryPrice - position.stopLoss) * position.lots * held.contractSize * held.quoteToAccountFx;
    stacked ||= evaluateCorrelationConflict({ symbolA: position.symbol, sideA: position.side, symbolB: intent.symbol, sideB: intent.side }).conflict;
  }
  const cap = facts.account.equity * limits.maxPortfolioRiskPercent / 100;
  const seen = rules.find((r) => r.rule === "max_portfolio_exposure" && r.outcome === "PASS")?.measured;
  const agrees = (actual: unknown, value: number) => typeof actual === "number" && Number.isFinite(value) &&
    actual === Number(value.toFixed(2));
  if (!agrees(seen?.openRisk, openRisk) || !agrees(seen?.newRisk, baselineRisk) || !agrees(seen?.cap, cap) ||
      openRisk + baselineRisk > cap + 1e-8) return unavailable("STOP_EXPOSURE_DISAGREES_WITH_GOVERNOR");
  const dailyCap = dailyLossCapAmount(limits, facts.account.equity);
  const dailyLoss = Math.max(0, -(facts.daily.realizedPnl + Math.min(0, facts.daily.floatingPnl)));
  const measuredDrawdown = rules.find((r) => r.rule === "daily_loss_limit" && r.outcome === "PASS")?.measured?.drawdownPercent;
  const drawdownPercent = typeof measuredDrawdown === "number" && measuredDrawdown >= 0 ? measuredDrawdown : null;
  if (limits.maxDrawdownPercent != null && drawdownPercent == null) return unavailable("DRAWDOWN_BASIS_UNVERIFIED");
  if (drawdownPercent != null && limits.maxDrawdownPercent != null && drawdownPercent >= limits.maxDrawdownPercent * atiPortfolioPolicy.drawdownLimitFraction)
    reasons.push("ACCOUNT_DRAWDOWN_PRESSURE");
  if (stacked) reasons.push("STACKED_DIRECTIONAL_EXPOSURE");
  if (openRisk + baselineRisk >= cap * atiPortfolioPolicy.portfolioBudgetFraction) reasons.push("PORTFOLIO_BUDGET_PRESSURE");
  if (dailyCap != null && dailyLoss >= dailyCap * atiPortfolioPolicy.dailyLossBudgetFraction) reasons.push("DAILY_LOSS_PRESSURE");
  if ((quote.ask - quote.bid) / distance >= atiPortfolioPolicy.spreadFractionOfInitialRisk) reasons.push("WIDE_SPREAD_FOR_STOP");
  if (intent.aiConfidence != null && intent.aiConfidence < atiPortfolioPolicy.confidenceFloor) reasons.push("LOW_MODEL_CONFIDENCE");
  const budget = baselineRisk * (reasons.length ? atiPortfolioPolicy.sizeMultiplier : 1);
  const lot = computeRiskAwareLot({ side: intent.side, entryPrice: entry, stopLossPrice: intent.stopLoss, riskBudgetUsd: budget,
    valuePerUnitPerLot: valuePerUnit, minLot: model.minVolume, maxLot: model.maxVolume ?? intent.lots, lotStep: model.volumeStep,
    agentMaxLot: intent.lots, sizeMultiplier: 1 });
  if (lot.cannotSize) return unavailable("LOT_SIZING_UNAVAILABLE");
  const challengerLots = lot.withinRiskBudget && lot.lot <= intent.lots ? lot.lot : 0;
  if (!challengerLots) reasons.push("MINIMUM_LOT_EXCEEDS_BUDGET");
  return { ...base, state: "COMPARED" as const, decisionAt: book.decisionAt, symbol: intent.symbol, side: intent.side,
    entryQuoteSide: entry, initialStopLoss: intent.stopLoss, quoteSource: quote.source, instrumentModel: model.source, baselineLots: intent.lots, challengerLots,
    baselineStopExposureUsd: openRisk + baselineRisk, challengerStopExposureUsd: openRisk + challengerLots * distance * valuePerUnit,
    openStopExposureUsd: openRisk, portfolioCapUsd: cap, dailyLossUsd: dailyLoss, dailyCapUsd: dailyCap,
    drawdownPercent, drawdownLimitPercent: limits.maxDrawdownPercent,
    incrementalStopExposureUsd: baselineRisk, lotStep: model.volumeStep, minimumLots: model.minVolume,
    bookHash: createHash("sha256").update(stableStringify([owner, account, facts.account, facts.daily, limits,
      book.positions.map((p) => stableStringify([p, book.instruments[p.symbol]])).sort()])).digest("hex"),
    aiConfidence: intent.aiConfidence ?? null, reasons };
}

type Comparison = ReturnType<typeof compareAtiPortfolioRisk>;

/** A one-second stress scenario. Put all approved requests on the same frozen
 * account book at once, and reserve headroom in audit-id order. */
export function stressAtiPortfolioBatches(rows: Comparison[], from: number, through: number) {
  const batches = new Map<number, Extract<Comparison, { state: "COMPARED" }>[]>();
  for (const row of rows) {
    if (row.state !== "COMPARED") continue;
    const second = Math.floor(Date.parse(row.decisionAt) / 1000);
    const batch = batches.get(second) ?? [];
    batch.push(row);
    batches.set(second, batch);
  }
  return [...batches].filter(([, batch]) => batch.length > 1).map(([second, batch]) => {
    batch.sort((a, b) => a.eventId - b.eventId);
    const first = batch[0]!;
    const base = { decisionSecond: new Date(second * 1000).toISOString(), events: batch.map((row) => row.eventId) };
    if (second * 1000 < from || (second + 1) * 1000 > through) return { ...base, state: "PARTIAL_WINDOW" as const };
    if (batch.some((row) => row.bookHash !== first.bookHash)) return { ...base, state: "DIFFERENT_FROZEN_BOOKS" as const };
    let baseline = first.openStopExposureUsd, challenger = baseline;
    const allocations = batch.map((row) => {
      const unitRisk = row.incrementalStopExposureUsd / row.baselineLots;
      baseline += row.baselineLots * unitRisk;
      const remaining = Math.max(0, row.portfolioCapUsd - challenger);
      const steps = Math.min(Math.floor(remaining / (unitRisk * row.lotStep)), Math.round(row.challengerLots / row.lotStep));
      const offered = steps * row.lotStep;
      const lots = offered >= row.minimumLots && offered * unitRisk <= remaining ? Math.min(offered, row.challengerLots) : 0;
      challenger += lots * unitRisk;
      return { eventId: row.eventId, lots };
    });
    return { ...base, state: "COMPARED" as const, portfolioCapUsd: first.portfolioCapUsd,
      baselineStopExposureUsd: baseline, challengerStopExposureUsd: challenger, allocations };
  });
}

export type ComparedPortfolioEntry = Extract<Comparison, { state: "COMPARED" }>;
export type PortfolioOrderReceipt = { linkedDecisionId: string | null; linkedTradeId: string | null; generatedAtIso: string; payload: unknown };
const orderIdentity = z.object({ userId: z.number().int(), accountId: z.number().int(), orderId: z.number().int().positive(),
  symbol: z.string(), simulated: z.literal(true) });
const placedOrder = orderIdentity.extend({ direction: side, lotSize: positive, entryPrice: positive, initialStopLoss: positive });
const closedOrder = orderIdentity.extend({ status: z.enum(["CLOSED_MANUAL", "CLOSED_SL", "CLOSED_TP"]), exitPrice: positive,
  exitQuote: z.object({ at: z.iso.datetime(), source: z.string(), bid: positive, ask: positive }) });
// Paper order money and quantity columns are PostgreSQL REAL.
const storedEqual = (stored: number, expected: number) => Math.fround(stored) === Math.fround(expected);

export function gradeAtiPortfolioOutcome(entry: ComparedPortfolioEntry, owner: number, account: number,
  placements: PortfolioOrderReceipt[], exits: PortfolioOrderReceipt[], through: Date) {
  const gap = (reason: string) => ({ eventId: entry.eventId, state: "UNRESOLVED" as const, reason });
  const available = (receipt: PortfolioOrderReceipt) => Number.isFinite(Date.parse(receipt.generatedAtIso)) &&
    Date.parse(receipt.generatedAtIso) < +through;
  const linked = placements.filter((r) => r.linkedDecisionId === `risk:${entry.eventId}` && available(r));
  if (linked.length !== 1) return gap(linked.length ? "CONFLICTING_BOOKINGS" : "NO_BOOKING_RECEIPT");
  const placed = linked[0]!, parsed = placedOrder.safeParse(placed.payload);
  if (!parsed.success) return gap("INITIAL_BRACKET_UNVERIFIED");
  const p = parsed.data, placedAt = Date.parse(placed.generatedAtIso);
  if (p.userId !== owner || p.accountId !== account || p.symbol !== entry.symbol || p.direction !== entry.side ||
      placed.linkedTradeId !== String(p.orderId) || placedAt < Date.parse(entry.recordedAt) ||
      !storedEqual(p.lotSize, entry.baselineLots) || !storedEqual(p.initialStopLoss, entry.initialStopLoss) ||
      !storedEqual(p.entryPrice, entry.entryQuoteSide)) return gap("BOOKING_MISMATCH");
  const matched = exits.filter((r) => r.linkedTradeId === placed.linkedTradeId && available(r));
  if (matched.length !== 1) return gap(matched.length ? "CONFLICTING_EXITS" : "EXIT_NOT_RECORDED");
  const exit = matched[0]!, close = closedOrder.safeParse(exit.payload);
  if (!close.success) return gap("EXECUTABLE_EXIT_UNVERIFIED");
  const c = close.data, q = c.exitQuote, quoteAt = Date.parse(q.at), released = Date.parse(exit.generatedAtIso);
  if (c.userId !== owner || c.accountId !== account || c.orderId !== p.orderId || c.symbol !== p.symbol ||
      q.source !== entry.quoteSource || q.ask < q.bid || quoteAt < placedAt || quoteAt > released ||
      !storedEqual(c.exitPrice, entry.side === "BUY" ? q.bid : q.ask)) return gap("EXIT_MISMATCH");
  const direction = p.direction === "BUY" ? 1 : -1, risk = direction * (p.entryPrice - p.initialStopLoss);
  if (!(risk > 0)) return gap("INITIAL_BRACKET_UNVERIFIED");
  const baselineR = direction * (c.exitPrice - p.entryPrice) / risk;
  const challengerR = baselineR * entry.challengerLots / entry.baselineLots;
  return { eventId: entry.eventId, orderId: p.orderId, state: "SAME_FILL_SIZE_REPLAY" as const,
    baselineR, challengerR, deltaR: challengerR - baselineR, netAfterBrokerCostsR: null, exitRecordedAt: exit.generatedAtIso };
}
