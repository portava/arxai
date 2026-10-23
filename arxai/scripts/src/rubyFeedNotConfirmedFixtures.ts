// Shared fixtures + gate-drift preflight for rubyFeedNotConfirmedTest (Task #815).
//
// WHY THIS EXISTS
// The Eleanor/Ruby "feed not confirmed" suite depends on two live-data honesty
// gates that get TIGHTENED over time. When a gate change invalidates a suite
// fixture, the downstream behaviour assertions fail with confusing symptoms
// ("context missing", "feedConfirmed undefined") instead of naming the gate —
// which is exactly how Task #814's suite silently went 14/33 red. The two gates:
//
//   1. ARX Focus lock (`isApprovedArxMarket`) — getMarketSnapshot only snapshots
//      APPROVED markets; an unapproved symbol is blocked BEFORE the shared
//      resolver runs. The suite therefore needs its VERIFIED_SYMBOL to stay
//      APPROVED (else the "confirmed feed" case is blocked) and its
//      NO_FEED_SYMBOL to stay UNAPPROVED (else the "not confirmed" case changes
//      shape).
//   2. Live-Position Truth gate (`classifyTradeKey` → `resolvePositionTruth`) —
//      getTradeMarketContextTool withholds ALL context (ok:false, NO `context`)
//      for any open position that is not FULLY verified-live. The suite's
//      synthetic trade row must satisfy EVERY field the gate requires (broker
//      ticket, valid side, volume, entry, current price, P/L source, account
//      source, a FRESH `lastSyncedAt`, attribution) or the trade-ctx feed
//      assertions cannot run.
//
// This module (a) constructs the verified-live position fixture in ONE place, so
// a new field requirement is satisfied once — not in scattered inline inserts —
// and (b) exposes preflights that turn silent breakage into a LOUD, gate-named
// `GateDriftError`: it says exactly which gate rejected which fixture and why, so
// the next engineer updates the fixture here rather than debugging a cascade.
//
// SAFETY: the preflights PROVE the fixture against the REAL gate; they never
// weaken it. The honest fix for a red preflight is a correct fixture, never a
// relaxed gate.

import { db } from "@workspace/db";
import { livePositionsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { isApprovedArxMarket } from "@workspace/domain/market";
import { classifyTradeKey } from "../../artifacts/api-server/src/lib/live/positionTruthAdapter.js";

/**
 * Thrown when a live-data honesty gate change has invalidated a suite fixture.
 * The message ALWAYS names the offending gate + fixture + the honest fix, so the
 * failure points straight at the cause instead of a confusing downstream
 * symptom.
 */
export class GateDriftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GateDriftError";
  }
}

export interface VerifiedLivePositionFixture {
  userId: number;
  positionId: number;
  /** The "lp_<id>" key the assistant tools resolve. */
  tradeKey: string;
  /** Remove the synthetic row. ALWAYS call in a finally. */
  cleanup: () => Promise<void>;
}

/**
 * Insert a synthetic open position that is GENUINELY verified-live — it passes
 * `resolvePositionTruth`'s `verified_live_position` path legitimately; the gate
 * is NOT weakened. Every field the truth gate requires is set HERE, in one
 * place, so a new field requirement is satisfied once. Call
 * `assertFixtureIsVerifiedLive` afterwards to PROVE it against the live gate.
 */
export async function insertVerifiedLivePosition(opts: {
  userId: number;
  symbol: string;
}): Promise<VerifiedLivePositionFixture> {
  const [inserted] = await db
    .insert(livePositionsTable)
    .values({
      userId: opts.userId,
      // Broker ticket present ⇒ broker-confirmed (hasTicket) + a known account source.
      brokerPositionId: `feedtest-${Date.now()}`,
      symbol: opts.symbol,
      direction: "BUY", // valid side ("BUY"/"SELL")
      lotSize: 0.01, // volume > 0
      entryPrice: 1.1, // entry present
      currentPrice: 1.1005, // current price present (also lets P/L be derived)
      stopLoss: 1.095,
      takeProfit: 1.11,
      status: "OPEN", // non-terminal ⇒ not closed
      // FRESH lastSyncedAt (within positionFreshness STALE_MS = 90s) ⇒ freshness
      // FRESH. This is the field MOST likely to be invalidated by a tightened
      // freshness gate — a null/old value ⇒ MISSING/STALE ⇒ advice withheld.
      lastSyncedAt: new Date(),
    })
    .returning({ id: livePositionsTable.id });
  const positionId = inserted!.id;
  return {
    userId: opts.userId,
    positionId,
    tradeKey: `lp_${positionId}`,
    cleanup: async () => {
      await db.delete(livePositionsTable).where(eq(livePositionsTable.id, positionId));
    },
  };
}

