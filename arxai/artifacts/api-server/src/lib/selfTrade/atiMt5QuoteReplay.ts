import { atiInstrumentConflict } from "../data/atiBrokerInstrument.js";
import { createHash } from "node:crypto";
import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import { bridgeV2EventsTable as events, db } from "@workspace/db";
import { executableForecastPaperOrder, type ForecastPaperGrade, type ForecastPaperInstruction } from "@workspace/domain/structural";
import { z } from "zod/v4";
import type { AtiMt5QuoteOrigin } from "../data/atiMt5QuoteOrigin.js";
import { QUOTE_FRESH_TTL_MS } from "../data/freshness.js";
import { normalizeSymbolKey } from "../data/providers/mt5Provider.js";
import { crossedPaperLevel, paperExitQuote, recordBracketSample, retestQuoteDecision, startSampledBracketPath,
  type ReplaySampleObserver, type EntryReplayPolicy, type ObservedNoFill, type SampledBracketPath } from "../tradeEngine/paperLevels.js";

const tickFields = z.object({
  symbol: z.string(), brokerSymbol: z.string(),
  bid: z.number().positive(), ask: z.number().positive(), brokerTimeEpochMs: z.number().int().positive(),
  atiAccountBinding: z.string(), atiHistoryIdentity: z.string(), atiAccountMode: z.enum(["LIVE", "DEMO"]),
});

export type AtiMt5ReplayQuote = { bid: number; ask: number; observedAt: string };
export type AtiMt5ReplayWitness = {
  source: "SAMPLED_MT5_BID_ASK";
  mode: "LIVE" | "DEMO";
  decisionReceiptId: number;
  entryReceiptId: number;
  exitReceiptId: number;
  entryObservedAt: number;
  samples: number;
  tapeHash: string;
};

type Row = {
  id: number; sequence: number; verdict: string; capturedAt: number | null; receivedAt: number | null; payload: unknown;
};

export async function loadAtiMt5ReplayQuotes(ownerId: number, origin: AtiMt5QuoteOrigin, firstDecisionAt: number, through: number) {
  return db.select({ id: events.id, sequence: events.sequence, verdict: events.sequenceVerdict,
    capturedAt: events.eaCreatedAtEpochMs, receivedAt: events.serverReceivedAtEpochMs, payload: events.payload,
  }).from(events).where(and(
    eq(events.userId, ownerId), eq(events.bridgeConnectionId, origin.bridgeConnectionId),
    eq(events.streamKey, origin.streamKey), eq(events.protocolVersion, 2), sql`${events.messageType} = 'TICK' AND ${events.accepted}`,
    gte(events.serverReceivedAtEpochMs, firstDecisionAt - 2 * QUOTE_FRESH_TTL_MS),
    lte(events.serverReceivedAtEpochMs, through),
  )).orderBy(asc(events.id));
}

function readTick(row: Row, origin: AtiMt5QuoteOrigin, symbol: string) {
  const result = tickFields.safeParse(row.payload);
  if (!result.success || row.capturedAt == null || row.receivedAt == null || row.capturedAt <= 0 ||
      row.capturedAt > row.receivedAt || row.receivedAt - row.capturedAt > QUOTE_FRESH_TTL_MS) return null;
  const tick = result.data;
  if (normalizeSymbolKey(tick.symbol) !== symbol || tick.brokerSymbol !== origin.brokerSymbol ||
      tick.atiAccountBinding !== origin.accountBinding || tick.atiHistoryIdentity !== origin.historyIdentity ||
      tick.atiAccountMode !== origin.mode || tick.ask < tick.bid) return null;
  return { ...tick, id: row.id, sequence: row.sequence, verdict: row.verdict,
    capturedAt: row.capturedAt, receivedAt: row.receivedAt };
}
type Tick = NonNullable<ReturnType<typeof readTick>>;

function continues(previous: Tick, next: Tick) {
  return next.verdict === "IN_ORDER" && next.sequence === previous.sequence + 1 &&
    next.capturedAt >= previous.capturedAt && next.capturedAt - previous.capturedAt <= QUOTE_FRESH_TTL_MS &&
    next.receivedAt >= previous.receivedAt && next.receivedAt - previous.receivedAt <= QUOTE_FRESH_TTL_MS &&
    next.brokerTimeEpochMs >= previous.brokerTimeEpochMs;
}

function repeats(previous: Tick, next: Tick) {
  return previous.brokerTimeEpochMs === next.brokerTimeEpochMs && previous.bid === next.bid && previous.ask === next.ask;
}

function tapeFrame(tick: Tick) {
  return JSON.stringify([tick.id, tick.sequence, tick.verdict, tick.capturedAt, tick.receivedAt, tick.brokerTimeEpochMs, tick.bid, tick.ask]);
}

