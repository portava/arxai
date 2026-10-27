// Self-Trade AI — PROTECTIVE-ACTION path (owner decision, 2026-10-27).
// PURE / deterministic. No IO, no clock, no imports outside this folder.
//
// The ordinary manager holds when the broker position snapshot is stale. This
// module supplies the pure half of the separate protective-action path that
// starts FROM that hold: it classifies which triggers count as protective,
// verifies that a fresh row and the bridge still describe the exact position
// the agent opened, and proves that a proposed CLOSE / stop move
//   (1) cannot increase exposure,
//   (2) cannot reverse the position,
//   (3) cannot loosen (or no-op) the stop or place it at/through price,
// and leaves the take-profit untouched. Every refusal carries a structured
// reason plus a plain-English explanation for operators.
//
// SAFETY (inviolable):
// - This module never acts. It only answers "may this exact intent be sent?".
// - First failure wins; malformed input is a refusal, never a default.
// - Nothing here loosens a downstream check (Guardian, Risk Governor, target
//   geometry, EA preflight). It only adds refusals.

import type { PositionManagementVerdict } from "./positionManagement.js";

// ── Triggers ─────────────────────────────────────────────────────────────────

/** Protective triggers. Final-TP / first-TP exits are profit-taking, not protective. */
export type ProtectiveTrigger = "EXIT_INVALIDATION" | "MOVE_TO_BE" | "TIGHTEN_SL";

export function classifyProtectiveTrigger(
  verdict: Pick<PositionManagementVerdict, "action" | "trigger"> | null | undefined,
): ProtectiveTrigger | null {
  if (!verdict || typeof verdict !== "object") return null;
  if (verdict.action === "EXIT" && verdict.trigger === "INVALIDATION_BREACH")
    return "EXIT_INVALIDATION";
  if (verdict.action === "MOVE_TO_BE" && verdict.trigger === "BREAK_EVEN")
    return "MOVE_TO_BE";
  if (verdict.action === "TIGHTEN_SL" && verdict.trigger === "TRAIL")
    return "TIGHTEN_SL";
  return null;
}

// ── Hold reasons ─────────────────────────────────────────────────────────────

export const PROTECTIVE_HOLD_REASONS = [
  // Pre-checks that make waiting pointless.
  "PROTECTIVE_HOLD_PLATFORM_STOP_ENGAGED",
  "PROTECTIVE_HOLD_USER_NOT_ARMED",
  "PROTECTIVE_HOLD_USER_KILL_SWITCH",
  "PROTECTIVE_HOLD_TERMINAL_UPGRADE_REQUIRED",
  // Evidence wait.
  "PROTECTIVE_HOLD_NO_FRESH_SWEEP",
  "PROTECTIVE_HOLD_DEFERRED_TO_NEXT_CYCLE",
  "PROTECTIVE_HOLD_TRIGGER_CLEARED",
  // Claim / dispatch outcome.
  "PROTECTIVE_HOLD_CLAIM_RACE",
  "PROTECTIVE_HOLD_PIPELINE_REFUSED",
  "PROTECTIVE_HOLD_OUTCOME_UNCERTAIN",
  "PROTECTIVE_HOLD_INTERNAL_ERROR",
  // Bridge identity.
  "PROTECTIVE_BRIDGE_UNVERIFIED",
  "PROTECTIVE_BRIDGE_OWNER_MISMATCH",
  "PROTECTIVE_BRIDGE_ACCOUNT_MISMATCH",
  "PROTECTIVE_BRIDGE_REVOKED",
  "PROTECTIVE_BRIDGE_NOT_LIVE",
  "PROTECTIVE_BRIDGE_OFFLINE",
  "PROTECTIVE_BRIDGE_HEARTBEAT_NOT_FRESH",
  // Observation evidence.
  "PROTECTIVE_OBSERVATION_POSITION_CLOSED",
  "PROTECTIVE_OBSERVATION_TIMESTAMP_INVALID",
  "PROTECTIVE_OBSERVATION_FUTURE_DATED",
  "PROTECTIVE_OBSERVATION_STALE",
  "PROTECTIVE_OBSERVATION_NOT_FROM_SWEEP",
  "PROTECTIVE_POSITION_ABSENT_AT_BROKER",
  "PROTECTIVE_OBSERVATION_NOT_NEWER",
  "PROTECTIVE_OBSERVATION_PREDATES_COMMAND",
  "PROTECTIVE_SWEEP_MARKER_STALE",
  "PROTECTIVE_OBSERVATION_PRICE_INVALID",
  // Position identity.
  "PROTECTIVE_IDENTITY_ROW_MISSING",
  "PROTECTIVE_IDENTITY_OWNER_MISMATCH",
  "PROTECTIVE_IDENTITY_ACCOUNT_MISMATCH",
  "PROTECTIVE_IDENTITY_TICKET_MISMATCH",
  "PROTECTIVE_IDENTITY_SOURCE_COMMAND_MISMATCH",
  "PROTECTIVE_IDENTITY_SYMBOL_MISMATCH",
  "PROTECTIVE_IDENTITY_SIDE_MISMATCH",
  "PROTECTIVE_IDENTITY_VOLUME_CHANGED",
  // Geometry.
  "PROTECTIVE_GEOMETRY_INVALID",
  "PROTECTIVE_SIDE_MISMATCH",
  "PROTECTIVE_WOULD_REVERSE",
  "PROTECTIVE_PARTIAL_NOT_SUPPORTED",
  "PROTECTIVE_STOP_NOT_TIGHTER",
  "PROTECTIVE_STOP_THROUGH_PRICE",
  "PROTECTIVE_TAKE_PROFIT_CHANGED",
  // Cycle level.
  "MANAGEMENT_PAUSED_AACI_REVIEW",
] as const;

