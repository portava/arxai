import {
  MICRO_STEP_LABELS,
  type FillEvent, type MarketQuote, type MicroStepKind, type MicroStepResult,
  type MonitoringHandle, type OrderTicket, type SlippageRecord,
} from "./orderExecution.types";
import type {
  BrokerFillPort, BrokerSubmitPort, QuotePort,
  SlippageJournalPort, MonitorRegistrarPort,
} from "./orderExecutionPorts";

// All 7 steps. Each is pure-shaped: takes inputs, returns a uniform
// MicroStepResult, never throws. IO steps catch their own errors and
// surface them as ERRORED status.

// ── Step 1 — Prepare order ────────────────────────────────────────────────
export interface PrepareOrderInput {
  correlationId: string;
  symbol: string;
  direction: "BUY" | "SELL";
  lotSize: number;
  intendedPrice: number;
  stopLoss: number;
  takeProfit: number | null;
  maxSlippagePips: number;
  maxSpreadPips: number;
  fillTimeoutMs: number;
  pipSize: number;
  now?: Date;
}
export function prepareOrder(input: PrepareOrderInput): MicroStepResult<OrderTicket> {
  const start = Date.now();
  const blockers: string[] = [];
  if (input.lotSize <= 0)        blockers.push("lotSize must be positive");
  if (input.intendedPrice <= 0)  blockers.push("intendedPrice must be positive");
  if (input.stopLoss <= 0)       blockers.push("stopLoss must be positive");
  if (input.pipSize <= 0)        blockers.push("pipSize must be positive");
  if (input.maxSlippagePips < 0) blockers.push("maxSlippagePips cannot be negative");
  if (input.maxSpreadPips < 0)   blockers.push("maxSpreadPips cannot be negative");
  if (input.fillTimeoutMs <= 0)  blockers.push("fillTimeoutMs must be positive");

  if (blockers.length > 0) {
    return mkResult<OrderTicket>("PREPARE_ORDER", "BLOCKED", null,
      ["ticket inputs failed validation"], blockers, start);
  }

  const ticket: OrderTicket = {
    correlationId: input.correlationId,
    symbol: input.symbol,
    direction: input.direction,
    lotSize: input.lotSize,
    intendedPrice: input.intendedPrice,
    stopLoss: input.stopLoss,
    takeProfit: input.takeProfit,
    maxSlippagePips: input.maxSlippagePips,
    maxSpreadPips: input.maxSpreadPips,
    fillTimeoutMs: input.fillTimeoutMs,
    pipSize: input.pipSize,
    preparedAt: (input.now ?? new Date()).toISOString(),
  };
  return mkResult("PREPARE_ORDER", "PASSED", ticket,
    [`prepared ${ticket.direction} ${ticket.lotSize} ${ticket.symbol} @ ${ticket.intendedPrice}`],
    [], start);
}

// ── Step 2 — Check price still valid ──────────────────────────────────────
//
// Compares the live quote against the ticket's intendedPrice. The
// "execution-side" price for a BUY is the ask; for a SELL the bid. If the
// difference exceeds maxSlippagePips, abort BEFORE submitting.
export function checkPriceStillValid(
  ticket: OrderTicket, quote: MarketQuote,
): MicroStepResult<{ executionSidePrice: number; slippagePips: number }> {
  const start = Date.now();
  if (quote.symbol !== ticket.symbol) {
    return mkResult<{ executionSidePrice: number; slippagePips: number }>(
      "CHECK_PRICE_VALID", "BLOCKED", null,
      [`quote symbol ${quote.symbol} ≠ ticket symbol ${ticket.symbol}`],
      ["quote/ticket symbol mismatch"], start);
  }
  const executionSidePrice = ticket.direction === "BUY" ? quote.ask : quote.bid;
  const slippagePips = (executionSidePrice - ticket.intendedPrice) / ticket.pipSize
    * (ticket.direction === "BUY" ? 1 : -1);

  if (Math.abs(slippagePips) > ticket.maxSlippagePips) {
    return mkResult("CHECK_PRICE_VALID", "BLOCKED",
      { executionSidePrice, slippagePips },
      [`pre-submit slippage ${slippagePips.toFixed(2)}p > budget ${ticket.maxSlippagePips}p`],
      ["price moved beyond slippage budget before submit"], start);
  }
  return mkResult("CHECK_PRICE_VALID", "PASSED",
    { executionSidePrice, slippagePips },
    [`pre-submit slippage ${slippagePips.toFixed(2)}p within ${ticket.maxSlippagePips}p budget`],
    [], start);
}

// ── Step 3 — Spread re-check ──────────────────────────────────────────────
export function recheckSpread(
  ticket: OrderTicket, quote: MarketQuote,
): MicroStepResult<{ spreadPips: number }> {
  const start = Date.now();
  if (quote.spreadPips > ticket.maxSpreadPips) {
    return mkResult("RECHECK_SPREAD", "BLOCKED", { spreadPips: quote.spreadPips },
      [`spread ${quote.spreadPips.toFixed(2)}p > budget ${ticket.maxSpreadPips}p`],
      ["spread widened beyond budget between decide and submit"], start);
  }
  return mkResult("RECHECK_SPREAD", "PASSED", { spreadPips: quote.spreadPips },
    [`spread ${quote.spreadPips.toFixed(2)}p within ${ticket.maxSpreadPips}p budget`], [], start);
}

