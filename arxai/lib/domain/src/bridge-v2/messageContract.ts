// ── ARX Bridge v2 — wire message contract (Task #371) ───────────────────────
//
// The Bridge v2 kernel turns the MT5 EA from a snapshot/poll client into a
// broker-truth EVENT source. Every message the EA pushes carries a common
// envelope (protocol version, stream key, monotonic sequence, idempotency key,
// EA-side creation timestamp) so the server can:
//   - reject malformed / unauthenticated payloads (validation),
//   - detect duplicates (idempotency key),
//   - detect drops / reordering (per-stream monotonic sequence + gap),
//   - measure transport latency (EA-created vs server-received).
//
// SAFETY: this module is PURE (no IO, no DB, no HTTP). Importing it unlocks no
// execution path. It defines truth-shapes only — the EA is a sensor, never a
// decision maker. Account/position/fill/close values are broker-reported facts;
// the contract never invents them and intentionally has NO field that asserts a
// fill without a broker ticket + retcode.

import { z } from "zod/v4";

// Bump when the wire shape changes incompatibly. The server records this per
// event so a mixed-version fleet is observable.
export const BRIDGE_V2_PROTOCOL_VERSION = 2 as const;

// The 12 Bridge v2 message types. Each is an independent ordered stream
// (its own sequence space) keyed by (userId, bridgeConnectionId, messageType).
export const BRIDGE_V2_MESSAGE_TYPES = [
  "HEARTBEAT", // liveness + EA identity + capability flags
  "ACCOUNT_SNAPSHOT", // balance / equity / margin / free margin (broker truth)
  "POSITIONS_SNAPSHOT", // full open-positions sweep (complete book, even if empty)
  "ORDERS_SNAPSHOT", // full pending-orders sweep
  "TRADE_TRANSACTION", // OnTradeTransaction event push (the core v2 upgrade)
  "DEAL_HISTORY", // closed deals (realised P/L truth)
  "TICK", // best bid/ask tick for a symbol
  "CANDLE", // closed OHLC bar for a symbol/timeframe (broker-native feed)
  "COMMAND_RESULT", // execution outcome for a dispatched ARX command
  "CONFIG_ACK", // EA acknowledges an applied remote-config version
  "SYMBOL_SPEC", // per-symbol contract spec (digits, contract size, min lot)
  "ERROR_REPORT", // EA-side setup / runtime error (clear operator messaging)
] as const;

export type BridgeV2MessageType = (typeof BRIDGE_V2_MESSAGE_TYPES)[number];

// ── Common envelope ─────────────────────────────────────────────────────────
// Every message shares this. `streamKey` lets one EA run several independent
// ordered streams (e.g. per-symbol tick streams) without cross-stream gaps.
export const bridgeV2EnvelopeSchema = z.object({
  protocolVersion: z.literal(BRIDGE_V2_PROTOCOL_VERSION),
  messageType: z.enum(BRIDGE_V2_MESSAGE_TYPES),
  // Logical ordered-stream identifier within a message type, e.g. "default",
  // "TICK:EURUSD". Bounded to keep stream-state tables small.
  streamKey: z.string().min(1).max(64),
  // Monotonic per-stream counter assigned by the EA. Strictly increasing within
  // a (connection, messageType, streamKey). Used for gap/duplicate/reset detect.
  sequence: z.number().int().nonnegative(),
  // Globally-unique-per-connection idempotency key. The server dedupes on this.
  idempotencyKey: z.string().min(8).max(128),
  // EA-side wall clock at message creation (ms epoch). Latency = received - this.
  eaCreatedAtEpochMs: z.number().int().positive(),
  // EA version string (e.g. "2.00"). Mirrors the heartbeat for per-event audit.
  eaVersion: z.string().min(1).max(32),
});
export type BridgeV2Envelope = z.infer<typeof bridgeV2EnvelopeSchema>;

// ── Per-type payloads (broker-reported truth only) ──────────────────────────

export const heartbeatPayloadSchema = z.object({
  accountType: z.string().min(1).max(16), // "live" | "real" | "demo" reported by EA
  terminalConnected: z.boolean(),
  algoTradingAllowed: z.boolean(),
  // EA local safety inputs (nested in v1.50+). Read nested-first upstream.
  eaInputs: z
    .object({
      enableLiveExecution: z.boolean().optional(),
      readOnlyMode: z.boolean().optional(),
      maxLiveLot: z.number().nonnegative().optional(),
    })
    .partial()
    .optional(),
  capabilities: z.record(z.string(), z.boolean()).optional(),
});