export type ProtectiveHoldReason = (typeof PROTECTIVE_HOLD_REASONS)[number];

export type ProtectiveCheck =
  | { ok: true }
  | { ok: false; reason: ProtectiveHoldReason; detail: Record<string, unknown> };

const OK: ProtectiveCheck = { ok: true };

// ── Hygiene ──────────────────────────────────────────────────────────────────

/** Same price epsilon as positionManagement.ts. */
const EPS_PRICE = 1e-9;
const pos = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v > 0;
const posInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const nonempty = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;
/** Same volume tolerance as executionLifecycle.fullVolumeEvidence. */
const volTol = (v: number): number => Math.max(1, Math.abs(v)) * Number.EPSILON * 16;
const nearVolume = (a: unknown, b: unknown): boolean =>
  pos(a) && pos(b) && Math.abs(a - b) <= volTol(b);

export type ProtectiveSide = "BUY" | "SELL";
const isSide = (v: unknown): v is ProtectiveSide => v === "BUY" || v === "SELL";
const isRecord = (v: unknown): v is Record<string, unknown> =>
  v != null && typeof v === "object" && !Array.isArray(v);
const sameKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => own.includes(k));
};

// ── Geometry ─────────────────────────────────────────────────────────────────

export interface ProtectivePositionFacts {
  side: ProtectiveSide;
  volume: number;
  entryPrice: number;
  /** BID for BUY / ASK for SELL in v154 snapshots: the side the stop triggers on. */
  currentPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
}

export type ProtectiveIntent =
  | { kind: "CLOSE"; side: ProtectiveSide; volume: number }
  | {
      kind: "MODIFY_STOP";
      side: ProtectiveSide;
      newStopLoss: number;
      /** Must be stated explicitly and equal the position's take-profit. */
      newTakeProfit: number | null;
    };

type ValidIntent =
  | { kind: "CLOSE"; side: ProtectiveSide; volume: number }
  | { kind: "MODIFY_STOP"; side: ProtectiveSide; newStopLoss: number | null; newTakeProfit: number | null };

const CLOSE_KEYS = ["kind", "side", "volume"] as const;
const MODIFY_KEYS = ["kind", "side", "newStopLoss", "newTakeProfit"] as const;