/** Returns the first bracket crossing on an unbroken path of observed samples.
 * Compare UTC receipt/capture stamps with the decision. Broker clocks only
 * order broker ticks; no offset, intrainterval price or fill is inferred. */
export function gradeAtiMt5Replay(rows: readonly Row[], origin: AtiMt5QuoteOrigin, quote: AtiMt5ReplayQuote | null,
  symbol: string, plan: ForecastPaperInstruction & { action: "BUY" | "SELL" }, decisionAt: number, asOf: number, expiresAt: number,
  entryPolicy?: EntryReplayPolicy, onSample?: ReplaySampleObserver): ForecastPaperGrade & { replay?: AtiMt5ReplayWitness; path?: SampledBracketPath; noFill?: ObservedNoFill } {
  const unverified = { state: "UNVERIFIED" as const };
  const key = normalizeSymbolKey(symbol);
  const index = rows.findIndex((row) => row.id === origin.receiptId);
  if (index < 1 || !quote || atiInstrumentConflict(symbol, origin.brokerSymbol)) return unverified;
  const anchor = readTick(rows[index]!, origin, key);
  const before = readTick(rows[index - 1]!, origin, key);
  if (!anchor || !before || !continues(before, anchor) || repeats(before, anchor) ||
      anchor.bid !== quote.bid || anchor.ask !== quote.ask || anchor.capturedAt !== Date.parse(quote.observedAt) ||
      anchor.brokerTimeEpochMs !== origin.brokerTickAtMs || anchor.receivedAt > decisionAt ||
      decisionAt - anchor.capturedAt > QUOTE_FRESH_TTL_MS) return unverified;

  const entryDeadline = entryPolicy?.band ? expiresAt : Math.min(decisionAt + QUOTE_FRESH_TTL_MS, expiresAt);
  let previous = anchor;
  let path: SampledBracketPath | null = null;
  const tape = createHash("sha256").update(tapeFrame(before)).update(tapeFrame(anchor));
  for (let i = index + 1; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.receivedAt != null && row.receivedAt > asOf) break;
    const tick = readTick(row, origin, key);
    if (!tick || !continues(previous, tick)) return unverified;
    tape.update(tapeFrame(tick));
    const repeated = repeats(previous, tick);
    previous = tick;
    if (repeated || tick.capturedAt <= decisionAt || tick.receivedAt <= decisionAt) continue;
    if (!path) {
      const skip = (reason: ObservedNoFill["reason"]) => ({ state: "SKIPPED" as const,
        ...(entryPolicy ? { noFill: { reason, atMs: tick.receivedAt, tapeHash: tape.digest("hex") } } : {}) });
      if (entryPolicy?.band) {
        if (tick.receivedAt >= entryDeadline) return skip("ENTRY_WINDOW_EXPIRED");
        const retest = retestQuoteDecision(plan, entryPolicy.band, tick, entryPolicy.maximumSpreadFractionOfStop);
        if (retest === "BRACKET_INVALIDATED") return skip(retest);
        if (retest === "WAIT" || !executableForecastPaperOrder(plan, tick.bid, tick.ask)) continue;
      } else if (tick.receivedAt > entryDeadline || !executableForecastPaperOrder(plan, tick.bid, tick.ask)) {
        return skip(tick.receivedAt > entryDeadline ? "ENTRY_WINDOW_EXPIRED" : "FIRST_QUOTE_NOT_EXECUTABLE");
      }
      path = startSampledBracketPath({ price: plan.action === "BUY" ? tick.ask : tick.bid, atMs: tick.receivedAt, receiptId: tick.id });
    }
    const mark = paperExitQuote(plan.action, tick);
    onSample?.(path.entry.price, mark, tick.receivedAt, tape.copy().digest("hex"));
    recordBracketSample(path, plan.action, { price: mark, atMs: tick.receivedAt, receiptId: tick.id });
    const level = crossedPaperLevel({ direction: plan.action, stopLoss: plan.stop, takeProfit: plan.target }, mark);
    if (level) return {
      state: level.hit === "TP" ? "TARGET" : "STOP", entry: path.entry.price, exit: mark, observedAt: tick.receivedAt, path,
      replay: { source: "SAMPLED_MT5_BID_ASK", mode: origin.mode, decisionReceiptId: anchor.id,
        entryReceiptId: path.entry.receiptId!, exitReceiptId: tick.id, entryObservedAt: path.entry.atMs, samples: path.samples,
        tapeHash: tape.digest("hex") },
    };
  }
  if (asOf - previous.receivedAt > QUOTE_FRESH_TTL_MS) return unverified;
  if (path) return { state: "OPEN", entry: path.entry.price, ...(entryPolicy ? { path } : {}) };
  if (entryPolicy) return { state: "PENDING" };
  return { state: asOf >= entryDeadline ? "SKIPPED" : "PENDING" };
}