/**
 * Insert a synthetic open position that is GENUINELY NOT verified-live — a
 * `live_positions` row with NO broker ticket, so `resolvePositionTruth`
 * classifies it `unsynced_unknown` (isVerifiedLive:false) via the real gate; the
 * gate is NOT weakened. This drives getTradeMarketContextTool's WITHHELD branch
 * (Task #816) — the tool must still hand Eleanor the honest feed shape (flat +
 * nested `context`) rather than a blank reply. Call
 * `assertFixtureIsNotVerifiedLive` afterwards to PROVE the withheld state
 * against the live gate before asserting on the tool output.
 */
export async function insertUnverifiedLivePosition(opts: {
  userId: number;
  symbol: string;
}): Promise<VerifiedLivePositionFixture> {
  const [inserted] = await db
    .insert(livePositionsTable)
    .values({
      userId: opts.userId,
      // NO broker ticket ⇒ not broker-confirmed ⇒ unsynced_unknown ⇒ advice
      // withheld. This is the honest way to reach the withheld branch without
      // weakening the truth gate.
      brokerPositionId: null,
      symbol: opts.symbol,
      direction: "BUY",
      lotSize: 0.01,
      entryPrice: 1.1,
      currentPrice: 1.1005,
      stopLoss: 1.095,
      takeProfit: 1.11,
      status: "OPEN",
      lastSyncedAt: new Date(),
    })
    .returning({ id: livePositionsTable.id });
  const positionId = inserted!.id;
  return {
    userId: opts.userId,
    positionId,
    tradeKey: `lp_${positionId}`,
    cleanup: async () => {
      await db.delete(livePositionsTable).where(eq(livePositionsTable.id, positionId));
    },
  };
}

/**
 * PREFLIGHT — prove the synthetic fixture actually satisfies the Live-Position
 * Truth gate RIGHT NOW, via the SAME classifier the assistant tool uses. If a
 * gate change means the fixture no longer classifies as verified-live, throw a
 * `GateDriftError` naming the category + missing fields BEFORE the behavioural
 * assertions run — so the failure points at the gate, not at a confusing
 * "context missing" downstream symptom.
 */
export async function assertFixtureIsVerifiedLive(
  fx: VerifiedLivePositionFixture,
): Promise<void> {
  const verdict = await classifyTradeKey(fx.userId, fx.tradeKey);
  if (!verdict) {
    throw new GateDriftError(
      `Live-Position Truth gate drift: classifyTradeKey("${fx.tradeKey}") returned ` +
        `null (row not found / not owned) for the synthetic verified-live fixture, so ` +
        `getTradeMarketContextTool would answer "trade_not_found" and the trade-ctx ` +
        `feed assertions cannot run. Check classifyTradeKey key parsing / user scoping ` +
        `in positionTruthAdapter.ts, or the insert in insertVerifiedLivePosition().`,
    );
  }
  if (!verdict.isVerifiedLive) {
    throw new GateDriftError(
      `Live-Position Truth gate drift: the synthetic open position no longer ` +
        `classifies as verified-live (category="${verdict.category}", badge=` +
        `"${verdict.badge}", missingFields=[${verdict.missingFields.join(", ")}]). ` +
        `A tightened honesty gate rejected the fixture, so getTradeMarketContextTool ` +
        `would withhold ALL context (ok:false, no "context") and the trade-ctx feed ` +
        `assertions would fail confusingly. Update insertVerifiedLivePosition() in ` +
        `scripts/src/rubyFeedNotConfirmedFixtures.ts to satisfy the new requirement — ` +
        `do NOT weaken the gate.`,
    );
  }
}