function validPosition(p: unknown): p is ProtectivePositionFacts {
  if (!isRecord(p)) return false;
  return (
    isSide(p.side) &&
    pos(p.volume) &&
    pos(p.entryPrice) &&
    pos(p.currentPrice) &&
    (p.stopLoss === null || pos(p.stopLoss)) &&
    (p.takeProfit === null || pos(p.takeProfit))
  );
}

/** Exact shape only: unknown kinds, extra keys, missing keys or bad values refuse. */
function validIntent(i: unknown): ValidIntent | null {
  if (!isRecord(i)) return null;
  if (i.kind === "CLOSE") {
    if (!sameKeys(i, CLOSE_KEYS) || !isSide(i.side) || !pos(i.volume)) return null;
    return { kind: "CLOSE", side: i.side, volume: i.volume };
  }
  if (i.kind === "MODIFY_STOP") {
    if (
      !sameKeys(i, MODIFY_KEYS) ||
      !isSide(i.side) ||
      !(i.newStopLoss === null || pos(i.newStopLoss)) ||
      !(i.newTakeProfit === null || pos(i.newTakeProfit))
    )
      return null;
    return {
      kind: "MODIFY_STOP",
      side: i.side,
      newStopLoss: i.newStopLoss,
      newTakeProfit: i.newTakeProfit,
    };
  }
  return null;
}

type Refusal = Extract<ProtectiveCheck, { ok: false }>;
type Shaped = { ok: true; position: ProtectivePositionFacts; intent: ValidIntent } | Refusal;
const refuse = (reason: ProtectiveHoldReason, detail: Record<string, unknown>): Refusal => ({
  ok: false,
  reason,
  detail,
});

function shape(position: unknown, intent: unknown): Shaped {
  if (!validPosition(position))
    return refuse("PROTECTIVE_GEOMETRY_INVALID", { problem: "position facts malformed" });
  const valid = validIntent(intent);
  if (!valid)
    return refuse("PROTECTIVE_GEOMETRY_INVALID", {
      problem: "intent malformed",
      kind: isRecord(intent) ? String(intent.kind) : typeof intent,
    });
  if (valid.side !== position.side)
    return refuse("PROTECTIVE_SIDE_MISMATCH", {
      action: valid.kind,
      intentSide: valid.side,
      positionSide: position.side,
    });
  return { ok: true, position, intent: valid };
}

function reverseRule(p: ProtectivePositionFacts, i: ValidIntent): ProtectiveCheck {
  if (i.kind !== "CLOSE") return OK;
  // A close is an opposite-side market order on a netting account: anything
  // above the open volume flips the exposure.
  if (i.volume > p.volume + volTol(p.volume))
    return refuse("PROTECTIVE_WOULD_REVERSE", {
      action: "CLOSE",
      volume: i.volume,
      positionVolume: p.volume,
    });
  return OK;
}

function partialRule(p: ProtectivePositionFacts, i: ValidIntent): ProtectiveCheck {
  if (i.kind !== "CLOSE") return OK;
  if (i.volume < p.volume - volTol(p.volume))
    return refuse("PROTECTIVE_PARTIAL_NOT_SUPPORTED", {
      action: "CLOSE",
      volume: i.volume,
      positionVolume: p.volume,
    });
  return OK;
}

function stopRule(p: ProtectivePositionFacts, i: ValidIntent): ProtectiveCheck {
  if (i.kind !== "MODIFY_STOP") return OK;
  const s = i.newStopLoss;
  const c = p.stopLoss;
  const price = p.currentPrice;
  const detail = { action: "MODIFY_STOP", newSl: s, currentSl: c, p: price, side: p.side };
  // Removing the stop is a widening (isStopWidened / Guardian STOP_WOULD_WIDEN).
  if (s === null) return refuse("PROTECTIVE_STOP_NOT_TIGHTER", { ...detail, problem: "stop removal" });
  // Never at or through the price the stop triggers on.
  const through = p.side === "BUY" ? !(s < price - EPS_PRICE) : !(s > price + EPS_PRICE);
  if (through) return refuse("PROTECTIVE_STOP_THROUGH_PRICE", detail);
  // Strictly tighter than the current stop; equal is a no-op and must not spend a claim.
  if (c !== null) {
    const tighter = p.side === "BUY" ? s > c + EPS_PRICE : s < c - EPS_PRICE;
    if (!tighter) return refuse("PROTECTIVE_STOP_NOT_TIGHTER", detail);
  }
  return OK;
}

