// One-shot cleanup for the broker-clock switch (owner decision 2026-11-08:
// convert MT5 stamps to UTC at ingest, superseding audit H7's broker
// coordinates).
//
// Before the switch, every stored MT5 bar was keyed by its BROKER-server open
// time. After it, bars from a bridge whose clock offset is measured are keyed
// by UTC. The stored rows carry no record of which clock they used, so a
// series would mix two clocks (on a UTC+2/+3 broker the old rows sit two or
// three hours "ahead" of the new ones). This script removes the stored MT5
// bars last written BEFORE the switch went live so that the EA's history
// re-push refills them on the UTC clock.
//
// SCOPE (nothing else is touched):
//   - market_candles rows with source = 'mt5_broker' (the durable MT5 mirror)
//   - broker_candles rows (the bridge-scoped EA history store)
//   both only where updated_at < --before. A row re-written after the switch
//   has a newer updated_at and is kept.
//
// SAFETY:
//   - Dry run by default: prints the counts and changes nothing.
//   - --apply deletes inside one transaction.
//   - --before is required (the time the convert-at-ingest build went live,
//     ISO 8601 with a zone, e.g. 2026-11-09T14:00:00Z). No default, no guess.
//   - NOT wired into startup. Run manually:
//       pnpm --filter @workspace/scripts run purge:pre-utc-mt5-bars -- --before <ISO>
//       pnpm --filter @workspace/scripts run purge:pre-utc-mt5-bars -- --before <ISO> --apply
//   - Stored bars are a cache of what the EA pushes; until it re-pushes, the
//     chart's stored-history fallback has less to show for those symbols.

import { and, eq, lt, sql } from "drizzle-orm";
import { db, brokerCandlesTable, marketCandlesTable } from "@workspace/db";

const MT5_MIRROR_SOURCE = "mt5_broker";

function parseArgs(argv: string[]): { before: Date; apply: boolean } {
  const apply = argv.includes("--apply");
  const i = argv.indexOf("--before");
  const raw = i >= 0 ? argv[i + 1] : undefined;
  if (!raw || !/(Z|[+-]\d{2}:?\d{2})$/.test(raw)) {
    throw new Error("--before <ISO time with a zone> is required (when the convert-at-ingest build went live).");
  }
  const before = new Date(raw);
  if (!Number.isFinite(before.getTime())) throw new Error(`--before is not a valid time: ${raw}`);
  if (before.getTime() > Date.now()) throw new Error("--before is in the future; refusing.");
  return { before, apply };
}

async function main() {
  const { before, apply } = parseArgs(process.argv.slice(2));
  const mirrorWhere = and(eq(marketCandlesTable.source, MT5_MIRROR_SOURCE), lt(marketCandlesTable.updatedAt, before));
  const brokerWhere = lt(brokerCandlesTable.updatedAt, before);

  const [mirror] = await db.select({ n: sql<number>`count(*)::int` }).from(marketCandlesTable).where(mirrorWhere);
  const [broker] = await db.select({ n: sql<number>`count(*)::int` }).from(brokerCandlesTable).where(brokerWhere);
  console.log(`Stored MT5 bars last written before ${before.toISOString()}:`);
  console.log(`  market_candles (source=${MT5_MIRROR_SOURCE}): ${mirror?.n ?? 0}`);
  console.log(`  broker_candles: ${broker?.n ?? 0}`);

  if (!apply) {
    console.log("Dry run: nothing deleted. Re-run with --apply to delete these rows.");
    return;
  }
  await db.transaction(async (tx) => {
    await tx.delete(marketCandlesTable).where(mirrorWhere);
    await tx.delete(brokerCandlesTable).where(brokerWhere);
  });
  console.log("Deleted. The EA's next history push refills these series on the UTC clock.");
}

main().then(
  () => process.exit(0),
  (e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); },
);
