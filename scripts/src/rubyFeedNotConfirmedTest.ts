// Test: the "feed not confirmed" honesty signal stays wired on BOTH Ruby
// surfaces that carry it (Task #300 behaviour, guarded here).
//
//   1. buildRubyDraftRead — the deterministic, read-only draft read over a
//      ChartIntelligenceState. When the feed is NOT usable it must return
//      dataQuality:"insufficient" AND surface the visible read-time caution
//      "Feed not confirmed at read-time — limited visibility.". When the feed
//      IS usable it must return dataQuality:"ok" with NO such caution. The
//      caveat is advisory only — it never gates execution (Ruby is read-only).
//
//   2. getSymbolMarketContextTool — the assistant chat tool. When the built
//      market context is not good / not REALTIME it must set
//      context.feedConfirmed=false and a non-null context.feedCaveat.
//
//   3. getTradeMarketContextTool — the conversational/voice Ruby surface for an
//      OPEN trade ("how's my trade doing?"). It is a DIFFERENT code path from
//      the symbol tool but derives the SAME feed-confirmation from the live
//      marketContext quality + freshness. When the underlying context is not
//      good / not REALTIME it must set context.feedConfirmed=false + a non-null
//      context.feedCaveat; when the feed IS good + REALTIME it must omit the
//      caveat (feedConfirmed=true, feedCaveat=null). Both directions are driven
//      deterministically (see below) — no real provider data.
//
// HOW THE STATES ARE REACHED (deterministically, no real provider data):
//   - feedUsable=true: we push a clean, fresh, ≥150-bar M5 candle window
//     through the genuine MT5 bridge seam (updateCandlesFromMT5), which is
//     FIRST in the forex router chain so the push wins outright. The newest
//     bar opens at the CURRENT 5-minute bucket (trailing 0) → feed quality
//     "clean" → aiUsable=true → VERIFIED, satisfying the chart-truth +
//     handshake gates that feedUsable() requires.
//   - feedUsable=false: a clearly non-existent ticker with NO feed pushed and
//     no provider coverage → the context builder honestly reports
//     insufficient / UNAVAILABLE, never fabricating data.
//   - The conversational/voice trade-context surface (surface 3) reads the
//     ASSISTANT marketProvider chain (NOT the MT5 candle seam), so its two
//     directions are driven via the provider seam: the default null provider
//     (no API keys) yields insufficient/UNAVAILABLE → feedConfirmed=false; a
//     deterministic in-memory provider that reports good multi-TF candles +
//     a REALTIME quote yields feedConfirmed=true. The seam is reset after.
//
// SAFETY / ISOLATION
//   - Pure in-process: calls the real functions directly. Never spins up the
//     EA, never inserts arx_live_commands, never places or closes a trade.
//   - The candle "live feed" is injected via the same in-memory seam the real
//     MT5 bridge uses (updateCandlesFromMT5) — a genuine real-data path, not
//     fabricated simulator OHLC.
//   - Only DATABASE_URL is required (the chart-event lookup is best-effort and
//     degrades to [] on error).
//
// Run: pnpm --filter @workspace/scripts run test:ruby-feed-not-confirmed

import { buildChartIntelligenceState } from "../../artifacts/api-server/src/lib/data/chart/chartIntelligence.js";
import { buildRubyDraftRead } from "../../artifacts/api-server/src/lib/assistant/rubyDraftRead.js";
import { getSymbolMarketContextTool, getTradeMarketContextTool, getMarketSnapshot } from "../../artifacts/api-server/src/lib/assistant/tools.js";
import { updateCandlesFromMT5 } from "../../artifacts/api-server/src/lib/data/providers/mt5Provider.js";
import {
  _resetMarketProviderForTests,
  _setMarketProviderForTests,
  type MarketProvider,
  type Candle,
} from "../../artifacts/api-server/src/lib/assistant/marketProvider.js";
import { isEntrypoint, type CiTestResultLike } from "./ci/inProcessAppHarness.js";
import {
  insertVerifiedLivePosition,
  insertUnverifiedLivePosition,
  assertFixtureIsVerifiedLive,
  assertFixtureIsNotVerifiedLive,
  assertArxFocusFixtureSymbols,
} from "./rubyFeedNotConfirmedFixtures.js";