function takeProfitRule(p: ProtectivePositionFacts, i: ValidIntent): ProtectiveCheck {
  if (i.kind !== "MODIFY_STOP") return OK;
  const same =
    (i.newTakeProfit === null && p.takeProfit === null) ||
    (i.newTakeProfit !== null &&
      p.takeProfit !== null &&
      Math.abs(i.newTakeProfit - p.takeProfit) <= EPS_PRICE);
  if (!same)
    return refuse("PROTECTIVE_TAKE_PROFIT_CHANGED", {
      action: "MODIFY_STOP",
      newTp: i.newTakeProfit,
      currentTp: p.takeProfit,
    });
  return OK;
}

/** G1 — CLOSE never partial or over-volume; MODIFY never changes the take-profit. */
export function doesNotIncreaseExposure(
  position: ProtectivePositionFacts,
  intent: ProtectiveIntent,
): ProtectiveCheck {
  const s = shape(position, intent);
  if (!s.ok) return s;
  for (const rule of [partialRule, reverseRule, takeProfitRule]) {
    const v = rule(s.position, s.intent);
    if (!v.ok) return v;
  }
  return OK;
}

/** G2 — same side, never more than the open volume (an over-close is a reversal). */
export function doesNotReverse(
  position: ProtectivePositionFacts,
  intent: ProtectiveIntent,
): ProtectiveCheck {
  const s = shape(position, intent);
  if (!s.ok) return s;
  return reverseRule(s.position, s.intent);
}

/** G3 — a stop move is strictly tighter, never removed, never at/through price. */
export function doesNotLoosenStop(
  position: ProtectivePositionFacts,
  intent: ProtectiveIntent,
): ProtectiveCheck {
  const s = shape(position, intent);
  if (!s.ok) return s;
  return stopRule(s.position, s.intent);
}

/** G1 ∧ G2 ∧ G3 in a fixed order: invalid → side → reverse → partial → stop → take-profit. */
export function evaluateProtectiveGeometry(
  position: ProtectivePositionFacts,
  intent: ProtectiveIntent,
): ProtectiveCheck {
  const s = shape(position, intent);
  if (!s.ok) return s;
  for (const rule of [reverseRule, partialRule, stopRule, takeProfitRule]) {
    const v = rule(s.position, s.intent);
    if (!v.ok) return v;
  }
  return OK;
}

// ── Identity ─────────────────────────────────────────────────────────────────

/** The attributed entry command, as the manager verified it. */
export interface ProtectiveEntryFacts {
  commandId: string | null;
  userId: number | null;
  bridgeConnectionId: number | null;
  accountLogin: string | null;
  brokerServer: string | null;
  brokerTicket: string | null;
  symbol: string;
  requestedVolume: number | null;
  executedVolume: number | null;
}

export interface ProtectiveExecutionFacts {
  executingUserId: number | null;
  brokerTicket: string | null;
  side: string;
  intendedVolume: number;
}

/** The bridge connection as every non-auth caller sees it (no token hashes). */
export interface ProtectiveBridgeFacts {
  id: number;
  userId: number | null;
  accountNumber: string | null;
  brokerName: string | null;
  serverName: string | null;
  tokenRevokedAt: Date | string | null;
  status: string;
  hasBridgeToken: boolean;
  accountType: string | null;
  mode: string;
  capabilities: unknown;
}

/** The fresh ledger row's immutable identity fields. */
export interface ProtectiveRowFacts {
  id: number;
  userId: number;
  bridgeConnectionId: number | null;
  accountLogin: string | null;
  brokerServer: string | null;
  brokerTicket: string | null;
  sourceCommandId: string | null;
  symbol: string;
  side: string;
  volume: number;
}