// ── Step 4 — Send to MT5 ──────────────────────────────────────────────────
export async function sendToMt5(
  ticket: OrderTicket, port: BrokerSubmitPort,
): Promise<MicroStepResult<{ brokerOrderId: string; acceptedAt: string }>> {
  const start = Date.now();
  try {
    const ack = await port.submit(ticket);
    if (ack === null) {
      return mkResult<{ brokerOrderId: string; acceptedAt: string }>(
        "SEND_TO_MT5", "BLOCKED", null,
        ["broker refused submission"],
        ["broker returned null ack — refused (rate limit / invalid instrument / closed market)"],
        start);
    }
    return mkResult("SEND_TO_MT5", "PASSED",
      { brokerOrderId: ack.brokerOrderId, acceptedAt: ack.acceptedAt },
      [`broker accepted as ${ack.brokerOrderId}`], [], start);
  } catch (err) {
    return mkResult<{ brokerOrderId: string; acceptedAt: string }>(
      "SEND_TO_MT5", "ERRORED", null,
      [`broker submit threw: ${(err as Error).message}`],
      ["broker submit raised — fail-closed, no fill assumed"], start);
  }
}

// ── Step 5 — Confirm fill (with timeout) ──────────────────────────────────
export async function confirmFill(
  brokerOrderId: string, timeoutMs: number, port: BrokerFillPort,
): Promise<MicroStepResult<FillEvent>> {
  const start = Date.now();
  try {
    const fill = await port.awaitFill(brokerOrderId, timeoutMs);
    if (fill === null) {
      return mkResult<FillEvent>("CONFIRM_FILL", "BLOCKED", null,
        [`fill not confirmed within ${timeoutMs}ms`],
        ["fill timeout — broker order may still be pending; reconciliation required"], start);
    }
    return mkResult("CONFIRM_FILL", "PASSED", fill,
      [`filled ${fill.filledLotSize} @ ${fill.filledPrice} in ${fill.latencyMs}ms`], [], start);
  } catch (err) {
    return mkResult<FillEvent>("CONFIRM_FILL", "ERRORED", null,
      [`awaitFill threw: ${(err as Error).message}`],
      ["fill confirmation raised — reconciliation required"], start);
  }
}

// ── Step 6 — Log slippage ─────────────────────────────────────────────────
//
// Slippage is computed signed: positive = filled WORSE than intended (paid
// more on a BUY, received less on a SELL). withinBudget reflects whether
// |slippagePips| stayed inside the ticket's slippage budget — a passing
// step records the slippage either way; the boolean lets downstream
// analytics flag breaches without re-deriving them.
export async function logSlippage(
  ticket: OrderTicket, fill: FillEvent, port: SlippageJournalPort, now?: Date,
): Promise<MicroStepResult<SlippageRecord>> {
  const start = Date.now();
  const sign = ticket.direction === "BUY" ? 1 : -1;
  const slippagePriceUnits = sign * (fill.filledPrice - ticket.intendedPrice);
  const slippagePips = slippagePriceUnits / ticket.pipSize;
  const withinBudget = Math.abs(slippagePips) <= ticket.maxSlippagePips;

  const record: SlippageRecord = {
    correlationId: ticket.correlationId,
    brokerOrderId: fill.brokerOrderId,
    symbol: ticket.symbol,
    direction: ticket.direction,
    intendedPrice: ticket.intendedPrice,
    filledPrice: fill.filledPrice,
    slippagePriceUnits,
    slippagePips,
    withinBudget,
    recordedAt: (now ?? new Date()).toISOString(),
  };

  try {
    await port.record(record);
    const tag = withinBudget ? "within budget" : "BREACH";
    return mkResult("LOG_SLIPPAGE", "PASSED", record,
      [`slippage ${slippagePips.toFixed(2)}p (${tag})`], [], start);
  } catch (err) {
    // Trade is already open — journal failure is non-fatal but surfaced.
    return mkResult("LOG_SLIPPAGE", "ERRORED", record,
      [`journal write failed: ${(err as Error).message}`,
       `slippage value computed: ${slippagePips.toFixed(2)}p`], [], start);
  }
}

// ── Step 7 — Start monitoring ─────────────────────────────────────────────
export async function startMonitoring(
  ticket: OrderTicket, fill: FillEvent, port: MonitorRegistrarPort, now?: Date,
): Promise<MicroStepResult<MonitoringHandle>> {
  const start = Date.now();
  const handle: MonitoringHandle = {
    brokerOrderId: fill.brokerOrderId,
    correlationId: ticket.correlationId,
    symbol: ticket.symbol,
    direction: ticket.direction,
    filledPrice: fill.filledPrice,
    stopLoss: ticket.stopLoss,
    takeProfit: ticket.takeProfit,
    monitoringStartedAt: (now ?? new Date()).toISOString(),
  };
  try {
    await port.register(handle);
    return mkResult("START_MONITORING", "PASSED", handle,
      [`registered ${fill.brokerOrderId} with monitor (SL ${ticket.stopLoss}, TP ${ticket.takeProfit ?? "none"})`],
      [], start);
  } catch (err) {
    // Trade is already open — registration failure is non-fatal but loud.
    return mkResult("START_MONITORING", "ERRORED", handle,
      [`monitor registration failed: ${(err as Error).message}`],
      ["trade is open but monitor was not notified — manual reconciliation required"],
      start);
  }
}

// ── Helper ────────────────────────────────────────────────────────────────
function mkResult<T>(
  kind: MicroStepKind, status: MicroStepResult["status"], output: T | null,
  reasons: string[], blockers: string[], startMs: number,
): MicroStepResult<T> {
  return {
    kind, label: MICRO_STEP_LABELS[kind], status, output,
    reasons, blockers, durationMs: Date.now() - startMs,
  };
}