// The exact read-time caution buildRubyDraftRead prepends on an unconfirmed
// feed (mirrors the chart-read honesty signal). Kept verbatim so a copy change
// in rubyDraftRead.ts trips this test.
const DRAFT_FEED_CAUTION = "Feed not confirmed at read-time — limited visibility.";

// A forex symbol with a REAL pushed candle window → the only feed-confirmable
// read. Forex routes through [mt5_broker, ...]; the mt5_broker seam is FIRST so
// our push wins outright (deterministic even if assistant providers are set).
const VERIFIED_SYMBOL = "EURUSD";
// A symbol with NO feed pushed and no provider coverage → insufficient.
const NO_FEED_SYMBOL = "ZZNOFEEDXX";
const TIMEFRAME = "M5" as const;
const M5_MS = 5 * 60 * 1000;
// Comfortably above MIN_CANDLE_HISTORY_COUNT (150) for the M5 chart-truth gate.
const CANDLE_COUNT = 220;

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

/**
 * A clean, steady, low-drift M5 window whose NEWEST bar opens at the CURRENT
 * 5-minute bucket (trailing 0 → feed quality "clean" → aiUsable=true →
 * VERIFIED). Equal candle ranges, zero gaps, valid OHLC — no anomalies that
 * would degrade the truth assessment below CLEAN.
 */