/** Shared heartbeat labels (broker-health/heartbeatPolicy); only fresh/degraded are online. */
export type ProtectiveHeartbeat = "fresh" | "degraded" | "offline" | "unknown";

function bridgeDetail(
  conn: ProtectiveBridgeFacts | null | undefined,
  entry: ProtectiveEntryFacts,
): Record<string, unknown> {
  return {
    bridge: conn?.id ?? null,
    expectedBridge: entry.bridgeConnectionId,
    login: conn?.accountNumber ?? null,
    server: conn?.serverName ?? null,
    company: conn?.brokerName ?? null,
    mode: conn?.mode ?? null,
    accountType: conn?.accountType ?? null,
    expectedLogin: entry.accountLogin,
    expectedCompany: entry.brokerServer,
  };
}

/** The bridge that will carry the command is the one the entry was dispatched on, live, owned and online. */
export function verifyProtectiveBridge(
  entry: ProtectiveEntryFacts,
  execution: ProtectiveExecutionFacts,
  conn: ProtectiveBridgeFacts | null | undefined,
  heartbeat: ProtectiveHeartbeat,
): ProtectiveCheck {
  const detail = bridgeDetail(conn, entry);
  if (!isRecord(conn) || !posInt(entry.bridgeConnectionId) || conn.id !== entry.bridgeConnectionId)
    return refuse("PROTECTIVE_BRIDGE_UNVERIFIED", detail);
  if (!posInt(execution.executingUserId) || conn.userId !== execution.executingUserId)
    return refuse("PROTECTIVE_BRIDGE_OWNER_MISMATCH", {
      ...detail,
      owner: conn.userId,
      expectedOwner: execution.executingUserId,
    });
  if (
    !nonempty(conn.accountNumber) ||
    conn.accountNumber !== entry.accountLogin ||
    !nonempty(conn.brokerName) ||
    conn.brokerName !== entry.brokerServer ||
    !nonempty(conn.serverName)
  )
    return refuse("PROTECTIVE_BRIDGE_ACCOUNT_MISMATCH", detail);
  if (conn.tokenRevokedAt != null || conn.status === "revoked" || conn.hasBridgeToken !== true)
    return refuse("PROTECTIVE_BRIDGE_REVOKED", { ...detail, status: conn.status });
  const acct = String(conn.accountType ?? "").toLowerCase();
  if ((acct !== "live" && acct !== "real") || conn.mode === "MOCK")
    return refuse("PROTECTIVE_BRIDGE_NOT_LIVE", detail);
  if (heartbeat !== "fresh" && heartbeat !== "degraded")
    return refuse("PROTECTIVE_BRIDGE_OFFLINE", { ...detail, heartbeat });
  const caps = conn.capabilities;
  if (!isRecord(caps) || caps.supportsManagementTargetV1 !== true)
    return refuse("PROTECTIVE_HOLD_TERMINAL_UPGRADE_REQUIRED", detail);
  return OK;
}

