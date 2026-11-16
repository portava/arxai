// One-shot, idempotent backfill that retags historical closed `trades` rows
// whose recorded P/L had no trustworthy broker source. These rows predate the
// pnlStatus tracking contract (see artifacts/api-server/src/lib/live/realizedPnl.ts):
// older live-position closes defaulted to a fabricated $0 when the broker
// never sent a realized/unrealized value, and older mt5-webhook closes wrote a
// $0 default when no profit was reported. Both still render as if they were
// real wins/losses on Trade Logs and Performance Analytics.
//
// HEURISTIC — a legacy closed trade is UNTRUSTED when ALL of:
//   - status IN ('CLOSED_WIN','CLOSED_LOSS')         (terminal close row)
//   - pnlStatus IS NULL                              (never went through new tracking)
//   - mode = 'LIVE'                                  (broker-sourced; demo sim P/L is out of scope)
//   - AND no trustworthy broker P/L source:
//       * if a linked live_positions row exists (trade_id = trades.id): trusted
//         ONLY when that row has a finite realized OR unrealized value at close;
//         if both are null/non-finite the close defaulted to a fabricated $0.
//       * if NO linked live_positions row (mt5-webhook close): trusted ONLY
//         when pnl is a non-zero finite number (the EA reported a real profit);
//         a null or exactly-$0 pnl is the fabricated default.
//
// ACTION on untrusted rows: pnl=NULL, pnlStatus='UNKNOWN',
//   dataQualityFlag='LEGACY_NO_BROKER_PNL'. The terminal status text is left
//   intact (the trade really did close); only the fabricated number is removed.
//
// SAFETY:
//   - Touches ONLY the `trades` table. Never deletes any row. Never reads or
//     mutates live_positions, audit tables, or broker history.
//   - Idempotent: after the first run the matched rows carry pnlStatus='UNKNOWN'
//     so the pnlStatus IS NULL filter excludes them on every subsequent run.
//   - NOT wired into startup — run manually:
//       pnpm --filter @workspace/scripts run backfill:legacy-unknown-pnl

import { and, eq, inArray, isNull } from "drizzle-orm";
import { db, tradesTable, livePositionsTable } from "@workspace/db";

const LEGACY_FLAG = "LEGACY_NO_BROKER_PNL" as const;

function isFinite(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

async function main() {
  // Candidate legacy closes: terminal, LIVE, never tracked.
  const candidates = await db.select().from(tradesTable).where(and(
    inArray(tradesTable.status, ["CLOSED_WIN", "CLOSED_LOSS"]),
    isNull(tradesTable.pnlStatus),
    eq(tradesTable.mode, "LIVE"),
  ));

  if (candidates.length === 0) {
    // eslint-disable-next-line no-console
    console.log("[backfillLegacyUnknownPnl] No legacy closed rows to inspect. ✓");
    return;
  }

  // Load the live_positions rows linked to these trades so we can read the
  // realized/unrealized values that were (or were not) present at close.
  const tradeIds = candidates.map((t) => t.id);
  const linkedPositions = await db.select().from(livePositionsTable)
    .where(inArray(livePositionsTable.tradeId, tradeIds));
  const positionsByTradeId = new Map<number, typeof linkedPositions>();
  for (const p of linkedPositions) {
    if (p.tradeId == null) continue;
    const bucket = positionsByTradeId.get(p.tradeId) ?? [];
    bucket.push(p);
    positionsByTradeId.set(p.tradeId, bucket);
  }

  const untrusted: typeof candidates = [];
  let trustedKept = 0;
  for (const trade of candidates) {
    const positions = positionsByTradeId.get(trade.id) ?? [];
    let trusted: boolean;
    if (positions.length > 0) {
      // Linked live-position close: trusted only if some linked row carried a
      // finite realized OR unrealized value at close.
      trusted = positions.some((p) =>
        isFinite(p.realizedProfitLoss) || isFinite(p.unrealizedProfitLoss));
    } else {
      // mt5-webhook close (no live_positions mirror): trusted only when the
      // recorded pnl is a non-zero finite number (a real reported profit).
      trusted = isFinite(trade.pnl) && trade.pnl !== 0;
    }
    if (trusted) trustedKept += 1;
    else untrusted.push(trade);
  }

  // eslint-disable-next-line no-console
  console.log(
    `[backfillLegacyUnknownPnl] Inspected ${candidates.length} legacy closed row(s): `
    + `${untrusted.length} untrusted → retag, ${trustedKept} trusted → keep.`,
  );

  for (const trade of untrusted) {
    const previousPnl = trade.pnl;
    const linked = (positionsByTradeId.get(trade.id) ?? []).length > 0;
    await db.update(tradesTable).set({
      pnl: null,
      pnlStatus: "UNKNOWN",
      dataQualityFlag: LEGACY_FLAG,
    }).where(eq(tradesTable.id, trade.id));
    // eslint-disable-next-line no-console
    console.log(
      `  ✓ trade #${trade.id} ${trade.symbol} ${trade.status} `
      + `source=${linked ? "live_position" : "mt5_webhook"} previousPnl=${previousPnl} → null/UNKNOWN`,
    );
  }

  // eslint-disable-next-line no-console
  console.log(`[backfillLegacyUnknownPnl] Done. Retagged ${untrusted.length} row(s).`);
}

main().then(
  () => process.exit(0),
  (err) => {
    // eslint-disable-next-line no-console
    console.error("[backfillLegacyUnknownPnl] FAILED:", err);
    process.exit(1);
  },
);