function buildCleanWindow(): Array<{ time: string; open: number; high: number; low: number; close: number; volume: number }> {
  const out: Array<{ time: string; open: number; high: number; low: number; close: number; volume: number }> = [];
  const base = 1.1000;
  const stepUp = 0.00002; // tiny per-bar drift → no spike/outlier anomalies
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

// A synthetic, isolated user id for the trade-context surface (negative so it
// can never collide with a real users.id). The trade row is inserted, used, and
// deleted within the test.
const TRADE_TEST_USER_ID = -999_303;

// A deterministic in-memory market provider that reports a GOOD, REALTIME feed
// for ANY symbol — enough multi-timeframe candles for buildMarketContext to
// rate quality "good", plus a REALTIME quote so freshness === "REALTIME". This
// drives getTradeMarketContextTool's feedConfirmed=true branch WITHOUT any API
// key or network call. NEVER used in production — injected only via the
// test-only seam and reset immediately after.
function buildGoodRealtimeProvider(): MarketProvider {
  const makeCandles = (n: number): Candle[] => {
    const out: Candle[] = [];
    const base = 1.1;
    for (let i = 0; i < n; i++) {
      const c = base + i * 0.0001;
      out.push({ t: new Date(Date.now() - (n - i) * 60_000).toISOString(), o: c - 0.00005, h: c + 0.0001, l: c - 0.0001, c, v: 1000 });
    }
    return out;
  };
  return {
    name: "test_good_realtime",
    connected: true,
    notes: "Deterministic test provider — good multi-TF candles + REALTIME quote.",
    features: { quotes: true, news: false, snapshots: true, economicCalendar: false, candles: true },
    async getLiveQuote(symbol) {
      return {
        symbol, price: 1.1, bid: 1.0999, ask: 1.1001, change: 0.0005, changePct: 0.05,
        high: 1.105, low: 1.095, open: 1.0995, previousClose: 1.0995,
        asOf: new Date().toISOString(), freshness: "REALTIME", source: "test_good_realtime", stale: false,
      };
    },
    async getCandles(symbol, timeframe) {
      return { connected: true, source: "test_good_realtime", symbol, timeframe, candles: makeCandles(30), freshness: "REALTIME", asOf: new Date().toISOString() };
    },
    async getMarketNews() { return { connected: false, items: [], provider: "test_good_realtime" }; },
    async getEconomicCalendar() { return { connected: false, events: [], provider: "test_good_realtime" }; },
    async getSymbolOverview(symbol) { return { connected: true, symbol, description: null, provider: "test_good_realtime" }; },
    async getTradingSessionContext() { return { connected: true, sessions: [], nowUtc: new Date().toISOString(), provider: "test_good_realtime" }; },
  };
}

export async function run(): Promise<CiTestResultLike> {
  passes = 0;
  failures = 0;
  // eslint-disable-next-line no-console
  console.log("rubyFeedNotConfirmedTest");
  // eslint-disable-next-line no-console
  console.log("=======================\n");

  // ── 0. GATE-DRIFT PREFLIGHT — ARX Focus lock (Task #815) ──────────────────
  // Before any behaviour assertion, prove the two symbols the suite depends on
  // still sit on the correct side of the ARX Focus lock. getMarketSnapshot
  // blocks unapproved markets BEFORE the shared resolver runs, so if
  // VERIFIED_SYMBOL falls out of the universe (or NO_FEED_SYMBOL gets added), the
  // confirmed/not-confirmed snapshot assertions below silently change shape. This
  // throws a LOUD, gate-named GateDriftError instead — pointing at the ARX Focus
  // gate, not at a confusing downstream symptom.
  assertArxFocusFixtureSymbols({ verifiedSymbol: VERIFIED_SYMBOL, noFeedSymbol: NO_FEED_SYMBOL });

  // ── 1. buildRubyDraftRead — usable feed → dataQuality "ok", no caution ────
  // eslint-disable-next-line no-console
  console.log(`buildRubyDraftRead (${VERIFIED_SYMBOL}) — clean feed pushed → usable`);
  updateCandlesFromMT5(VERIFIED_SYMBOL, buildCleanWindow());
  const usableState = await buildChartIntelligenceState(VERIFIED_SYMBOL, TIMEFRAME, CANDLE_COUNT);
  const usableRead = buildRubyDraftRead(usableState, "analyze");
  assert(
    usableRead.feedUsable === true,
    `usable: draft feedUsable === true (got ${String(usableRead.feedUsable)})`,
  );
  assert(
    usableRead.dataQuality === "ok",
    `usable: draft dataQuality === "ok" (got ${String(usableRead.dataQuality)})`,
  );
  assert(
    !usableRead.cautions.includes(DRAFT_FEED_CAUTION),
    "usable: draft does NOT carry the feed-not-confirmed caution",
  );

  // ── 2. buildRubyDraftRead — no feed → dataQuality "insufficient" + caution ─
  // eslint-disable-next-line no-console
  console.log(`\nbuildRubyDraftRead (${NO_FEED_SYMBOL}) — no feed → insufficient`);
  const insufficientState = await buildChartIntelligenceState(NO_FEED_SYMBOL, TIMEFRAME, CANDLE_COUNT);
  // Every intent must degrade identically — assert across the full intent set
  // so no single answer path can silently drop the caveat.
  const { RUBY_DRAFT_INTENTS } = await import("../../artifacts/api-server/src/lib/assistant/rubyDraftRead.js");
  let allFeedUnusable = true;
  let allInsufficient = true;
  let allCarryCaution = true;
  for (const intent of RUBY_DRAFT_INTENTS) {
    const r = buildRubyDraftRead(insufficientState, intent);
    if (r.feedUsable !== false) allFeedUnusable = false;
    if (r.dataQuality !== "insufficient") allInsufficient = false;
    if (!r.cautions.includes(DRAFT_FEED_CAUTION)) allCarryCaution = false;
  }
  assert(allFeedUnusable, `insufficient: every intent reports feedUsable === false`);
  assert(allInsufficient, `insufficient: every intent returns dataQuality "insufficient"`);
  assert(allCarryCaution, `insufficient: every intent carries "${DRAFT_FEED_CAUTION}"`);

  // ── 3. getSymbolMarketContextTool — not good/REALTIME → feedConfirmed false ─
  // eslint-disable-next-line no-console
  console.log(`\ngetSymbolMarketContextTool (${NO_FEED_SYMBOL}) — no provider data → not confirmed`);
  const tool = await getSymbolMarketContextTool(NO_FEED_SYMBOL) as {
    ok?: boolean;
    context?: { feedConfirmed?: boolean; feedCaveat?: string | null; dataQuality?: { quality?: string }; freshness?: string };
  };
  assert(tool.ok === true, `tool: returns ok (got ${String(tool.ok)})`);
  const ctx = tool.context;
  assert(!!ctx, "tool: context present");
  // Precondition: the built context is genuinely not good/REALTIME (honest
  // no-data path) — proves the false verdict is earned, not coincidental.
  const notGoodOrRealtime =
    ctx?.dataQuality?.quality !== "good" || ctx?.freshness !== "REALTIME";
  assert(
    notGoodOrRealtime,
    `tool: context is not good/REALTIME (quality=${String(ctx?.dataQuality?.quality)}, freshness=${String(ctx?.freshness)})`,
  );
  assert(
    ctx?.feedConfirmed === false,
    `tool: context.feedConfirmed === false (got ${String(ctx?.feedConfirmed)})`,
  );
  assert(
    typeof ctx?.feedCaveat === "string" && ctx.feedCaveat.length > 0,
    `tool: context.feedCaveat is a non-null string (got ${String(ctx?.feedCaveat)})`,
  );

  // ── 4. getTradeMarketContextTool — conversational/voice Ruby (open trade) ──
  // Same feed-confirmation derivation as the symbol tool, but a DIFFERENT code
  // path (resolves a user-owned trade, then builds marketContext for it). We
  // drive BOTH directions deterministically via the assistant-provider seam.
  // eslint-disable-next-line no-console
  console.log(`\ngetTradeMarketContextTool — open-trade context (both feed states)`);
  // Insert an isolated, synthetic open trade for the negative test user via the
  // SHARED fixture helper — the ONE place every "must stay verified-live" field
  // lives, so a tightened honesty gate is satisfied in a single edit, not in
  // scattered inline inserts. The symbol is the no-feed ticker so the
  // DEFAULT-provider direction (4a) is deterministically not good/REALTIME
  // regardless of which API keys this env happens to carry; 4b injects a
  // symbol-agnostic good provider, so the trade symbol does not matter there.
  const fixture = await insertVerifiedLivePosition({
    userId: TRADE_TEST_USER_ID,
    symbol: NO_FEED_SYMBOL,
  });
  const tradeKey = fixture.tradeKey;

  type TradeCtxResult = {
    ok?: boolean;
    context?: { feedConfirmed?: boolean; feedCaveat?: string | null; dataQuality?: { quality?: string }; freshness?: string };
  };

  try {
    // GATE-DRIFT PREFLIGHT — Live-Position Truth gate (Task #815). Prove the
    // fixture STILL classifies as verified-live via the SAME classifier the tool
    // uses. If a tightened gate rejected it, getTradeMarketContextTool would
    // withhold ALL context (ok:false, no `context`) and every assertion below
    // would fail confusingly — so throw a LOUD, gate-named GateDriftError first.
    await assertFixtureIsVerifiedLive(fixture);
    assert(true, "trade-ctx preflight: fixture passes the Live-Position Truth gate (verified-live)");

    // 4a. NOT confirmed — default null provider (no API keys) → insufficient.
    _resetMarketProviderForTests();
    const notConfirmed = await getTradeMarketContextTool(TRADE_TEST_USER_ID, tradeKey) as TradeCtxResult;
    assert(notConfirmed.ok === true, `trade-ctx (not confirmed): returns ok (got ${String(notConfirmed.ok)})`);
    const nctx = notConfirmed.context;
    assert(!!nctx, "trade-ctx (not confirmed): context present");
    // Precondition: the context is genuinely not good/REALTIME (earned verdict).
    const notGoodOrRealtime =
      nctx?.dataQuality?.quality !== "good" || nctx?.freshness !== "REALTIME";
    assert(
      notGoodOrRealtime,
      `trade-ctx (not confirmed): context is not good/REALTIME (quality=${String(nctx?.dataQuality?.quality)}, freshness=${String(nctx?.freshness)})`,
    );
    assert(
      nctx?.feedConfirmed === false,
      `trade-ctx (not confirmed): feedConfirmed === false (got ${String(nctx?.feedConfirmed)})`,
    );
    assert(
      typeof nctx?.feedCaveat === "string" && nctx.feedCaveat.length > 0,
      `trade-ctx (not confirmed): feedCaveat is a non-null string (got ${String(nctx?.feedCaveat)})`,
    );

    // 4b. Confirmed — inject a deterministic good + REALTIME provider → caveat omitted.
    _setMarketProviderForTests(buildGoodRealtimeProvider());
    const confirmed = await getTradeMarketContextTool(TRADE_TEST_USER_ID, tradeKey) as TradeCtxResult;
    assert(confirmed.ok === true, `trade-ctx (confirmed): returns ok (got ${String(confirmed.ok)})`);
    const cctx = confirmed.context;
    assert(!!cctx, "trade-ctx (confirmed): context present");
    // Precondition: the context is genuinely good + REALTIME (earned verdict).
    assert(
      cctx?.dataQuality?.quality === "good" && cctx?.freshness === "REALTIME",
      `trade-ctx (confirmed): context IS good/REALTIME (quality=${String(cctx?.dataQuality?.quality)}, freshness=${String(cctx?.freshness)})`,
    );
    assert(
      cctx?.feedConfirmed === true,
      `trade-ctx (confirmed): feedConfirmed === true (got ${String(cctx?.feedConfirmed)})`,
    );
    assert(
      cctx?.feedCaveat === null,
      `trade-ctx (confirmed): feedCaveat omitted (null) (got ${String(cctx?.feedCaveat)})`,
    );
  } finally {
    // Always restore real provider selection and remove the synthetic trade.
    _resetMarketProviderForTests();
    await fixture.cleanup();
  }

  // ── 5. getMarketSnapshot — broad live-quote tool (top-level feed signal) ───
  // The FOURTH feed-confirmation surface. Post-unification it derives its truth
  // from the SAME shared chart resolver (getSymbolSnapshot → getChartCandles →
  // marketDataRouter) the chart uses — feedConfirmed = aiUsable && freshness ===
  // "REALTIME" — and exposes feedConfirmed/feedCaveat/source/quality TOP-LEVEL
  // (no `context` wrapper). The optional provider quote only ENRICHES the
  // snapshot (bid/ask/spread); it never decides feedConfirmed. Both states are
  // driven deterministically via the genuine mt5_broker candle seam (FIRST in
  // the forex chain), no real API key. Advisory only — never gates execution.
  // eslint-disable-next-line no-console
  console.log(`\ngetMarketSnapshot — broad live-quote tool (not-confirmed + confirmed)`);

  type SnapshotResult = {
    source?: string | null;
    quality?: string;
    aiUsable?: boolean;
    isLive?: boolean;
    freshness?: string;
    feedConfirmed?: boolean;
    feedCaveat?: string | null;
    providerConnected?: boolean;
    quote?: { providerFreshness?: string; price?: number } | null;
  };

  // getMarketSnapshot reads the M15 picture, so build a clean M15 window that
  // lands on the seriesKey it resolves (buildCleanWindow above is M5).
  const buildCleanWindowM15 = (): Array<{ time: string; open: number; high: number; low: number; close: number; volume: number }> => {
    const out: Array<{ time: string; open: number; high: number; low: number; close: number; volume: number }> = [];
    const base = 1.1000;
    const stepUp = 0.00002;
    const body = 0.00010;
    const wick = 0.00015;
    const m15 = 15 * 60 * 1000;
    const currentBucket = Math.floor(Date.now() / m15) * m15;
    const start = currentBucket - (CANDLE_COUNT - 1) * m15;
    for (let i = 0; i < CANDLE_COUNT; i++) {
      const close = base + i * stepUp;
      const open = close - body;
      const high = close + wick;
      const low = open - wick;
      out.push({
        time: new Date(start + i * m15).toISOString(),
        open: Number(open.toFixed(5)), high: Number(high.toFixed(5)),
        low: Number(low.toFixed(5)), close: Number(close.toFixed(5)), volume: 1000,
      });
    }
    return out;
  };

  // 5a. NOT confirmed — a no-feed symbol resolves UNAVAILABLE through the shared
  // resolver → feedConfirmed false + a non-null caveat, source null, aiUsable
  // false. No provider is pushed; the shared truth drives the verdict.
  const snapNotConfirmed = await getMarketSnapshot(NO_FEED_SYMBOL) as SnapshotResult;
  assert(snapNotConfirmed.feedConfirmed === false, `snapshot (not confirmed): feedConfirmed === false (got ${String(snapNotConfirmed.feedConfirmed)})`);
  assert(snapNotConfirmed.aiUsable === false, `snapshot (not confirmed): aiUsable === false (got ${String(snapNotConfirmed.aiUsable)})`);
  assert(snapNotConfirmed.source === null, `snapshot (not confirmed): source === null (got ${String(snapNotConfirmed.source)})`);
  assert(snapNotConfirmed.freshness === "UNAVAILABLE", `snapshot (not confirmed): freshness === "UNAVAILABLE" (got ${String(snapNotConfirmed.freshness)})`);
  assert(
    typeof snapNotConfirmed.feedCaveat === "string" && snapNotConfirmed.feedCaveat.length > 0,
    `snapshot (not confirmed): feedCaveat is a non-null string (got ${String(snapNotConfirmed.feedCaveat)})`,
  );

  // 5b. CONFIRMED — a clean, fresh M15 window pushed through the broker seam →
  // shared resolver reports clean + REALTIME → feedConfirmed true, caveat omitted.
  updateCandlesFromMT5(VERIFIED_SYMBOL, buildCleanWindowM15(), "M15");
  const snapConfirmed = await getMarketSnapshot(VERIFIED_SYMBOL) as SnapshotResult;
  assert(snapConfirmed.feedConfirmed === true, `snapshot (confirmed): feedConfirmed === true (got ${String(snapConfirmed.feedConfirmed)})`);
  assert(snapConfirmed.aiUsable === true, `snapshot (confirmed): aiUsable === true (got ${String(snapConfirmed.aiUsable)})`);
  assert(snapConfirmed.quality === "clean", `snapshot (confirmed): quality === "clean" (got ${String(snapConfirmed.quality)})`);
  assert(snapConfirmed.isLive === true, `snapshot (confirmed): isLive === true (got ${String(snapConfirmed.isLive)})`);
  assert(snapConfirmed.freshness === "REALTIME", `snapshot (confirmed): freshness === "REALTIME" (got ${String(snapConfirmed.freshness)})`);
  assert(typeof snapConfirmed.source === "string" && (snapConfirmed.source as string).length > 0, `snapshot (confirmed): source is a non-empty string (got ${String(snapConfirmed.source)})`);
  assert(snapConfirmed.feedCaveat === null, `snapshot (confirmed): feedCaveat omitted (null) (got ${String(snapConfirmed.feedCaveat)})`);

  // ── 6. BLOCK / WITHHELD / ERROR branches carry the honest feed contract ────
  // Task #816 made EVERY block / withheld / error branch of the market tools
  // emit the honest feed-status shape (feedConfirmed:false + feedCaveat +
  // source/quality/freshness) so Eleanor can always explain WHY she can't answer
  // instead of returning a silently blank reply. Sections 1–5 lock the SUCCESS
  // paths; this section locks the NON-success branches so a refactor can't strip
  // those fields back to `undefined` and reintroduce the blank-answer bug without
  // a failing test. No provider data, no execution path — pure block/error shape.
  // eslint-disable-next-line no-console
  console.log(`\nblock/withheld/error branches — honest feed contract (Task #816)`);

  type NestedCtxResult = {
    ok?: boolean;
    error?: string;
    context?: { feedConfirmed?: boolean; feedCaveat?: string | null; freshness?: string };
  };
  // Shared assertion for the NESTED `context` block/error shape (the context
  // tools). Verifies the branch still hands Eleanor a defined, honest feed.
  const assertNestedUnavailable = (label: string, res: NestedCtxResult): void => {
    assert(res.ok === false, `${label}: ok === false (got ${String(res.ok)})`);
    const c = res.context;
    assert(!!c, `${label}: context present (never undefined)`);
    assert(c?.feedConfirmed === false, `${label}: context.feedConfirmed === false (got ${String(c?.feedConfirmed)})`);
    assert(
      typeof c?.feedCaveat === "string" && c.feedCaveat.length > 0,
      `${label}: context.feedCaveat is a non-null string (got ${String(c?.feedCaveat)})`,
    );
    assert(c?.freshness === "UNAVAILABLE", `${label}: context.freshness === "UNAVAILABLE" (got ${String(c?.freshness)})`);
  };

  // 6a. getSymbolMarketContextTool — missing_symbol (empty string) → the tool
  // returns BEFORE touching any provider, but must still carry the honest
  // nested context so Eleanor can explain the missing input rather than go blank.
  const symMissing = await getSymbolMarketContextTool("") as NestedCtxResult;
  assert(symMissing.error === "missing_symbol", `sym missing_symbol: error === "missing_symbol" (got ${String(symMissing.error)})`);
  assertNestedUnavailable("sym missing_symbol", symMissing);

  // 6b. getTradeMarketContextTool — missing_tradeKey (empty key) → nested context.
  const tradeMissingKey = await getTradeMarketContextTool(TRADE_TEST_USER_ID, "") as NestedCtxResult;
  assert(tradeMissingKey.error === "missing_tradeKey", `trade missing_tradeKey: error === "missing_tradeKey" (got ${String(tradeMissingKey.error)})`);
  assertNestedUnavailable("trade missing_tradeKey", tradeMissingKey);

  // 6c. getTradeMarketContextTool — trade-not-found (a well-formed key that does
  // not resolve to a row this user owns) → nested context, honest feed.
  const tradeNotFound = await getTradeMarketContextTool(TRADE_TEST_USER_ID, "lp_999000999") as NestedCtxResult;
  assert(
    tradeNotFound.error === "trade_not_found_or_not_yours",
    `trade not-found: error === "trade_not_found_or_not_yours" (got ${String(tradeNotFound.error)})`,
  );
  assertNestedUnavailable("trade not-found", tradeNotFound);

  // 6d. getTradeMarketContextTool — WITHHELD (a genuinely NON-verified-live row):
  // the tool returns the shared withheld payload (flat feed fields) PLUS a nested
  // `context`, so BOTH surfaces must carry the honest feed shape. A synthetic row
  // with no broker ticket reaches this branch honestly (proven by the preflight).
  const withheldFixture = await insertUnverifiedLivePosition({
    userId: TRADE_TEST_USER_ID,
    symbol: NO_FEED_SYMBOL,
  });
  try {
    // GATE-DRIFT PREFLIGHT — prove the row is genuinely NOT verified-live via the
    // SAME classifier, so it reaches the withheld branch (not trade_not_found and
    // not the success path). Throws a LOUD GateDriftError if a gate change moved it.
    await assertFixtureIsNotVerifiedLive(withheldFixture);
    assert(true, "trade withheld preflight: fixture is genuinely NOT verified-live (withheld branch)");

    const withheld = await getTradeMarketContextTool(TRADE_TEST_USER_ID, withheldFixture.tradeKey) as NestedCtxResult & {
      reason?: string;
      feedConfirmed?: boolean;
      feedCaveat?: string | null;
      freshness?: string;
      source?: string | null;
    };
    // Withhold reason stays POSITION_NOT_VERIFIED (the truth verdict), unchanged.
    assert(withheld.ok === false, `trade withheld: ok === false (got ${String(withheld.ok)})`);
    assert(withheld.reason === "POSITION_NOT_VERIFIED", `trade withheld: reason === "POSITION_NOT_VERIFIED" (got ${String(withheld.reason)})`);
    // FLAT feed fields (from the shared withheldAdvicePayload).
    assert(withheld.feedConfirmed === false, `trade withheld: flat feedConfirmed === false (got ${String(withheld.feedConfirmed)})`);
    assert(
      typeof withheld.feedCaveat === "string" && withheld.feedCaveat.length > 0,
      `trade withheld: flat feedCaveat is a non-null string (got ${String(withheld.feedCaveat)})`,
    );
    assert(withheld.freshness === "UNAVAILABLE", `trade withheld: flat freshness === "UNAVAILABLE" (got ${String(withheld.freshness)})`);
    assert(withheld.source === null, `trade withheld: flat source === null (got ${String(withheld.source)})`);
    // NESTED context feed fields (added on top of the withheld payload).
    assertNestedUnavailable("trade withheld (nested)", withheld);
  } finally {
    await withheldFixture.cleanup();
  }

  // 6e. getMarketSnapshot — ARX-blocked (non-focus) symbol → the block branch
  // returns NO market data, but must carry the TOP-LEVEL honest feed fields so
  // Eleanor explains the off-universe block instead of going blank. NO_FEED_SYMBOL
  // is (by preflight in section 0) NOT an approved ARX market → this branch fires.
  type BlockedSnapshotResult = SnapshotResult & { blocked?: boolean; isApprovedMarket?: boolean };
  const snapBlocked = await getMarketSnapshot(NO_FEED_SYMBOL) as BlockedSnapshotResult;
  assert(snapBlocked.blocked === true, `snapshot ARX-blocked: blocked === true (got ${String(snapBlocked.blocked)})`);
  assert(snapBlocked.isApprovedMarket === false, `snapshot ARX-blocked: isApprovedMarket === false (got ${String(snapBlocked.isApprovedMarket)})`);
  assert(snapBlocked.feedConfirmed === false, `snapshot ARX-blocked: feedConfirmed === false (got ${String(snapBlocked.feedConfirmed)})`);
  assert(snapBlocked.source === null, `snapshot ARX-blocked: source === null (got ${String(snapBlocked.source)})`);
  assert(snapBlocked.freshness === "UNAVAILABLE", `snapshot ARX-blocked: freshness === "UNAVAILABLE" (got ${String(snapBlocked.freshness)})`);
  assert(
    typeof snapBlocked.feedCaveat === "string" && snapBlocked.feedCaveat.length > 0,
    `snapshot ARX-blocked: feedCaveat is a non-null string (got ${String(snapBlocked.feedCaveat)})`,
  );

  // eslint-disable-next-line no-console
  console.log(`\nResult: ${passes} passed, ${failures} failed`);
  return { name: "rubyFeedNotConfirmedTest", passes, failures };
}

if (isEntrypoint(import.meta.url)) {
  run().then(
    (r) => process.exit(r.failures > 0 ? 1 : 0),
    (err) => {
      // eslint-disable-next-line no-console
      console.error("[rubyFeedNotConfirmedTest] FAILED:", err);
      process.exit(1);
    },
  );
}