/** The fresh row is the exact position the agent opened: owner, account, ticket, source, symbol, side, full size. */
export function verifyProtectivePosition(
  execution: ProtectiveExecutionFacts,
  entry: ProtectiveEntryFacts,
  row: ProtectiveRowFacts | null | undefined,
): ProtectiveCheck {
  if (!isRecord(row)) return refuse("PROTECTIVE_IDENTITY_ROW_MISSING", { field: "row" });
  const mismatch = (reason: ProtectiveHoldReason, field: string, expected: unknown, observed: unknown) =>
    refuse(reason, { field, expected, observed, rowId: row.id });
  const user = execution.executingUserId;
  if (!posInt(user) || row.userId !== user || entry.userId !== user)
    return mismatch("PROTECTIVE_IDENTITY_OWNER_MISMATCH", "userId", user, row.userId);
  const accountOf = (a: { bridgeConnectionId: number | null; accountLogin: string | null; brokerServer: string | null }) =>
    `${a.accountLogin ?? "?"}@${a.brokerServer ?? "?"}#${a.bridgeConnectionId ?? "?"}`;
  if (
    !posInt(entry.bridgeConnectionId) ||
    !nonempty(entry.accountLogin) ||
    !nonempty(entry.brokerServer) ||
    row.bridgeConnectionId !== entry.bridgeConnectionId ||
    row.accountLogin !== entry.accountLogin ||
    row.brokerServer !== entry.brokerServer
  )
    return mismatch("PROTECTIVE_IDENTITY_ACCOUNT_MISMATCH", "account", accountOf(entry), accountOf(row));
  if (
    !nonempty(execution.brokerTicket) ||
    row.brokerTicket !== execution.brokerTicket ||
    entry.brokerTicket !== execution.brokerTicket
  )
    return mismatch("PROTECTIVE_IDENTITY_TICKET_MISMATCH", "brokerTicket", execution.brokerTicket, row.brokerTicket);
  if (!nonempty(entry.commandId) || row.sourceCommandId !== entry.commandId)
    return mismatch("PROTECTIVE_IDENTITY_SOURCE_COMMAND_MISMATCH", "sourceCommandId", entry.commandId, row.sourceCommandId);
  if (!nonempty(entry.symbol) || row.symbol !== entry.symbol)
    return mismatch("PROTECTIVE_IDENTITY_SYMBOL_MISMATCH", "symbol", entry.symbol, row.symbol);
  if (!isSide(execution.side) || row.side !== execution.side)
    return mismatch("PROTECTIVE_IDENTITY_SIDE_MISMATCH", "side", execution.side, row.side);
  if (
    !nearVolume(row.volume, execution.intendedVolume) ||
    !nearVolume(entry.requestedVolume, execution.intendedVolume) ||
    !nearVolume(entry.executedVolume, execution.intendedVolume)
  )
    return mismatch("PROTECTIVE_IDENTITY_VOLUME_CHANGED", "volume", execution.intendedVolume, row.volume);
  return OK;
}

// ── Plain-English explanations ───────────────────────────────────────────────

const SECRET_KEY = /token|hash|secret|apikey|api_key|password|credential/i;

/** Drop anything that looks like token material before a detail is logged or audited. */
export function redactProtectiveDetail(detail: unknown): Record<string, unknown> {
  const clean = (v: unknown): unknown => {
    if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString() : null;
    if (Array.isArray(v)) return v.map(clean);
    if (isRecord(v)) {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) if (!SECRET_KEY.test(k)) out[k] = clean(val);
      return out;
    }
    if (typeof v === "number" || typeof v === "string" || typeof v === "boolean" || v === null) return v;
    return v === undefined ? undefined : String(v);
  };
  return isRecord(detail) ? (clean(detail) as Record<string, unknown>) : {};
}

const IDENTITY_TEXT =
  "The broker position no longer matches the one this agent opened ({field}: expected {expected}, observed {observed}). Nothing is sent.";
const BRIDGE_TEXT =
  "The bridge now reports account {login}@{server} ({mode}/{accountType}); the position was opened on {expectedLogin} at {expectedCompany}. Nothing is sent to a different account.";
const GEOMETRY = (problem: string) =>
  `The proposed {action} ({newSl}) would ${problem}; refused. Broker-side stop and take-profit remain active.`;

