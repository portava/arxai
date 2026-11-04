// Ruby command ledger + dispatch wrapper (moved out of routes/meAssistant.ts on
// 2026-11-04 so the watch evaluator can run from a worker as well as the route).
// There is NO second execution path: recordAndExecuteRuby only WRAPS
// submitInstantTrade (→ executeInstant) with idempotency + evidence + an
// advisory handshake. Every gate of the instant-trade pipeline still runs.

import { db, rubyCommandsTable, type RubyCommandKind } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { InstantTradeIntent, InstantTradeResult } from "../live/instantTrade.js";
import { submitInstantTrade } from "../tradeEngine/pipeline.js";
import { runHandshake } from "../handshake/coordinator.js";
import { isUniqueViolation } from "../pgError.js";
import { routeQuote } from "../data/marketDataRouter.js";
import { readMt5Quote } from "../data/providers/mt5Provider.js";
import { boundQuotePrice } from "./boundQuote.js";

export const MAX_ACTIVE_RUBY_WATCHES = 10;
// Watch-and-enter "late" tolerance: if the trigger level is reached but price
// has already run beyond it by more than this fraction, the setup has moved on
// and the watch is skipped rather than chasing a worse fill.
export const LATE_ENTRY_TOLERANCE = 0.003;

// Current price for a symbol from the feed-scoped quote router (read-only).
// The price must be a producer-observed tick no older than
// BOUND_QUOTE_MAX_AGE_MS; a stale, unobserved or missing quote returns null and
// the caller must refuse rather than act on it.
export async function currentPriceOf(symbol: string): Promise<number | null> {
  try {
    const q = await routeQuote(symbol);
    return boundQuotePrice(q).price;
  } catch { return null; }
}

// The price a watch may ACT on (sweep 2026-11-04): only a fresh observed tick
// from the watch owner's OWN bridge. The quote is pinned to that writer (no
// platform-wide MT5 fallback, no third-party provider) and its provenance must
// name the same bridge. No own bridge, or no own-bridge tick → null: the
// evaluator does nothing this cycle rather than close on someone else's price.
export async function ownBridgePriceOf(symbol: string, bridgeConnectionId: number | null): Promise<number | null> {
  if (bridgeConnectionId == null) return null;
  try {
    // Bridge-scoped store read (this line's pinned read): only this bridge's own
    // partition is served, never another bridge's or the unattributed one.
    const r = readMt5Quote(symbol, { bridgeConnectionId });
    if (!r.quote || r.bridgeConnectionId !== bridgeConnectionId) return null;
    const q = r.quote;
    const p = q.bid != null && q.ask != null ? (q.bid + q.ask) / 2 : q.last ?? q.bid ?? q.ask ?? null;
    return typeof p === "number" && Number.isFinite(p) && p > 0 ? p : null;
  } catch { return null; }
}

export { rubyWatchPermissionBlock, type RubyWatchPermissionBlock } from "./rubyWatchPermissions.js";

// Build a dedupe fingerprint for a Ruby command. Two semantically-identical
// commands (same kind/symbol/side/size/level) produce the same fingerprint, so
// the partial-unique in-flight index refuses an accidental repeat while the
// first is still PENDING/EXECUTING.
export function rubyFingerprint(commandKind: string, intent: InstantTradeIntent): string {
  return [
    commandKind,
    (intent.symbol ?? "").toUpperCase(),
    intent.action,
    intent.volume ?? "",
    intent.positionId ?? "",
    intent.newStopLoss ?? "",
    intent.newTakeProfit ?? "",
    intent.closeVolume ?? "",
  ].join("|");
}

export type RubyLedgerOutcome =
  | { duplicate: true }
  | { duplicate: false; commandRowId: number; result: InstantTradeResult; handshakeStatus: string };

// Record a Ruby command in the ledger, run the advisory RUBY_EXECUTION
// handshake, dispatch through the EXISTING instant-trade router, and link the
// outcome back onto the ledger row.
export async function recordAndExecuteRuby(args: {
  userId: number;
  intent: InstantTradeIntent;
  commandKind: RubyCommandKind;
  symbol: string | null;
  rawText: string;
  ip: string | null;
  ua: string | null;
  params: unknown;
}): Promise<RubyLedgerOutcome> {
  const { userId, intent, commandKind, symbol, rawText, ip, ua, params } = args;
  const fingerprint = rubyFingerprint(commandKind, intent);
  const idempotencyKey = randomUUID();
  // OPEN rows carry action "OPEN_TRADE" so the per-Ruby daily-trade cap (which
  // counts OPEN_TRADE rows) sees them; other kinds store the live action.
  const ledgerAction = commandKind === "OPEN_TRADE" ? "OPEN_TRADE" : intent.action;

  let commandRowId: number;
  try {
    const [row] = await db.insert(rubyCommandsTable).values({
      userId,
      accountMode: intent.accountMode,
      source: intent.source,
      commandKind,
      symbol: symbol ?? null,
      action: ledgerAction,
      params: params != null ? JSON.stringify(params) : null,
      rawUserCommand: rawText,
      fingerprint,
      idempotencyKey,
      status: "PENDING",
    }).returning({ id: rubyCommandsTable.id });
    commandRowId = row!.id;
  } catch (err) {
    // 23505 = unique violation on the in-flight partial index → a matching
    // command is already pending. Refuse the duplicate honestly.
    if (isUniqueViolation(err)) return { duplicate: true };
    throw err;
  }

  // Advisory cross-layer readiness check. Fails open to UNKNOWN; NEVER a gate.
  let handshakeStatus = "UNKNOWN";
  try {
    const hs = await runHandshake("RUBY_EXECUTION", { context: { userId } });
    handshakeStatus = hs.aggregateStatus;
  } catch { /* advisory only */ }

  await db.update(rubyCommandsTable)
    .set({ status: "EXECUTING", handshakeStatus, updatedAt: new Date() })
    .where(eq(rubyCommandsTable.id, commandRowId));

  const result = await submitInstantTrade({ userId, intent, ip, ua });

  if (result.ok) {
    await db.update(rubyCommandsTable).set({
      status: "COMPLETED",
      liveCommandId: result.commandId ?? null,
      resultDetail: result.detail != null ? JSON.stringify(result.detail).slice(0, 2000) : null,
      updatedAt: new Date(),
    }).where(eq(rubyCommandsTable.id, commandRowId));
  } else {
    // A gate refusal (httpStatus < 500) is BLOCKED evidence; a server/pipeline
    // error is FAILED. Both keep the row as permanent evidence.
    const blocked = result.httpStatus < 500;
    await db.update(rubyCommandsTable).set({
      status: blocked ? "BLOCKED" : "FAILED",
      blockReason: blocked ? (result.primaryReason ?? result.error) : null,
      errorReason: blocked ? null : result.error,
      updatedAt: new Date(),
    }).where(eq(rubyCommandsTable.id, commandRowId));
  }

  return { duplicate: false, commandRowId, result, handshakeStatus };
}
