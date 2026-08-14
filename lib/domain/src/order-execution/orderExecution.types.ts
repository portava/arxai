import { z } from "zod/v4";

// ── 7 micro-steps — exactly the spec ─────────────────────────────────────
export const MicroStepKindSchema = z.enum([
  "PREPARE_ORDER",        // 1. build the OrderTicket from approved decision + sizing
  "CHECK_PRICE_VALID",    // 2. is the bid/ask still inside our slippage budget?
  "RECHECK_SPREAD",       // 3. did spread widen in the ms between decide and submit?
  "SEND_TO_MT5",          // 4. submit to broker via BrokerSubmitPort
  "CONFIRM_FILL",         // 5. await fill ack with timeout
  "LOG_SLIPPAGE",         // 6. compute intended-vs-filled and persist
  "START_MONITORING",     // 7. hand off to the monitor subdomain with a handle
]);
export type MicroStepKind = z.infer<typeof MicroStepKindSchema>;

export const MICRO_STEP_LABELS: Record<MicroStepKind, string> = {
  PREPARE_ORDER:     "Prepare order",
  CHECK_PRICE_VALID: "Check price still valid",
  RECHECK_SPREAD:    "Check spread again",
  SEND_TO_MT5:       "Send to MT5",
  CONFIRM_FILL:      "Confirm fill",
  LOG_SLIPPAGE:      "Log slippage",
  START_MONITORING:  "Start monitoring",
};

// ── Per-step result — uniform shape, never throws ────────────────────────
export interface MicroStepResult<T = unknown> {
  kind: MicroStepKind;
  label: string;
  status: "PASSED" | "BLOCKED" | "ERRORED" | "SKIPPED";
  output: T | null;
  reasons: string[];
  blockers: string[];
  durationMs: number;
}

// ── Order ticket — the immutable record built in step 1 ──────────────────
//
// Carries every value the later steps need to evaluate against. After
// PREPARE_ORDER nothing is re-derived from upstream state — the ticket is
// the single source of truth for the rest of the pipeline.
export interface OrderTicket {
  correlationId: string;       // idempotency key for the broker
  symbol: string;
  direction: "BUY" | "SELL";
  lotSize: number;
  intendedPrice: number;       // the price the decision was made against
  stopLoss: number;
  takeProfit: number | null;
  // Execution budgets — sourced from risk profile at PREPARE_ORDER time
  maxSlippagePips: number;     // bail at CHECK_PRICE_VALID if breached
  maxSpreadPips: number;       // bail at RECHECK_SPREAD if breached
  fillTimeoutMs: number;       // bail at CONFIRM_FILL if breached
  pipSize: number;             // symbol-specific (e.g. 0.0001 for FX, 0.01 for indices)
  preparedAt: string;
}

// ── Market quote — what each "still valid" gate evaluates against ────────
export interface MarketQuote {
  symbol: string;
  bid: number;
  ask: number;
  spreadPips: number;          // pre-computed by the quote source
  observedAt: string;
}

// ── Fill event — what comes back from CONFIRM_FILL ───────────────────────
export interface FillEvent {
  brokerOrderId: string;
  filledPrice: number;
  filledLotSize: number;
  filledAt: string;
  latencyMs: number;
}

// ── Slippage record — what LOG_SLIPPAGE produces ─────────────────────────
export interface SlippageRecord {
  correlationId: string;
  brokerOrderId: string;
  symbol: string;
  direction: "BUY" | "SELL";
  intendedPrice: number;
  filledPrice: number;
  slippagePriceUnits: number;  // signed: positive = worse than intended
  slippagePips: number;        // signed
  withinBudget: boolean;       // |slippagePips| ≤ ticket.maxSlippagePips
  recordedAt: string;
}

// ── Monitoring handle — what START_MONITORING returns ────────────────────
//
// This is intentionally a registration record only — no callbacks, no
// timers. The actual polling and intra-trade logic lives in the
// `trade/`/`pipeline/manageStage` cadence; this handle tells that loop
// "here's a new trade to watch and the parameters to watch against".
export interface MonitoringHandle {
  brokerOrderId: string;
  correlationId: string;
  symbol: string;
  direction: "BUY" | "SELL";
  filledPrice: number;
  stopLoss: number;
  takeProfit: number | null;
  monitoringStartedAt: string;
}

// ── Final pipeline outcome ───────────────────────────────────────────────
export interface OrderExecutionResult {
  passed: boolean;             // every step PASSED
  finalStep: MicroStepKind;    // last step that ran (passed or failed)
  steps: MicroStepResult[];    // ALL steps attempted, in declaration order
  reasons: string[];           // flattened from non-PASSED steps
  blockers: string[];          // flattened blockers
  ticket: OrderTicket | null;
  fill: FillEvent | null;
  slippage: SlippageRecord | null;
  monitoringHandle: MonitoringHandle | null;
}

// Fail-closed convention — same as risk-governor and stability-gate.
export const FAIL_CLOSED_ON_PORT_ERROR = true as const;