/**
 * PREFLIGHT — prove the synthetic WITHHELD fixture is genuinely NOT verified-live
 * RIGHT NOW, via the SAME classifier the assistant tool uses. The withheld-branch
 * feed assertions (Task #816) only mean something if the row actually reaches the
 * withheld path: classifyTradeKey must return a NON-null verdict (so the tool
 * takes the `!isVerifiedLive` withhold branch, not `trade_not_found`) AND
 * isVerifiedLive must be false (so it is not the success branch). A drift on
 * either side throws a `GateDriftError` naming the cause BEFORE the behavioural
 * assertions run.
 */
export async function assertFixtureIsNotVerifiedLive(
  fx: VerifiedLivePositionFixture,
): Promise<void> {
  const verdict = await classifyTradeKey(fx.userId, fx.tradeKey);
  if (!verdict) {
    throw new GateDriftError(
      `Live-Position Truth gate drift: classifyTradeKey("${fx.tradeKey}") returned ` +
        `null for the synthetic UNVERIFIED fixture, so getTradeMarketContextTool would ` +
        `answer "trade_not_found_or_not_yours" (a DIFFERENT block branch) instead of the ` +
        `withheld branch under test. Check classifyTradeKey key parsing / user scoping in ` +
        `positionTruthAdapter.ts, or the insert in insertUnverifiedLivePosition().`,
    );
  }
  if (verdict.isVerifiedLive) {
    throw new GateDriftError(
      `Live-Position Truth gate drift: the synthetic UNVERIFIED open position now ` +
        `classifies as verified-live (category="${verdict.category}", badge=` +
        `"${verdict.badge}"). It was meant to reach getTradeMarketContextTool's WITHHELD ` +
        `branch, but a relaxed gate promoted it to the success branch, so the withheld ` +
        `feed-shape assertions cannot run. Update insertUnverifiedLivePosition() in ` +
        `scripts/src/rubyFeedNotConfirmedFixtures.ts so the row stays genuinely ` +
        `unverified (e.g. keep the broker ticket absent) — do NOT weaken the gate.`,
    );
  }
}

/**
 * PREFLIGHT — prove the two symbols the suite relies on still sit on the correct
 * side of the ARX Focus lock. getMarketSnapshot blocks unapproved markets before
 * the shared resolver runs, so:
 *   - `verifiedSymbol` must be APPROVED   (else the "confirmed feed" case blocks)
 *   - `noFeedSymbol`   must be UNAPPROVED (else the "not confirmed" case changes shape)
 * Throws a `GateDriftError` naming the symbol + expectation when either drifts.
 */
export function assertArxFocusFixtureSymbols(opts: {
  verifiedSymbol: string;
  noFeedSymbol: string;
}): void {
  if (!isApprovedArxMarket(opts.verifiedSymbol)) {
    throw new GateDriftError(
      `ARX Focus gate drift: VERIFIED_SYMBOL "${opts.verifiedSymbol}" is no longer in ` +
        `the approved ARX Focus universe, so getMarketSnapshot will BLOCK it and report ` +
        `feed-not-confirmed even with a clean pushed window — the "confirmed snapshot" ` +
        `assertions would fail. Pick an approved market for VERIFIED_SYMBOL (see ` +
        `lib/domain/src/market/arxFocusMarkets.ts).`,
    );
  }
  if (isApprovedArxMarket(opts.noFeedSymbol)) {
    throw new GateDriftError(
      `ARX Focus gate drift: NO_FEED_SYMBOL "${opts.noFeedSymbol}" is now IN the ` +
        `approved ARX Focus universe, so getMarketSnapshot will route it through the ` +
        `shared resolver instead of the honest off-universe block — the "not confirmed" ` +
        `snapshot assertions may change shape. Pick a symbol that is NOT an approved ARX ` +
        `market for NO_FEED_SYMBOL.`,
    );
  }
}
