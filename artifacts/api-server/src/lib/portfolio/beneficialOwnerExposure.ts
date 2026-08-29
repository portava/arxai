// ═══════════════════════════════════════════════════════════════════════════
// Capability #22 adapter — reads every per-user account snapshot source that
// exists today and feeds the pure beneficial-owner exposure engine:
//
//   • mt5_connection   — one row per connected MT5 account (demo AND live):
//                        broker, currency, balance/equity, snapshot age
//   • trades           — OPEN rows (system-of-record for demo + live orders)
//   • live_positions   — broker-mirror rows (deduped against trades via tradeId)
//
// Paper trading is intentionally NOT an economic exposure source (paper fills
// move no money); it is listed in the coverage notes, not the graph.
//
// HONESTY: each source is read in its own try/catch. A failed read becomes a
// typed UNAVAILABLE account / coverage gap — never an empty-but-"complete"
// graph and never a synthesized balance.
// ═══════════════════════════════════════════════════════════════════════════

import { and, eq } from "drizzle-orm";
import {
  db, tradesTable, livePositionsTable, mt5ConnectionTable,
} from "@workspace/db";
import {
  buildBeneficialOwnerExposureGraph,
  type AccountSnapshotInput,
  type OwnedPositionInput,
  type BeneficialOwnerExposureGraph,
} from "@workspace/domain/portfolio-manager";
import { resolveArxMarket } from "@workspace/domain/market";

const STALE_SNAPSHOT_MS = 15 * 60 * 1000; // 15 minutes without an account sync

export async function readBeneficialOwnerExposure(
  userId: number,
): Promise<BeneficialOwnerExposureGraph> {
  const accounts: AccountSnapshotInput[] = [];
  const positions: OwnedPositionInput[] = [];
  const sourcesRead: string[] = [];
  const now = Date.now();

  // ── Source 1: MT5 connections (multi-account: every row is an account). ──
  try {
    const rows = await db.select().from(mt5ConnectionTable)
      .where(eq(mt5ConnectionTable.userId, userId));
    sourcesRead.push("mt5_connection");
    for (const r of rows) {
      const accountKey = `mt5:${r.accountNumber ?? `conn-${r.id}`}`;
      const syncedAt = r.accountSyncedAt ? new Date(r.accountSyncedAt).getTime() : null;
      const isStale = syncedAt === null || now - syncedAt > STALE_SNAPSHOT_MS;
      accounts.push({
        accountKey,
        venue: "mt5",
        broker: r.brokerName ?? null,
        currency: r.accountCurrency ?? null,
        // Never report a fabricated figure: no sync yet → null, not 0.
        balance: syncedAt !== null ? r.accountBalance ?? null : null,
        equity: syncedAt !== null ? r.accountEquity ?? null : null,
        accountType: r.accountType ?? null,
        snapshotAtIso: syncedAt !== null ? new Date(syncedAt).toISOString() : null,
        status: isStale ? "STALE" : "OK",
        statusReason: isStale
          ? (syncedAt === null
            ? "no account sync has ever landed for this bridge"
            : `last account sync ${Math.round((now - syncedAt) / 1000)}s ago (> ${STALE_SNAPSHOT_MS / 1000}s)`)
          : undefined,
      });
    }
    if (rows.length === 0) {
      // No MT5 account connected is a fact, not a failure — recorded via
      // sourcesRead with zero accounts.
    }
  } catch (err) {
    accounts.push({
      accountKey: "mt5:*", venue: "mt5",
      balance: null, equity: null,
      status: "UNAVAILABLE",
      statusReason: `READ_FAILED: mt5_connection — ${(err as Error).message}`,
    });
  }

  // ── Source 2: open trades (demo + live order system-of-record). ──
  const mt5AccountKeyForMode = (mode: string): string | null => {
    // Attribute a trade to the user's MT5 account matching its mode when the
    // attribution is unambiguous; otherwise honestly unattributed.
    const want = mode === "LIVE" ? ["live", "real"] : ["demo"];
    const matches = accounts.filter(
      (a) => a.venue === "mt5" && a.status !== "UNAVAILABLE"
        && want.includes((a.accountType ?? "").toLowerCase()));
    return matches.length === 1 ? matches[0]!.accountKey : null;
  };
  try {
    const rows = await db.select().from(tradesTable)
      .where(and(eq(tradesTable.userId, userId), eq(tradesTable.status, "OPEN")));
    sourcesRead.push("trades");
    for (const t of rows) {
      positions.push({
        sourceId: String(t.id),
        source: "trades",
        accountKey: mt5AccountKeyForMode(t.mode),
        venue: "mt5",
        symbol: t.symbol,
        direction: t.direction === "SELL" ? "SELL" : "BUY",
        lots: t.lot,
        riskAmount: null, // trades stores price-based stops, not a currency risk basis
        unrealizedPnl: t.pnl ?? null,
        dedupeKey: `trade:${t.id}`,
      });
    }
  } catch (err) {
    accounts.push({
      accountKey: "trades:*", venue: "mt5",
      balance: null, equity: null,
      status: "UNAVAILABLE",
      statusReason: `READ_FAILED: trades — ${(err as Error).message}`,
    });
  }

  // ── Source 3: live_positions (broker mirror; dedupe against trades). ──
  try {
    const rows = await db.select().from(livePositionsTable)
      .where(eq(livePositionsTable.userId, userId));
    sourcesRead.push("live_positions");
    for (const p of rows) {
      const stillOpen = p.status === "OPEN" || p.status === "PARTIALLY_CLOSED" || p.status === "SYNC_PENDING";
      if (!stillOpen) continue;
      positions.push({
        sourceId: String(p.id),
        source: "live_positions",
        accountKey: null,
        venue: "mt5",
        symbol: p.symbol,
        direction: p.direction === "SELL" ? "SELL" : "BUY",
        lots: p.lotSize,
        riskAmount: null,
        unrealizedPnl: p.unrealizedProfitLoss ?? null,
        // Mirrors the trades row when tradeId is set → one economic position.
        dedupeKey: p.tradeId !== null && p.tradeId !== undefined
          ? `trade:${p.tradeId}` : `livepos:${p.id}`,
      });
    }
  } catch (err) {
    accounts.push({
      accountKey: "live_positions:*", venue: "mt5",
      balance: null, equity: null,
      status: "UNAVAILABLE",
      statusReason: `READ_FAILED: live_positions — ${(err as Error).message}`,
    });
  }

  const graph = buildBeneficialOwnerExposureGraph({
    accounts,
    positions,
    sourcesRead,
    canonicalize: (symbol) => resolveArxMarket(symbol)?.canonicalSymbol ?? null,
  });
  graph.reasons.push(
    "paper trading excluded by design (no economic exposure); Deriv live positions surface via live_positions once opened");
  return graph;
}
