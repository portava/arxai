import { db, brokerCandlesTable, brokerCandleBackfillStatusTable } from "@workspace/db";
import { getUserConnection } from "../brokerHub/connections.js";
import { and, desc, eq, lt } from "drizzle-orm";
import { brokerHistoryIdentity } from "./brokerHistoryPolicy.js";
import { currentFeedScopeBridge } from "./feedScope.js";
import { barCloseMs, normalizeChartTimeframe } from "./chart/timeframes.js";
import { classifySymbol, routeCandles } from "./marketDataRouter.js";
import { scannerSourceIdentity } from "../scannerInputIntegrity.js";
import type { CandleHistoryResult, GetCandleHistoryArgs } from "./candleHistoryService.js";
import { brokerHistoryCandle } from "./brokerHistoryCandle.js";

/** Read one immutable native account era, under the authenticated owner. Raw
 * broker time is retained as source-clock history, never relabelled UTC. */
export async function readBrokerHistory(args: GetCandleHistoryArgs): Promise<CandleHistoryResult> {
  const symbol = args.symbol.trim().toUpperCase(), timeframe = normalizeChartTimeframe(args.timeframe);
  const base: CandleHistoryResult = { ok: false, symbol, timeframe: timeframe ?? args.timeframe,
    assetClass: classifySymbol(symbol), source: "mt5_broker", candles: [], status: "unavailable",
    returnedCount: 0, oldest: null, newest: null, hasMoreHistory: false, nextBefore: null,
    providerLimitReached: false, providerMessage: null, cacheHit: false, fetchedAt: new Date().toISOString(),
    depthTargetDays: 0, coverageDays: null, depthTargetMet: false, sourcePriorityUsed: ["mt5_broker"],
    limitationReason: null, userMessage: "", adminDetail: "Owner-scoped native broker history.", historyEvidence: null };
  const refuse = (reason: string) => ({ ...base, userMessage: reason, providerMessage: reason, limitationReason: reason });
  const bridge = await currentFeedScopeBridge();
  if (!timeframe || !args.userId || !bridge) return refuse("Sign in with the chart's broker connection to load its history.");
  const connection = await getUserConnection(args.userId, bridge);
  if (!connection?.accountNumber || !connection.serverName) return refuse("The chart's broker account identity is unavailable.");
  const identity = brokerHistoryIdentity({ userId: args.userId, bridgeConnectionId: bridge,
    accountNumber: connection.accountNumber, serverName: connection.serverName, clockBasis: "broker_server" });
  if (args.expectedSourceIdentity) {
    const routed = await routeCandles(symbol, timeframe, 2, { bridgeConnectionId: bridge });
    if (scannerSourceIdentity(routed) !== args.expectedSourceIdentity || routed.primaryProvider !== "mt5_broker"
      || !routed.provenance?.sourceId.endsWith(`:${identity}`)) return refuse("The source connection changed. Reload this chart before paging history.");
  }
  const before = args.before ? new Date(args.before) : new Date();
  if (!Number.isFinite(before.getTime())) return refuse("Invalid historical cursor.");
  const limit = Math.max(1, Math.min(5000, Math.floor(args.limit ?? 500)));
  const status = await db.select().from(brokerCandleBackfillStatusTable).where(and(
    eq(brokerCandleBackfillStatusTable.userId, args.userId), eq(brokerCandleBackfillStatusTable.bridgeConnectionId, bridge),
    eq(brokerCandleBackfillStatusTable.historyIdentity, identity), eq(brokerCandleBackfillStatusTable.symbol, symbol),
    eq(brokerCandleBackfillStatusTable.timeframe, timeframe))).limit(2);
  if (status.length !== 1) return refuse(status.length ? "Multiple native symbols need source selection." : "The broker history import is starting.");
  const progress = status[0]!;
  const rows = await db.select().from(brokerCandlesTable).where(and(
    eq(brokerCandlesTable.userId, args.userId), eq(brokerCandlesTable.bridgeConnectionId, bridge),
    eq(brokerCandlesTable.historyIdentity, identity), eq(brokerCandlesTable.brokerSymbol, progress.brokerSymbol),
    eq(brokerCandlesTable.timeframe, timeframe), eq(brokerCandlesTable.isClosedBar, true),
    lt(brokerCandlesTable.openTimeUtc, before))).orderBy(desc(brokerCandlesTable.openTimeUtc)).limit(limit + 1);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).reverse();
  const complete = progress.status === "COMPLETE" && progress.statusReason === "all_available_native_pages_verified";
  const message = complete ? "All available native history imported." : "Older native history is importing. Retry to load newly received pages.";
  return { ...base, ok: true, status: "historical_only", cacheHit: true,
    candles: page.map(brokerHistoryCandle),
    returnedCount: page.length, oldest: page[0]?.openTimeUtc.toISOString() ?? null,
    newest: page.at(-1)?.openTimeUtc.toISOString() ?? null, hasMoreHistory: hasMore,
    nextBefore: page[0]?.openTimeUtc.toISOString() ?? null,
    providerLimitReached: complete && !hasMore, coverageDays: progress.coverageDays,
    depthTargetMet: complete, userMessage: message, providerMessage: message,
    // Producer identity is proved; historical UTC mapping remains a separate
    // claim. The client keeps these native-time bars out of UTC analysis inputs.
    nativeHistoryEvidence: { sourceIdentity: identity, clockBasis: "broker_server",
      importStatus: progress.status, barsStored: progress.barsStored,
      oldest: progress.oldestStoredAt?.toISOString() ?? null,
      boundary: progress.boundaryRaw?.toISOString() ?? null },
  };
}
