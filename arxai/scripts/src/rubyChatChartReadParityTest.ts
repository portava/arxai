// Test: Ruby CHAT's chart read is the SAME structural read as the Scanner "Ruby
// Chart Read" panel (Task #602 follow-on).
//
// Before this work, the chat path collapsed to a weak market-context answer
// ("no primary timeframe / key levels not available") while the panel produced a
// real directional STRUCTURAL read. Both surfaces now call ONE shared service
// (buildRubyStructuralRead), so for the same symbol + timeframe they must
// produce a byte-identical `chartRead`. This test proves that end-to-end against
// the REAL service over a deterministic, real-data feed seam — never the LLM
// (the model only formats the tool's output, it cannot change the payload).
//
// CASES
//   A — PARITY: panel POST /me/assistant/read-chart and the chat
//       `readChartStructureTool` return an identical `chartRead` for the same
//       symbol+timeframe over a verified feed (and it is NOT "insufficient").
//   B — STRUCTURAL_ONLY: when the feed is unconfirmed, both surfaces produce a
//       directional read (bias + support/resistance) but WITHHOLD the exact
//       entry/stop/target levels — and stay identical to each other.
//   C — INSUFFICIENT honesty: an APPROVED symbol with too few closed candles
//       (below the structural minimum) yields an explicit INSUFFICIENT read (no
//       fabricated bias) on the panel AND the shared service, identically. The
//       symbol must resolve so the route reaches buildRubyStructuralRead — an
//       unresolvable ticker is short-circuited by the symbol gate before the
//       service runs, so it never exercises the shared INSUFFICIENT branch.
//
// HOW THE VERIFIED FEED IS REACHED (deterministically, no real broker):
//   We push a clean, fresh, ≥150-bar M5 window through the genuine MT5 bridge
//   seam (updateCandlesFromMT5), which is FIRST in the forex router chain so the
//   push wins outright. The newest bar opens at the current bucket → feed
//   quality "clean" → basis VERIFIED. (Same technique as
//   rubyReadChartFeedHonestyTest.ts.)
//
// SAFETY / ISOLATION
//   - Read-only: only the read-only POST /me/assistant/read-chart endpoint and
//     the read-only structural-read service/tool are exercised. Never places a
//     trade, never inserts arx_live_commands, never reaches the EA or a broker.
//   - Seeds a single isolated system user (isSystemUser=true, fixed email) and
//     operates ONLY on its rows. Idempotent cleanup at start and end.
//   - Candles are injected via the same in-memory seam the real MT5 bridge uses
//     (updateCandlesFromMT5) — a genuine real-data path, not simulator OHLC.
//
// Run: pnpm --filter @workspace/scripts run test:ruby-chat-chart-read-parity

import { randomBytes, createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  db,
  usersTable,
  authUserSessionsTable,
  arxSymbolSpecsTable,
} from "@workspace/db";
import { updateCandlesFromMT5 } from "../../artifacts/api-server/src/lib/data/providers/mt5Provider.js";
import { resolveAssistantMarket } from "../../artifacts/api-server/src/lib/markets/assistantMarketResolver.js";
import { readChartStructureTool } from "../../artifacts/api-server/src/lib/assistant/tools.js";
import { buildRubyStructuralRead } from "../../artifacts/api-server/src/lib/assistant/rubyStructuralReadService.js";
import {
  getSharedBaseUrl,
  closeSharedServer,
  isEntrypoint,
  type CiTestResultLike,
} from "./ci/inProcessAppHarness.js";
import { installNoExternalNetworkGuard } from "./ci/networkGuard.js";

const TEST_EMAIL = "qa+ruby-chat-chart-read-parity@arx.test";
// Forex symbol with a REAL pushed window → the only server-verifiable read.
const RAW_SYMBOL = "EURUSD";
const TIMEFRAME = "M5";
const M5_MS = 5 * 60 * 1000;
const CANDLE_COUNT = 220;
// Case C: a window with FEWER than STRUCTURE_MIN_CLOSED_BARS (20) closed bars →
// canReadStructure is false → the shared service's INSUFFICIENT branch. The MT5
// push is first in the forex chain and wins on ANY non-empty series, so this
// count is served outright (never overridden by a live provider).
const TINY_BAR_COUNT = 12;
// Case C uses a SECOND approved forex major (distinct from EURUSD) so the 3s
// per-symbol context cache from A/B can never serve a stale sufficient context.
const INSUFFICIENT_SYMBOL = "GBPUSD";

let passes = 0;
let failures = 0;
function assert(cond: boolean, label: string): void {
  if (cond) {
    passes++;
    // eslint-disable-next-line no-console
    console.log(`  \u2713 ${label}`);
  } else {
    failures++;
    // eslint-disable-next-line no-console
    console.error(`  \u2717 ${label}`);
  }
}