export const accountSnapshotPayloadSchema = z.object({
  balance: z.number(),
  equity: z.number(),
  margin: z.number().nonnegative(),
  freeMargin: z.number(),
  marginLevel: z.number().nonnegative().nullable().optional(),
  currency: z.string().min(1).max(8),
  // Broker server time at snapshot (ms epoch). Distinct from eaCreatedAtEpochMs.
  brokerTimeEpochMs: z.number().int().positive().nullable().optional(),
});

export const positionRowSchema = z.object({
  brokerTicket: z.string().min(1).max(64),
  symbol: z.string().min(1).max(32),
  side: z.enum(["BUY", "SELL"]),
  volume: z.number().positive(),
  openPrice: z.number().positive(),
  currentPrice: z.number().nonnegative().nullable().optional(),
  stopLoss: z.number().nonnegative().nullable().optional(),
  takeProfit: z.number().nonnegative().nullable().optional(),
  floatingPl: z.number().nullable().optional(),
  openedAtEpochMs: z.number().int().positive().nullable().optional(),
});

export const positionsSnapshotPayloadSchema = z.object({
  // Full sweep. An empty array is a meaningful "book is empty" fact, not a gap.
  positions: z.array(positionRowSchema).max(500),
  sweepComplete: z.literal(true),
});

export const orderRowSchema = z.object({
  brokerTicket: z.string().min(1).max(64),
  symbol: z.string().min(1).max(32),
  orderType: z.string().min(1).max(32),
  volume: z.number().positive(),
  price: z.number().nonnegative(),
  stopLoss: z.number().nonnegative().nullable().optional(),
  takeProfit: z.number().nonnegative().nullable().optional(),
});

export const ordersSnapshotPayloadSchema = z.object({
  orders: z.array(orderRowSchema).max(500),
  sweepComplete: z.literal(true),
});

// OnTradeTransaction — the event that makes order state broker-confirmed rather
// than poll-inferred. `dealTicket`/`orderTicket`/`positionTicket` are the broker
// truth identifiers; `retcode` is the broker return code.
export const tradeTransactionPayloadSchema = z.object({
  transactionType: z.string().min(1).max(48), // MT5 ENUM_TRADE_TRANSACTION_TYPE name
  symbol: z.string().min(1).max(32).nullable().optional(),
  orderTicket: z.string().max(64).nullable().optional(),
  dealTicket: z.string().max(64).nullable().optional(),
  positionTicket: z.string().max(64).nullable().optional(),
  volume: z.number().nonnegative().nullable().optional(),
  price: z.number().nonnegative().nullable().optional(),
  retcode: z.number().int().nullable().optional(),
  brokerComment: z.string().max(256).nullable().optional(),
  // The ARX command this transaction fulfils, when correlatable.
  arxCommandId: z.string().max(64).nullable().optional(),
});

export const dealHistoryPayloadSchema = z.object({
  dealTicket: z.string().min(1).max(64),
  positionTicket: z.string().max(64).nullable().optional(),
  symbol: z.string().min(1).max(32),
  side: z.enum(["BUY", "SELL"]),
  volume: z.number().positive(),
  price: z.number().positive(),
  profit: z.number(), // realised P/L — broker truth
  commission: z.number().nullable().optional(),
  swap: z.number().nullable().optional(),
  closedAtEpochMs: z.number().int().positive(),
});

export const tickPayloadSchema = z.object({
  symbol: z.string().min(1).max(32),
  bid: z.number().positive(),
  ask: z.number().positive(),
  brokerTimeEpochMs: z.number().int().positive(),
});

export const candlePayloadSchema = z.object({
  symbol: z.string().min(1).max(32),
  timeframe: z.string().min(1).max(8), // "M1" | "M5" | "H1" | "D1" …
  openTimeEpochMs: z.number().int().positive(),
  open: z.number().positive(),
  high: z.number().positive(),
  low: z.number().positive(),
  close: z.number().positive(),
  volume: z.number().nonnegative(),
  // Only closed bars are truth. An in-progress bar must never be marked closed.
  isClosed: z.literal(true),
});