const TEXT: Record<ProtectiveHoldReason, string> = {
  PROTECTIVE_HOLD_PLATFORM_STOP_ENGAGED:
    "The platform emergency stop is engaged ({sources}). Automatic closes and stop moves are refused by design; use the admin emergency close or the broker terminal. Broker-side stop and take-profit remain active.",
  PROTECTIVE_HOLD_USER_NOT_ARMED:
    "Live trading is not armed for this trader, so no automatic order can be created. Manual close/modify and broker-side stops are unaffected.",
  PROTECTIVE_HOLD_USER_KILL_SWITCH:
    "Your live kill switch is engaged, so no automatic order can be created. Manual close/modify and broker-side stops are unaffected.",
  PROTECTIVE_HOLD_TERMINAL_UPGRADE_REQUIRED:
    "This terminal's EA does not support exact-target management (supportsManagementTargetV1). Upgrade the EA or manage the position manually.",
  PROTECTIVE_HOLD_NO_FRESH_SWEEP:
    "No broker position snapshot newer than {heldAt} arrived within {waitedSec}s (last snapshot {ageSec}s old). ARX will not close or move a stop from old data. Manual controls and the stop held at the broker remain active.",
  PROTECTIVE_HOLD_DEFERRED_TO_NEXT_CYCLE:
    "Stop tightening is not urgent; it will be re-evaluated next cycle from a fresh snapshot. The stop held at the broker remains active.",
  PROTECTIVE_HOLD_TRIGGER_CLEARED:
    "Fresh snapshot: price {p} no longer triggers {trigger} (invalidation {inv}); no action was taken.",
  PROTECTIVE_HOLD_CLAIM_RACE:
    "Another cycle already claimed this position; no duplicate request was made.",
  PROTECTIVE_HOLD_PIPELINE_REFUSED:
    "The live pipeline refused the request before a command existed: {pipelineReason}. Nothing was sent to the broker.",
  PROTECTIVE_HOLD_OUTCOME_UNCERTAIN:
    "The request was handed to the live pipeline but its outcome is not yet proven ({message}); the claim is retained for review and no retry is made.",
  PROTECTIVE_HOLD_INTERNAL_ERROR:
    "The protective path failed safely ({message}); nothing was sent. Manual controls and broker-side stops remain active.",
  PROTECTIVE_BRIDGE_UNVERIFIED:
    "The bridge connection the position was opened on ({expectedBridge}) could not be verified (observed {bridge}). Nothing is sent to a different account.",
  PROTECTIVE_BRIDGE_OWNER_MISMATCH:
    "The bridge connection belongs to another user (owner {owner}, expected {expectedOwner}). Nothing is sent to a different account.",
  PROTECTIVE_BRIDGE_ACCOUNT_MISMATCH: BRIDGE_TEXT,
  PROTECTIVE_BRIDGE_REVOKED:
    "The bridge token for account {login}@{server} is revoked or missing (status {status}); the terminal cannot receive a command. Manual controls at the broker remain available.",
  PROTECTIVE_BRIDGE_NOT_LIVE:
    "The bridge reports {mode}/{accountType}, not a live account; the position was opened on {expectedLogin} at {expectedCompany}. Nothing is sent to a different account.",
  PROTECTIVE_BRIDGE_OFFLINE:
    "The MT5 bridge heartbeat is {ageSec}s old (offline after 60s); it would not pick up a command anyway. Broker-side stops remain active.",
  PROTECTIVE_BRIDGE_HEARTBEAT_NOT_FRESH:
    "The bridge heartbeat is {ageSec}s old; live dispatch requires under 15s. Waiting for the next heartbeat.",
  PROTECTIVE_OBSERVATION_POSITION_CLOSED:
    "The position row is already marked closed or reconciled; there is nothing to protect.",
  PROTECTIVE_OBSERVATION_TIMESTAMP_INVALID:
    "The latest snapshot has no usable time ({detail}); it cannot prove the position's current state.",
  PROTECTIVE_OBSERVATION_FUTURE_DATED:
    "The latest snapshot is dated {ms}ms ahead of the server; it cannot prove the position's current state.",
  PROTECTIVE_OBSERVATION_STALE:
    "The latest snapshot is {ageMs}ms old; it cannot prove the position's current state.",
  PROTECTIVE_OBSERVATION_NOT_FROM_SWEEP:
    "The position row was last written by a reconciler, not by a complete terminal snapshot; it is not broker evidence.",
  PROTECTIVE_POSITION_ABSENT_AT_BROKER:
    "The latest complete broker snapshot did not list ticket {ticket} (absent {count} sweep(s) since {firstAbsentAt}). It may already be closed at the broker; reconciliation will confirm. No order was sent.",
  PROTECTIVE_OBSERVATION_NOT_NEWER:
    "The snapshot ({observedAt}) is not newer than the hold at {heldAt}; ARX will not act on the evidence it already refused.",
  PROTECTIVE_OBSERVATION_PREDATES_COMMAND:
    "A close/modify was sent to the terminal at {eventAt}; the snapshot ({observedAt}) predates it, so the stop or size may already differ.",
  PROTECTIVE_SWEEP_MARKER_STALE:
    "The terminal's complete-snapshot marker is {ageMs}ms old or older than the row; the row cannot be trusted as part of a full sweep.",
  PROTECTIVE_OBSERVATION_PRICE_INVALID:
    "The snapshot carries an unusable price or volume ({detail}); nothing is sent.",
  PROTECTIVE_IDENTITY_ROW_MISSING:
    "The exact position row (ticket {ticket} on the opening account) is no longer present; nothing is sent.",
  PROTECTIVE_IDENTITY_OWNER_MISMATCH: IDENTITY_TEXT,
  PROTECTIVE_IDENTITY_ACCOUNT_MISMATCH: IDENTITY_TEXT,
  PROTECTIVE_IDENTITY_TICKET_MISMATCH: IDENTITY_TEXT,
  PROTECTIVE_IDENTITY_SOURCE_COMMAND_MISMATCH: IDENTITY_TEXT,
  PROTECTIVE_IDENTITY_SYMBOL_MISMATCH: IDENTITY_TEXT,
  PROTECTIVE_IDENTITY_SIDE_MISMATCH: IDENTITY_TEXT,
  PROTECTIVE_IDENTITY_VOLUME_CHANGED:
    "Position size is {observed} lots; the agent opened {expected}. A partial change happened outside this agent; automatic management is held for review.",
  PROTECTIVE_GEOMETRY_INVALID:
    "The proposed action could not be verified ({problem}); refused. Broker-side stop and take-profit remain active.",
  PROTECTIVE_SIDE_MISMATCH: GEOMETRY("act on the wrong side of the position"),
  PROTECTIVE_WOULD_REVERSE: GEOMETRY("exceed the open volume and reverse the position"),
  PROTECTIVE_PARTIAL_NOT_SUPPORTED: GEOMETRY("reduce size (no autonomous partial path)"),
  PROTECTIVE_STOP_NOT_TIGHTER: GEOMETRY("loosen or not tighten the stop"),
  PROTECTIVE_STOP_THROUGH_PRICE: GEOMETRY("place the stop at or through price {p}"),
  PROTECTIVE_TAKE_PROFIT_CHANGED: GEOMETRY("change the take-profit"),
  MANAGEMENT_PAUSED_AACI_REVIEW:
    "Management for this agent is paused until the AACI chain review clears. Manual controls and broker-side stops remain active.",
};

function render(value: unknown): string {
  if (value == null || value === "") return "unknown";
  if (Array.isArray(value)) return value.length ? value.map(render).join(", ") : "unknown";
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : "unknown";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "unknown";
  if (typeof value === "object") return "unknown";
  return String(value);
}

/** Operator-facing text. Placeholders come from the (redacted) detail; a missing value reads "unknown". */
export function explainProtectiveHold(
  reason: ProtectiveHoldReason | string,
  detail: Record<string, unknown> | null | undefined,
): string {
  const safe = redactProtectiveDetail(detail);
  if (safe.ageSec == null && typeof safe.ageMs === "number") safe.ageSec = Math.round(safe.ageMs / 1000);
  if (safe.waitedSec == null && typeof safe.waitedMs === "number") safe.waitedSec = Math.round(safe.waitedMs / 1000);
  const template =
    (TEXT as Record<string, string>)[reason] ??
    `Automatic protective management is held (${String(reason)}); nothing was sent. Manual controls and broker-side stops remain active.`;
  return template.replace(/\{([a-zA-Z]+)\}/g, (_m, key: string) => render(safe[key]));
}