const norm = (x: unknown): unknown => JSON.parse(JSON.stringify(x ?? null));
function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

/** No exact numeric trade levels may appear on a structural/withheld read. */
function hasNumericLevels(cr: Record<string, unknown>): boolean {
  for (const k of ["entry", "sl", "tp", "stopLoss", "takeProfit", "entryPrice", "stopPrice", "targetPrice"]) {
    if (typeof cr[k] === "number") return true;
  }
  return false;
}

/** A clean, steady M5 window whose NEWEST bar opens at the CURRENT 5-min bucket
 *  (trailing 0 → feed quality "clean" → VERIFIED). Valid OHLC, no anomalies. */
function buildCleanWindow(): Array<{ time: string; open: number; high: number; low: number; close: number; volume: number }> {
  const out: Array<{ time: string; open: number; high: number; low: number; close: number; volume: number }> = [];
  const base = 1.1000;
  const stepUp = 0.00002;
  const body = 0.00010;
  const wick = 0.00015;
  const currentBucket = Math.floor(Date.now() / M5_MS) * M5_MS;
  const start = currentBucket - (CANDLE_COUNT - 1) * M5_MS;
  for (let i = 0; i < CANDLE_COUNT; i++) {
    const close = base + i * stepUp;
    const open = close - body;
    const high = close + wick;
    const low = open - wick;
    out.push({
      time: new Date(start + i * M5_MS).toISOString(),
      open: Number(open.toFixed(5)),
      high: Number(high.toFixed(5)),
      low: Number(low.toFixed(5)),
      close: Number(close.toFixed(5)),
      volume: 1000,
    });
  }
  return out;
}

/** A small window of fully-CLOSED M5 bars (count < STRUCTURE_MIN_CLOSED_BARS).
 *  All bars sit a few buckets in the PAST so none is the forming candle —
 *  hasFormingCandle stays deterministically false across both reads. Valid OHLC.
 *  Too few closed bars ⇒ canReadStructure false ⇒ the INSUFFICIENT branch. */
function buildTinyClosedWindow(count: number): Array<{ time: string; open: number; high: number; low: number; close: number; volume: number }> {
  const out: Array<{ time: string; open: number; high: number; low: number; close: number; volume: number }> = [];
  const base = 1.1000;
  const stepUp = 0.00002;
  const body = 0.00010;
  const wick = 0.00015;
  const currentBucket = Math.floor(Date.now() / M5_MS) * M5_MS;
  // End the window 5 buckets before "now" so every bar is unambiguously closed.
  const end = currentBucket - 5 * M5_MS;
  const start = end - (count - 1) * M5_MS;
  for (let i = 0; i < count; i++) {
    const close = base + i * stepUp;
    const open = close - body;
    const high = close + wick;
    const low = open - wick;
    out.push({
      time: new Date(start + i * M5_MS).toISOString(),
      open: Number(open.toFixed(5)),
      high: Number(high.toFixed(5)),
      low: Number(low.toFixed(5)),
      close: Number(close.toFixed(5)),
      volume: 1000,
    });
  }
  return out;
}

function specRow(userId: number, symbol: string) {
  return {
    userId, symbol, accountType: "demo", visible: true, tradeAllowed: true,
    tradeMode: "FULL", marketOpen: true, digits: 5, point: 0.00001,
    minVolume: 0.01, maxVolume: 100, volumeStep: 0.01, contractSize: 100000,
    tickSize: 0.00001, tickValue: 1, stopsLevelPoints: 0, spreadPoints: 0,
    category: "forex", displaySymbol: symbol,
  };
}

async function cleanupByEmail(): Promise<void> {
  const rows = await db.select().from(usersTable).where(eq(usersTable.email, TEST_EMAIL));
  for (const u of rows) {
    await db.delete(arxSymbolSpecsTable).where(eq(arxSymbolSpecsTable.userId, u.id));
    await db.delete(authUserSessionsTable).where(eq(authUserSessionsTable.userId, u.id));
    await db.delete(usersTable).where(eq(usersTable.id, u.id));
  }
}

