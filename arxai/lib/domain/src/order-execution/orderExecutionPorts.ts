import type { FillEvent, MarketQuote, OrderTicket } from "./orderExecution.types";

// Ports = interfaces the domain depends on but does not implement. Concrete
// adapters (real MT5 bridge, paper-broker fake, in-memory test fake) live
// outside the domain and are constructor-injected into the orchestrator.

// QuotePort — fresh bid/ask read at gate-evaluation time. Steps 2 and 3
// both call this so they evaluate against the SAME quote (caller passes
// the snapshot through, the port is invoked at most once per pipeline run).
export interface QuotePort {
  currentQuote(symbol: string): Promise<MarketQuote | null>;
}

// BrokerSubmitPort — step 4. Submits the ticket and returns an ack.
// The adapter is responsible for idempotency keying off ticket.correlationId.
// Returns null when the broker explicitly refused (rate limit, invalid
// instrument, etc.) — the orchestrator turns null into BLOCKED.
export interface BrokerSubmitPort {
  submit(ticket: OrderTicket): Promise<BrokerSubmitAck | null>;
}

export interface BrokerSubmitAck {
  brokerOrderId: string;
  acceptedAt: string;
}

// BrokerFillPort — step 5. Polls or subscribes for fill confirmation up
// to timeoutMs. Returns null on timeout (NOT a thrown error — timeouts
// are an expected pipeline state, not exceptional).
export interface BrokerFillPort {
  awaitFill(brokerOrderId: string, timeoutMs: number): Promise<FillEvent | null>;
}

// SlippageJournalPort — step 6. Persists the slippage record. Pure
// fire-and-forget; failures don't fail the pipeline (the trade is already
// open at this point).
export interface SlippageJournalPort {
  record(slippage: import("./orderExecution.types").SlippageRecord): Promise<void>;
}

// MonitorRegistrarPort — step 7. Registers the new trade with the
// monitoring loop. Same fire-and-forget contract as the journal port.
export interface MonitorRegistrarPort {
  register(handle: import("./orderExecution.types").MonitoringHandle): Promise<void>;
}

// Bundle the orchestrator accepts.
export interface OrderExecutionPorts {
  quote: QuotePort;
  submit: BrokerSubmitPort;
  fill: BrokerFillPort;
  slippageJournal: SlippageJournalPort;
  monitorRegistrar: MonitorRegistrarPort;
}

// In-memory no-op ports — for tests and for typing the orchestrator in
// MOCK mode. Throws on submit by design (mock-mode callers should never
// reach SEND_TO_MT5 — they should branch earlier in their own flow).
export const NULL_ORDER_EXECUTION_PORTS: OrderExecutionPorts = {
  quote: { async currentQuote() { return null; } },
  submit: { async submit() { throw new Error("BrokerSubmitPort.submit not implemented"); } },
  fill: { async awaitFill() { return null; } },
  slippageJournal: { async record() { /* discard */ } },
  monitorRegistrar: { async register() { /* discard */ } },
};
