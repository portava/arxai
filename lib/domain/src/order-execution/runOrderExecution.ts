import type {
  FillEvent, MarketQuote, MicroStepKind, MicroStepResult, MonitoringHandle,
  OrderExecutionResult, OrderTicket, SlippageRecord,
} from "./orderExecution.types";
import { MICRO_STEP_LABELS } from "./orderExecution.types";
import type { OrderExecutionPorts } from "./orderExecutionPorts";
import {
  prepareOrder, type PrepareOrderInput,
  checkPriceStillValid, recheckSpread,
  sendToMt5, confirmFill, logSlippage, startMonitoring,
} from "./orderExecutionSteps";

export interface RunOrderExecutionInput {
  prepare: PrepareOrderInput;
}

// runOrderExecution
//
// Orchestrator for the 7-step order pipeline. Runs steps in declared order,
// short-circuits on the first non-PASSED step BEFORE the broker is touched
// (steps 1-3) — once SEND_TO_MT5 has run we still try to advance through
// CONFIRM_FILL → LOG_SLIPPAGE → START_MONITORING because the trade may
// already be live and we need to reconcile.
//
// The result captures EVERY attempted step in order so the journal/UI can
// render exactly which gate failed and why.
export async function runOrderExecution(
  input: RunOrderExecutionInput, ports: OrderExecutionPorts,
  now: () => Date = () => new Date(),
): Promise<OrderExecutionResult> {
  const steps: MicroStepResult[] = [];
  let ticket: OrderTicket | null = null;
  let fill: FillEvent | null = null;
  let slippage: SlippageRecord | null = null;
  let monitoringHandle: MonitoringHandle | null = null;

  // ── 1. Prepare order ────────────────────────────────────────────────────
  const prepared = prepareOrder({ ...input.prepare, now: now() });
  steps.push(prepared);
  if (prepared.status !== "PASSED" || !prepared.output) {
    return finalize("PREPARE_ORDER", steps, ticket, fill, slippage, monitoringHandle);
  }
  ticket = prepared.output;

  // ── Single quote read shared by gates 2 and 3 ───────────────────────────
  // Both "still valid" checks evaluate against the SAME quote — otherwise
  // we'd race and could pass both even though the market moved between them.
  let quote: MarketQuote | null;
  try {
    quote = await ports.quote.currentQuote(ticket.symbol);
  } catch (err) {
    quote = null;
    // Surface as a CHECK_PRICE_VALID block — the caller sees a failed gate,
    // not a leaked exception.
    steps.push(mkErrorStep("CHECK_PRICE_VALID",
      `quote port threw: ${(err as Error).message}`,
      "could not fetch quote — fail-closed before submit"));
    return finalize("CHECK_PRICE_VALID", steps, ticket, fill, slippage, monitoringHandle);
  }
  if (quote === null) {
    steps.push(mkErrorStep("CHECK_PRICE_VALID",
      "quote port returned null",
      "no fresh quote available — fail-closed before submit"));
    return finalize("CHECK_PRICE_VALID", steps, ticket, fill, slippage, monitoringHandle);
  }

  // ── 2. Check price still valid ──────────────────────────────────────────
  const priceCheck = checkPriceStillValid(ticket, quote);
  steps.push(priceCheck);
  if (priceCheck.status !== "PASSED") {
    return finalize("CHECK_PRICE_VALID", steps, ticket, fill, slippage, monitoringHandle);
  }

  // ── 3. Re-check spread ──────────────────────────────────────────────────
  const spreadCheck = recheckSpread(ticket, quote);
  steps.push(spreadCheck);
  if (spreadCheck.status !== "PASSED") {
    return finalize("RECHECK_SPREAD", steps, ticket, fill, slippage, monitoringHandle);
  }

  // ── 4. Send to MT5 ──────────────────────────────────────────────────────
  const sent = await sendToMt5(ticket, ports.submit);
  steps.push(sent);
  if (sent.status !== "PASSED" || !sent.output) {
    return finalize("SEND_TO_MT5", steps, ticket, fill, slippage, monitoringHandle);
  }

  // ── 5. Confirm fill ─────────────────────────────────────────────────────
  // From here forward we DON'T short-circuit — even if confirm fails, the
  // order may already be live at the broker. Steps 6 and 7 are emitted as
  // SKIPPED with reconciliation reasons so the caller sees the full
  // 7-step picture and downstream monitoring knows there's a possibly-
  // orphan broker order to chase.
  const confirmed = await confirmFill(sent.output.brokerOrderId, ticket.fillTimeoutMs, ports.fill);
  steps.push(confirmed);
  if (confirmed.status !== "PASSED" || !confirmed.output) {
    const orphanId = sent.output.brokerOrderId;
    steps.push(mkSkippedStep("LOG_SLIPPAGE",
      "fill not confirmed — intended-vs-filled cannot be computed",
      `awaiting reconciliation for broker order ${orphanId}`));
    steps.push(mkSkippedStep("START_MONITORING",
      "fill not confirmed — monitor not registered with a known fill price",
      `MANUAL RECONCILIATION REQUIRED for broker order ${orphanId} — order may be live at broker`));
    return finalize("CONFIRM_FILL", steps, ticket, fill, slippage, monitoringHandle);
  }
  fill = confirmed.output;

  // ── 6. Log slippage ─────────────────────────────────────────────────────
  const logged = await logSlippage(ticket, fill, ports.slippageJournal, now());
  steps.push(logged);
  if (logged.output) slippage = logged.output;
  // ERRORED journal write is non-fatal — the trade is already open. Continue.

  // ── 7. Start monitoring ─────────────────────────────────────────────────
  const monitored = await startMonitoring(ticket, fill, ports.monitorRegistrar, now());
  steps.push(monitored);
  if (monitored.output) monitoringHandle = monitored.output;

  return finalize("START_MONITORING", steps, ticket, fill, slippage, monitoringHandle);
}

// ── Helpers ─────────────────────────────────────────────────────────────
function finalize(
  finalStep: MicroStepKind, steps: MicroStepResult[],
  ticket: OrderTicket | null, fill: FillEvent | null,
  slippage: SlippageRecord | null, monitoringHandle: MonitoringHandle | null,
): OrderExecutionResult {
  const passed = steps.length === 7 && steps.every((s) => s.status === "PASSED");
  const reasons = steps
    .filter((s) => s.status !== "PASSED")
    .flatMap((s) => s.reasons.map((r) => `[${s.kind}] ${r}`));
  const blockers = steps
    .filter((s) => s.status !== "PASSED")
    .flatMap((s) => s.blockers.map((b) => `[${s.kind}] ${b}`));

  return {
    passed, finalStep, steps,
    reasons, blockers,
    ticket, fill, slippage, monitoringHandle,
  };
}

function mkErrorStep(kind: MicroStepKind, reason: string, blocker: string): MicroStepResult {
  return {
    kind, label: MICRO_STEP_LABELS[kind],
    status: "ERRORED", output: null,
    reasons: [reason], blockers: [blocker],
    durationMs: 0,
  };
}

function mkSkippedStep(kind: MicroStepKind, reason: string, blocker: string): MicroStepResult {
  return {
    kind, label: MICRO_STEP_LABELS[kind],
    status: "SKIPPED", output: null,
    reasons: [reason], blockers: [blocker],
    durationMs: 0,
  };
}