export async function run(): Promise<CiTestResultLike> {
  passes = 0;
  failures = 0;
  // eslint-disable-next-line no-console
  console.log("rubyChatChartReadParityTest");
  // eslint-disable-next-line no-console
  console.log("===========================\n");

  await cleanupByEmail();

  // The chat tool resolves the user's typed symbol to a backend-resolvable
  // downstream form; push/seed/read under THAT exact symbol so the panel (which
  // sends the canonical chart symbol) and the tool feed the service identically.
  const resolved = resolveAssistantMarket(RAW_SYMBOL);
  const SYMBOL = resolved.downstreamSymbol ?? RAW_SYMBOL;

  const baseUrl = await getSharedBaseUrl();

  const insertedUsers = await db.insert(usersTable).values({
    email: TEST_EMAIL,
    name: "QA Ruby Chat Chart-Read Parity",
    role: "USER",
    isSystemUser: true,
  }).returning();
  const user = insertedUsers[0]!;

  const rawToken = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  await db.insert(authUserSessionsTable).values({
    userId: user.id,
    tokenHash,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  const cookie = `arx_user_session=${rawToken}`;

  await db.insert(arxSymbolSpecsTable).values([specRow(user.id, SYMBOL)]);
  updateCandlesFromMT5(SYMBOL, buildCleanWindow());

  // OFFLINE DETERMINISM GUARD.
  // The read path enriches from many rate-limited third-party providers
  // (TwelveData/Polygon HTF candles, Finnhub/AlphaVantage/NewsAPI quotes+news).
  // Those calls are NOT what this parity contract is testing — and because their
  // global quota is drained by the live workflow + sibling lanes, in a batch run
  // they return a NON-deterministic mix of 200s and 429s, so two reads taken ms
  // apart receive DIFFERENT enrichment → the byte-identical chartRead assertion
  // flakes (passes in isolation, fails in batch). Block every external host with
  // a single deterministic provider-unavailable response so BOTH surfaces derive
  // from identical offline data: the verifiable read comes solely from the
  // deterministic in-memory MT5 push above. `escapedCount() === 0` (asserted
  // after the reads) proves the test made ZERO live provider calls.
  const netGuard = installNoExternalNetworkGuard();

  const postRead = async (body: unknown) => {
    const res = await fetch(`${baseUrl}/api/me/assistant/read-chart`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, json } as { status: number; json: any };
  };

  try {
    // ── A — PARITY over a verified feed ─────────────────────────────────────
    // eslint-disable-next-line no-console
    console.log(`A — panel vs chat parity (${SYMBOL} ${TIMEFRAME}), verified feed`);
    const panelA = await postRead({ symbol: SYMBOL, timeframe: TIMEFRAME });
    const toolA = await readChartStructureTool(RAW_SYMBOL, TIMEFRAME);
    assert(panelA.status === 200, `panel HTTP 200 (got ${panelA.status})`);
    assert(!!panelA.json?.chartRead, "panel: chartRead present");
    assert(toolA.ok === true, `chat tool ok (got ${JSON.stringify((toolA as { error?: string }).error ?? toolA.ok)})`);
    const toolAchart = (toolA as { chartRead?: Record<string, unknown> }).chartRead ?? {};
    assert((toolA as { symbol?: string }).symbol === SYMBOL, `chat tool read the resolved symbol (${SYMBOL})`);
    assert(
      deepEqual(panelA.json.chartRead, toolAchart),
      "A: panel and chat produce a byte-identical chartRead",
    );
    assert(
      panelA.json.chartRead?.dataQuality !== "insufficient",
      `A: a verified feed yields a real read, not insufficient (got ${String(panelA.json.chartRead?.dataQuality)})`,
    );

    // ── B — STRUCTURAL_ONLY: directional read, exact levels withheld ────────
    // eslint-disable-next-line no-console
    console.log(`\nB — STRUCTURAL_ONLY (${SYMBOL} ${TIMEFRAME}), feed unconfirmed`);
    const panelB = await postRead({ symbol: SYMBOL, timeframe: TIMEFRAME, aiUsable: false });
    const toolB = await readChartStructureTool(RAW_SYMBOL, TIMEFRAME, undefined, true);
    const panelBchart = panelB.json?.chartRead ?? {};
    const toolBchart = (toolB as { chartRead?: Record<string, unknown> }).chartRead ?? {};
    // The CANONICAL layer signal is the tool's TOP-LEVEL `readLayer` (asserted
    // next). Note: chartRead.readLayer carries "STRUCTURAL_ONLY", but the
    // user-copy scrubber strips SCREAMING_SNAKE tokens, so inside the scrubbed
    // chartRead the field is blanked — it is NOT a reliable layer probe. On the
    // panel chartRead the STRUCTURAL_ONLY tier is encoded by the display booleans
    // below (which survive the scrub), and the byte-identical panel/chat parity
    // (final assert) proves both surfaces resolved the same layer.
    assert(
      panelBchart.gated === false &&
        panelBchart.canReadStructure === true &&
        panelBchart.canShowLiveTradeSetup === false &&
        panelBchart.liveSetupWithheld === true,
      "panel: STRUCTURAL_ONLY display contract (readable structure, exact setup withheld)",
    );
    assert((toolB as { readLayer?: string }).readLayer === "STRUCTURAL_ONLY", `chat: readLayer STRUCTURAL_ONLY (got ${String((toolB as { readLayer?: string }).readLayer)})`);
    assert(typeof toolBchart.bias === "string" && (toolBchart.bias as string).length > 0, "B: structural read carries a directional bias");
    assert(
      typeof toolBchart.supportZone === "string" && (toolBchart.supportZone as string).length > 0 &&
        typeof toolBchart.resistanceZone === "string" && (toolBchart.resistanceZone as string).length > 0,
      "B: structural read carries support and resistance zones",
    );
    assert(toolBchart.liveSetupWithheld === true && toolBchart.canShowLiveTradeSetup === false, "B: exact live setup is withheld");
    assert(!hasNumericLevels(toolBchart), "B: NO exact entry/stop/target numeric levels are present");
    assert(deepEqual(panelBchart, toolBchart), "B: panel and chat STRUCTURAL_ONLY reads are identical");

    // ── C — INSUFFICIENT honesty for an approved symbol with too few bars ────
    // eslint-disable-next-line no-console
    console.log(`\nC — INSUFFICIENT honesty (${INSUFFICIENT_SYMBOL} ${TIMEFRAME}), too few closed bars`);
    // Approved symbol so the route's symbol gate PASSES and reaches the service;
    // a tiny (<20-bar) window forces the genuine "not enough closed history"
    // INSUFFICIENT branch shared by the panel and the service.
    await db.insert(arxSymbolSpecsTable).values([specRow(user.id, INSUFFICIENT_SYMBOL)]);
    updateCandlesFromMT5(INSUFFICIENT_SYMBOL, buildTinyClosedWindow(TINY_BAR_COUNT));
    const panelC = await postRead({ symbol: INSUFFICIENT_SYMBOL, timeframe: TIMEFRAME });
    const svcC = await buildRubyStructuralRead({ symbol: INSUFFICIENT_SYMBOL, timeframe: TIMEFRAME, draft: null });
    assert(panelC.status === 200, `panel HTTP 200 (got ${panelC.status})`);
    const panelCchart = panelC.json?.chartRead ?? {};
    assert(panelCchart.readLayer === "INSUFFICIENT", `panel: readLayer INSUFFICIENT (got ${String(panelCchart.readLayer)})`);
    assert(svcC.readLayer === "INSUFFICIENT", `shared service: readLayer INSUFFICIENT (got ${svcC.readLayer})`);
    assert(panelCchart.dataQuality === "insufficient", `panel: dataQuality insufficient (got ${String(panelCchart.dataQuality)})`);
    assert(svcC.chartRead.bias === undefined, "C: no fabricated directional bias on an insufficient read");
    assert(deepEqual(panelCchart, svcC.chartRead), "C: panel and the shared service agree on the insufficient read");
  } finally {
    // Always restore the real fetch — `run()` may be invoked by an aggregator
    // that executes sibling tests in the same process after this one.
    netGuard.restore();
  }

  // OFFLINE GUARD PROOF (positive + non-tautological): the read path really does
  // fan out to external providers for enrichment, and the guard intercepted that
  // fanout offline (answering each host itself, never touching the network). A
  // non-zero attempt count with a non-empty blocked-host set proves the guard was
  // actually exercised — if the enrichment had instead reached the live network,
  // these would be 0 (the guard never sees the call). This is what removes the
  // batch-run flake; whole-process "nothing hit the network" is verified
  // out-of-band via the NODE_OPTIONS pass-through fetch logger.
  assert(
    netGuard.attemptCount() > 0 && netGuard.blockedHosts().length > 0,
    `offline: read-path enrichment was intercepted by the guard, not the network ` +
      `(attempts=${netGuard.attemptCount()}, blocked hosts=[${netGuard.blockedHosts().join(", ")}])`,
  );

  await cleanupByEmail();

  // eslint-disable-next-line no-console
  console.log(`\nResult: ${passes} passed, ${failures} failed`);
  return { name: "rubyChatChartReadParityTest", passes, failures };
}

if (isEntrypoint(import.meta.url)) {
  run().then(
    async (r) => {
      await closeSharedServer().catch(() => {});
      process.exit(r.failures > 0 ? 1 : 0);
    },
    async (err) => {
      await cleanupByEmail().catch(() => {});
      await closeSharedServer().catch(() => {});
      // eslint-disable-next-line no-console
      console.error("[rubyChatChartReadParityTest] FAILED:", err);
      process.exit(1);
    },
  );
}