export const commandResultPayloadSchema = z.object({
  arxCommandId: z.string().min(1).max(64),
  outcome: z.enum(["EXECUTED", "PARTIAL", "REJECTED", "FAILED"]),
  brokerTicket: z.string().max(64).nullable().optional(),
  dealTicket: z.string().max(64).nullable().optional(),
  filledVolume: z.number().nonnegative().nullable().optional(),
  fillPrice: z.number().nonnegative().nullable().optional(),
  retcode: z.number().int().nullable().optional(),
  brokerMessage: z.string().max(256).nullable().optional(),
});

export const configAckPayloadSchema = z.object({
  appliedConfigVersion: z.number().int().nonnegative(),
});

export const symbolSpecPayloadSchema = z.object({
  symbol: z.string().min(1).max(32),
  digits: z.number().int().nonnegative(),
  contractSize: z.number().positive(),
  minLot: z.number().positive(),
  maxLot: z.number().positive(),
  lotStep: z.number().positive(),
  tickValue: z.number().nonnegative().nullable().optional(),
});

export const errorReportPayloadSchema = z.object({
  code: z.string().min(1).max(64),
  message: z.string().min(1).max(512),
  // Operator-actionable hint, e.g. "Enable AutoTrading in MT5 toolbar".
  operatorHint: z.string().max(512).nullable().optional(),
  fatal: z.boolean(),
});

// Map message type → payload schema. Server validation looks up by messageType.
export const BRIDGE_V2_PAYLOAD_SCHEMAS = {
  HEARTBEAT: heartbeatPayloadSchema,
  ACCOUNT_SNAPSHOT: accountSnapshotPayloadSchema,
  POSITIONS_SNAPSHOT: positionsSnapshotPayloadSchema,
  ORDERS_SNAPSHOT: ordersSnapshotPayloadSchema,
  TRADE_TRANSACTION: tradeTransactionPayloadSchema,
  DEAL_HISTORY: dealHistoryPayloadSchema,
  TICK: tickPayloadSchema,
  CANDLE: candlePayloadSchema,
  COMMAND_RESULT: commandResultPayloadSchema,
  CONFIG_ACK: configAckPayloadSchema,
  SYMBOL_SPEC: symbolSpecPayloadSchema,
  ERROR_REPORT: errorReportPayloadSchema,
} as const satisfies Record<BridgeV2MessageType, z.ZodTypeAny>;

// Full message = envelope + a payload object. We validate the envelope first
// (cheap, structural), then the payload against the type-specific schema.
export const bridgeV2MessageSchema = bridgeV2EnvelopeSchema.extend({
  payload: z.unknown(),
});
export type BridgeV2Message = z.infer<typeof bridgeV2MessageSchema>;

export interface BridgeV2ValidationOk {
  ok: true;
  envelope: BridgeV2Envelope;
  payload: unknown;
}
export interface BridgeV2ValidationErr {
  ok: false;
  // Stable machine codes — never fabricate success on a validation failure.
  error: "ENVELOPE_INVALID" | "UNKNOWN_MESSAGE_TYPE" | "PAYLOAD_INVALID";
  detail: string;
}
export type BridgeV2ValidationResult = BridgeV2ValidationOk | BridgeV2ValidationErr;

// Pure validation of one raw EA message. Used by the ingest service.
export function validateBridgeV2Message(raw: unknown): BridgeV2ValidationResult {
  const env = bridgeV2MessageSchema.safeParse(raw);
  if (!env.success) {
    return { ok: false, error: "ENVELOPE_INVALID", detail: env.error.message };
  }
  const schema = BRIDGE_V2_PAYLOAD_SCHEMAS[env.data.messageType];
  if (!schema) {
    return {
      ok: false,
      error: "UNKNOWN_MESSAGE_TYPE",
      detail: `No payload schema for messageType=${env.data.messageType}`,
    };
  }
  const payload = schema.safeParse(env.data.payload);
  if (!payload.success) {
    return { ok: false, error: "PAYLOAD_INVALID", detail: payload.error.message };
  }
  const { payload: _omit, ...envelope } = env.data;
  return { ok: true, envelope, payload: payload.data };
}
