// Test: POST /api/me/assistant/draw-setup end-to-end against the booted app
// (Task #385).
//
// Task #381 unit-tested the PURE signal-assembly helper
// (lib/assistant/setupSignals.ts) and Task #374's suite covers the PURE
// producer (buildSetupPreview). What neither proves is that the REAL HTTP route
// — with a booted Express app, a real session, seeded broker-truth specs, and a
// live-feed push — actually wires the scanner/scalp/governance sources into the
// response shape a client receives. This test closes that gap.
//
// Honesty / safety contracts verified here:
//   1. VERIFIED feed → the route DRAWS a setup. The response carries a
//      setupPreview whose basis is "VERIFIED", whose status is the server-only
//      "preview", and whose enriched signal fields (scannerScore, riskScore,
//      flameStage, runOnQuality, governanceOutcome) are PRESENT in the JSON
//      envelope — each either a correctly-typed value or honestly null, never
//      fabricated or dropped. With a forced BUY side over a clean uptrend the
//      preview produces real, geometry-honest levels (SL < entry < TP).
//   2. GATED feed (no feed pushed, non-existent ticker) → the route still
//      REFUSES to draw: verdict "refused", levels null, side null, basis not
//      VERIFIED. No signal is fabricated on an unconfirmed feed.
//   3. The response always carries the compile-time read-only safety envelope
//      (paper_only / liveLocked / readOnlyMode / allowOrderExecution:false) and
//      creates ZERO live/mt5 command rows — a drawing can never act.
//
// HOW THE VERIFIED BRANCH IS REACHED (deterministically, no real broker):
//   We push a clean, fresh, >=150-bar M5 candle window through the genuine MT5
//   bridge seam (updateCandlesFromMT5), which is FIRST in the forex router chain
//   so the push wins outright. source === "mt5_broker" → ohlcSourceType
//   "true_ohlc" → providerDeliversRealOhlc=true, satisfying the chart-truth +
//   handshake gates. The newest bar opens at the CURRENT bucket (trailing 0) so
//   feed quality resolves "clean" (aiUsable=true). The window is pushed WITH
//   an explicit MID price-basis declaration (these fixture closes are the
//   midpoint of the fixture quotes), and the test user's bridge identity, so
//   the served series is attributed
//   (provider + bridge + owner observed). A live quote straddling the newest
//   CLOSED bar is pushed by the SAME bridge with its own observed tick time, so
//   the per-user broker comparison is BOUND (brokerQuoteBinding.ts) and
//   actually measured, and the basis is VERIFIED. The user's spec row carries
//   no bid/ask here, so the bound live quote is the only thing that can pass.
//   An unbound quote (no observed tick time on the live quote; a stale
//   lastTickTime on the spec row) must leave the read non-VERIFIED.
//
// SAFETY / ISOLATION
//   - Seeds a single isolated system user (isSystemUser=true, fixed email) and
//     operates ONLY on that user's rows. Idempotent: cleans up specs, session,
//     and user at start and end, even on failure.
//   - Read-only: only the read-only POST /me/assistant/draw-setup endpoint is
//     called. Never places a trade, never inserts arx_live_commands, never
//     reaches the EA or a broker (asserted via a before/after command count).
//   - The candle "live feed" is injected via the same in-memory seam the real
//     MT5 bridge uses (updateCandlesFromMT5), a genuine real-data path — not
//     fabricated simulator OHLC.
//   - CI-safe / self-contained: spins up the REAL Express app in-process on an
//     ephemeral port. Set ARX_QA_BASE_URL to probe an already-running server
//     instead (note: the live-feed injection only applies in-process). Only
//     DATABASE_URL is required.
//
// Run: pnpm --filter @workspace/scripts run test:eleanor-draw-setup-route

import { projectionRoles } from "../../artifacts/api-server/src/lib/data/chart/renderEvidence.js";
import { randomBytes, createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { mt5PriceBasisEvidence } from "../../artifacts/api-server/src/lib/data/candlePriceBasisEvidence.js";
import type { Candle as BrokerCandle } from "../../artifacts/api-server/src/lib/data/types.js";
import {
  db,
  pool,
  usersTable,
  agentsTable,
  agentPredictionsTable,
  calibrationFitsTable,
  authUserSessionsTable,
  arxSymbolSpecsTable,
} from "@workspace/db";
import {
  updateCandlesFromMT5,
  updateQuoteFromMT5,
} from "../../artifacts/api-server/src/lib/data/providers/mt5Provider.js";
import {
  _setMarketProviderForTests,
  _resetMarketProviderForTests,
  type MarketProvider,
  type MarketQuote,
  type Candle,
} from "../../artifacts/api-server/src/lib/assistant/marketProvider.js";
import {
  getSharedBaseUrl,
  closeSharedServer,
  isEntrypoint,
  type CiTestResultLike,
} from "./ci/inProcessAppHarness.js";

import { invalidateAgentRegistrySnapshot } from "../../artifacts/api-server/src/lib/agentEcosystem/advisoryInfluence.js";
import { runCalibrationRefit } from "../../artifacts/api-server/src/lib/calibration/refitWorker.js";
const TEST_AGENT_KEY = "QA_ELEANOR_DRAW_RISK";
// Agent influence is earned only from the agent's own scored record
// (calibration engine, key agent:<agentKey>). The test agent gets a real,
// graded prediction record whose confidence predicts its outcomes, and the
// real refit turns it into measured influence. Without it, the agent has no
// record and, correctly, no influence.
const TEST_AGENT_FIT_KEY = `agent:${TEST_AGENT_KEY}|*|*`;
const TEST_AGENT_RECORD = 600;

const TEST_EMAIL = "qa+eleanor-draw-setup-route@arx.test";

// A forex symbol with a REAL pushed candle window → the only server-verifiable
// draw. Forex routes through [mt5_broker, assistant_real]; the mt5_broker seam is
// FIRST, so our push wins outright (deterministic even if assistant providers are
// configured in this env).
const VERIFIED_SYMBOL = "EURUSD";
// A symbol with NO feed pushed and no provider coverage → basis INSUFFICIENT →
// the gated draw. A clearly non-existent ticker so no real provider can serve it.
const GATED_SYMBOL = "ZZNOFEEDXX";
const TIMEFRAME = "M5";
const SIGNAL_TIMEFRAME = "M15";
const M5_MS = 5 * 60 * 1000;
// Comfortably above MIN_CANDLE_HISTORY_COUNT (150) for the M5 chart-truth gate.
const CANDLE_COUNT = 220;
// Synthetic bridge connection id for the test user's in-memory MT5 pushes
// (negative so it can never collide with a real bridge connection).
const TEST_BRIDGE_CONNECTION_ID = -385_001;

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
 * 5-minute bucket (trailing 0 → feed quality "clean" → aiUsable=true → VERIFIED).
 * A gentle persistent uptrend so the structural read is directional + clean,
 * yielding a drawable BUY setup. Equal candle ranges, zero gaps, valid OHLC — no
 * anomalies that would degrade the truth assessment below CLEAN.
 */
function buildCleanWindow(intervalMs = M5_MS): BrokerCandle[] {
  const out: BrokerCandle[] = [];
  const base = 1.1000;
  const stepUp = 0.00008; // gentle per-bar drift → directional, no spike anomaly
  const body = 0.00004;
  const wick = 0.00010;
  // Align the newest bar to the current 5-minute bucket so trailingIntervals === 0.
  const currentBucket = Math.floor(Date.now() / intervalMs) * intervalMs;
  const start = currentBucket - (CANDLE_COUNT - 1) * intervalMs;
  for (let i = 0; i < CANDLE_COUNT; i++) {
    const close = base + i * stepUp;
    const open = close - body;
    const high = close + wick;
    const low = open - wick;
    out.push({
      time: new Date(start + i * intervalMs).toISOString(),
      open: Number(open.toFixed(5)),
      high: Number(high.toFixed(5)),
      low: Number(low.toFixed(5)),
      close: Number(close.toFixed(5)),
      volume: 1000,
      // Explicit fixture producer metadata. Never infer this from forex or
      // the provider name: our quote builder intentionally straddles the close.
      priceBasisEvidence: mt5PriceBasisEvidence("mid"),
    });
  }
  return out;
}

// ── Task #389: prove a live scanner signal actually CHANGES the drawn setup ──
// The registry fixture has no measured out-of-sample skill, so it cannot confer
// governance authority. Exact-timeframe scanner risk independently flips the
// preview tradeable → caution while governanceOutcome honestly remains null.
// This is a read-only preview policy; no execution gate or order is invoked.

/**
 * A moderate bid/ask spread (0.0003 ≈ 27 spread-penalty points). Combined with
 * the choppy bias's +30, the scanner's riskScore lands at ~77 — in the RISK
 * agent's [70, 85) DOWNGRADE band, below the 85 rejection threshold. The live
 * scanner routes quotes mt5_broker-first, so the treatment's bound MT5 tick
 * carries this same spread (see pushBoundQuote).
 */
const CHOPPY_QUOTE: MarketQuote = {
  symbol: VERIFIED_SYMBOL,
  price: 1.1006,
  bid: 1.10045,
  ask: 1.10075,
  change: null,
  changePct: null,
  high: null,
  low: null,
  open: null,
  previousClose: null,
  asOf: new Date().toISOString(),
  freshness: "REALTIME",
  source: "qa-stub-scanner",
  stale: false,
};

/**
 * Build a deterministic in-memory MarketProvider that drives ONLY the assistant
 * live-scanner seam (getMarketProvider → scoreLiveCandidates). `candles`:
 *   - [] (empty)  → fewer than MIN_CANDLES → the scanner produces NO candidate
 *     (the no-signal control).
 *   - choppy window → the scanner ranks a real LOW-score candidate (treatment).
 * The VERIFIED chart basis is unaffected: it comes from the mt5_broker candle
 * push, which is first in the router chain and wins over this provider.
 */
function makeScannerProvider(candles: Candle[], quote: MarketQuote): MarketProvider {
  const provider = "qa-stub-scanner";
  return {
    name: provider,
    connected: true,
    features: { quotes: true, news: false, snapshots: false, economicCalendar: false, candles: true },
    getLiveQuote: async () => quote,
    getCandles: async (symbol: string, timeframe: string) => ({
      connected: true,
      source: provider,
      symbol,
      timeframe,
      candles,
      freshness: candles.length > 0 ? "REALTIME" : "UNAVAILABLE",
      asOf: candles.length > 0 ? candles[candles.length - 1]!.t : null,
    }),
    getMarketNews: async () => ({ connected: false, items: [], provider }),
    getEconomicCalendar: async () => ({ connected: false, events: [], provider }),
    getSymbolOverview: async (symbol: string) => ({ connected: false, symbol, description: null, provider }),
    getTradingSessionContext: async () => ({ connected: false, sessions: [], nowUtc: new Date().toISOString(), provider }),
  };
}

/** Per-user broker-truth spec row for a forex symbol (no EA quote). */
function specRow(userId: number, symbol: string) {
  return {
    userId,
    symbol,
    accountType: "demo",
    visible: true,
    tradeAllowed: true,
    tradeMode: "FULL",
    marketOpen: true,
    digits: 5,
    point: 0.00001,
    minVolume: 0.01,
    maxVolume: 100,
    volumeStep: 0.01,
    contractSize: 100000,
    tickSize: 0.00001,
    tickValue: 1,
    stopsLevelPoints: 0,
    spreadPoints: 0,
    category: "forex",
    displaySymbol: symbol,
  };
}

async function countCommands(): Promise<{ live: number; mt5: number }> {
  const live = await pool.query("SELECT COUNT(*)::int AS n FROM arx_live_commands");
  const mt5 = await pool.query("SELECT COUNT(*)::int AS n FROM mt5_commands");
  return { live: live.rows[0]?.n ?? 0, mt5: mt5.rows[0]?.n ?? 0 };
}

async function cleanupByEmail(): Promise<void> {
  // Restore the real market provider so no test state (the injected scanner
  // signal) leaks into the running process or subsequent suites (Task #389).
  _resetMarketProviderForTests();
  for (const a of await db.select({ id: agentsTable.id }).from(agentsTable).where(eq(agentsTable.agentKey, TEST_AGENT_KEY))) {
    await db.delete(agentPredictionsTable).where(eq(agentPredictionsTable.agentId, a.id));
  }
  await db.delete(calibrationFitsTable).where(eq(calibrationFitsTable.fitKey, TEST_AGENT_FIT_KEY));
  await db.delete(agentsTable).where(eq(agentsTable.agentKey, TEST_AGENT_KEY));
  invalidateAgentRegistrySnapshot();
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
  console.log("eleanorDrawSetupRouteTest");
  // eslint-disable-next-line no-console
  console.log("======================\n");

  await cleanupByEmail();

  // The in-process harness imports app.ts, not the boot seeder. Give the
  // real advisory/governance path an isolated active RISK participant.
  await db.insert(agentsTable).values({
    agentKey: TEST_AGENT_KEY, name: "QA risk advisory", role: "Risk advisory",
    department: "RISK", currentStatus: "ACTIVE", currentMode: "FULL",
    authorityWeight: 0.2, trustScore: 50, liveInfluenceAllowed: false,
  });
  {
    const [agent] = await db.select({ id: agentsTable.id }).from(agentsTable).where(eq(agentsTable.agentKey, TEST_AGENT_KEY));
    // Deterministic skilled record: P(win) rises with the stated confidence.
    let seed = 0x5eed;
    const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
    const t0 = Date.UTC(2026, 9, 1);
    const preds = Array.from({ length: TEST_AGENT_RECORD }, (_, i) => {
      const confidence = Math.round(rand() * 100);
      const win = rand() < 0.1 + 0.8 * (confidence / 100);
      return {
        predictionId: `qa-draw-risk-${i}-${randomBytes(4).toString("hex")}`,
        agentId: agent.id, symbol: VERIFIED_SYMBOL, timeframe: SIGNAL_TIMEFRAME,
        direction: i % 2 ? "BUY" : "SELL", decision: "approve", confidenceScore: confidence,
        outcomeStatus: win ? "WIN" : "LOSS", locked: true, timestampCreated: new Date(t0 + i * 60_000),
      };
    });
    await db.insert(agentPredictionsTable).values(preds);
    const refit = await runCalibrationRefit();
    assert(refit.errors.every((e) => !e.startsWith("agents")), `calibration refit read the agent record (errors: ${refit.errors.join("; ") || "none"})`);
  }
  invalidateAgentRegistrySnapshot();
  const baseUrl = await getSharedBaseUrl();

  // ── Seed isolated user + session ─────────────────────────────────────────
  const insertedUsers = await db.insert(usersTable).values({
    email: TEST_EMAIL,
    name: "QA Eleanor Draw-Setup Route",
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

  // ── Seed broker truth + inject the live feed for the verified symbol ──────
  // The newest bar is the forming candle; alignment compares the latest CLOSED
  // close against the broker mid, so straddle that close by one point.
  const cleanWindow = buildCleanWindow();
  const lastClosedClose = cleanWindow[cleanWindow.length - 2]!.close;
  const bridge = { bridgeConnectionId: TEST_BRIDGE_CONNECTION_ID, userId: user.id };
  await db.insert(arxSymbolSpecsTable).values([specRow(user.id, VERIFIED_SYMBOL)]);
  updateCandlesFromMT5(VERIFIED_SYMBOL, cleanWindow, TIMEFRAME, bridge);
  // A live tick from the SAME bridge, stamped with the producer's own tick
  // time. Re-pushed before each VERIFIED request (as a live EA keeps ticking)
  // so the quote stays inside the binding's freshness budget.
  // `halfSpread` defaults to one point; the scanner treatment (section 3)
  // widens it to CHOPPY_QUOTE's spread, because the live scanner reads the
  // quote through the mt5_broker-first router and so sees THIS quote.
  const pushQuote = (opts: { tickTimeObserved: boolean; halfSpread?: number }) => {
    const half = opts.halfSpread ?? 0.00001;
    updateQuoteFromMT5(VERIFIED_SYMBOL, {
      symbol: VERIFIED_SYMBOL,
      bid: Number((lastClosedClose - half).toFixed(6)),
      ask: Number((lastClosedClose + half).toFixed(6)),
      timestamp: new Date().toISOString(),
    }, bridge, { tickTimeObserved: opts.tickTimeObserved });
  };
  const pushBoundQuote = (halfSpread?: number) => pushQuote({ tickTimeObserved: true, halfSpread });

  // The dashboard's chart engine measures its own draw and reports it
  // (renderEvidenceReporter.ts); VERIFIED requires that measurement (owner
  // ruling 2026-11-09). Report what an exact draw of the SERVED series
  // measures: read the served source and newest bar the way the chart does.
  let lastRenderedState: any = null;
  const reportRender = async (override: Partial<Record<string, unknown>> = {}, timeframe: string = TIMEFRAME) => {
    const intel = await fetch(`${baseUrl}/api/me/chart/intelligence?symbol=${VERIFIED_SYMBOL}&timeframe=${timeframe}`, {
      headers: { cookie },
    }).then((r) => r.json()).catch(() => null) as any;
    const st = intel?.state;
    lastRenderedState = st;
    const newest = st?.currentCandle ?? st?.latestClosedCandle;
    const res = await fetch(`${baseUrl}/api/me/chart/render-evidence`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        symbol: VERIFIED_SYMBOL, timeframe, source: st?.truthState?.source ?? "none",
        displayMode: "ohlc", newestBarTime: newest ? Date.parse(newest.openTime) / 1000 : 1,
        barsCompared: cleanWindow.length, mismatchedBars: 0, droppedBars: 0,
        priceRoundTripOk: true, timeRoundTripOk: true, visibleBarsRoundTripped: Math.min(80, cleanWindow.length),
        drawings: { checked: 0, failed: 0, unplaced: 0, failedIds: [] }, projections: [], ...override,
      }),
    });
    return res.status;
  };

  const postJson = async (body: unknown) => {
    const res = await fetch(`${baseUrl}/api/me/assistant/draw-setup`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, json } as { status: number; json: any };
  };

  try {
    const cmdBefore = await countCommands();

    // ── 0. AUTH — the route is per-user gated (anon → 401, no draw). ─────────
    {
      const anon = await fetch(`${baseUrl}/api/me/assistant/draw-setup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ symbol: VERIFIED_SYMBOL, timeframe: TIMEFRAME, side: "BUY" }),
        redirect: "manual",
      });
      assert(anon.status === 401, `anon POST draw-setup → 401 (got ${anon.status})`);
    }

    // ── 1. VERIFIED feed → the route draws a real setup ─────────────────────
    // eslint-disable-next-line no-console
    console.log(`\nPOST draw-setup (${VERIFIED_SYMBOL}) — verified feed + bound quote, side BUY → drawable`);
    // ── 1a. No renderer measurement → never VERIFIED (all data gates pass). ──
    pushBoundQuote();
    const unrendered = await postJson({ symbol: VERIFIED_SYMBOL, timeframe: TIMEFRAME, side: "BUY" });
    assert(
      unrendered.json?.setupPreview?.dataFreshness?.basis !== "VERIFIED",
      `unrendered: no render evidence → not VERIFIED (got ${String(unrendered.json?.setupPreview?.dataFreshness?.basis)})`,
    );
    // ── 1b. A measured render mismatch → not VERIFIED. ─────────────────────
    assert((await reportRender({ mismatchedBars: 1 })) === 200, "render evidence (mismatch) accepted → 200");
    pushBoundQuote();
    const misdrawn = await postJson({ symbol: VERIFIED_SYMBOL, timeframe: TIMEFRAME, side: "BUY" });
    assert(
      misdrawn.json?.setupPreview?.dataFreshness?.basis !== "VERIFIED",
      `misdrawn: a drawn bar differs from the source → not VERIFIED (got ${String(misdrawn.json?.setupPreview?.dataFreshness?.basis)})`,
    );
    // ── 1c. Evidence for another source does not count. ─────────────────────
    assert((await reportRender({ source: "deriv" })) === 200, "render evidence (other source) accepted → 200");
    pushBoundQuote();
    const otherSource = await postJson({ symbol: VERIFIED_SYMBOL, timeframe: TIMEFRAME, side: "BUY" });
    assert(
      otherSource.json?.setupPreview?.dataFreshness?.basis !== "VERIFIED",
      `other-source render evidence → not VERIFIED (got ${String(otherSource.json?.setupPreview?.dataFreshness?.basis)})`,
    );

    // ── 1d. Exact draw of the served series measured → VERIFIED. ───────────
    assert((await reportRender()) === 200, "render evidence (exact draw) accepted → 200");
    assert(lastRenderedState?.brokerAlignment?.chartPriceBasis === "MID", "fixture producer MID declaration survives to route alignment");
    pushBoundQuote();
    const verified = await postJson({ symbol: VERIFIED_SYMBOL, timeframe: TIMEFRAME, side: "BUY" });
    assert(verified.status === 200, `verified HTTP 200 (got ${verified.status})`);
    const preview = verified.json?.setupPreview;
    assert(!!preview, "verified: setupPreview present");
    assert(
      preview?.dataFreshness?.basis === "VERIFIED",
      `verified: dataFreshness.basis === "VERIFIED" (got ${String(preview?.dataFreshness?.basis)})`,
    );
    assert(preview?.status === "preview", `verified: status === "preview" (got ${String(preview?.status)})`);
    assert(
      preview?.verdict === "tradeable" || preview?.verdict === "caution",
      `verified: verdict is drawable tradeable/caution (got ${String(preview?.verdict)})`,
    );
    const lv = preview?.levels;
    assert(lv != null, "verified: concrete levels drawn from real candles");
    assert(
      lv != null && preview?.side === "BUY" && lv.sl < lv.entry && lv.entry < lv.tp,
      lv ? `verified: BUY geometry honest (sl=${lv.sl} < entry=${lv.entry} < tp=${lv.tp})` : "verified: BUY geometry honest (no levels)",
    );

    // ── 1e. The drawn projection is checked against THIS issued payload. ────
    // The chart reports the setup levels as its engine holds them; exactly the
    // issued levels keep VERIFIED, a level drawn elsewhere fails the render.
    if (lv != null) {
      const drawnAt = (shift: number) => [...projectionRoles(lv)].map(([role, price]) => ({
        previewId: preview.previewId, symbol: VERIFIED_SYMBOL, timeframe: TIMEFRAME, role,
        price: role === "entry" ? price + shift : price, axisRoundTripOk: true,
      }));
      assert((await reportRender({ projections: drawnAt(0) })) === 200, "render evidence (exact projection) accepted → 200");
      pushBoundQuote();
      const exactProjection = await postJson({ symbol: VERIFIED_SYMBOL, timeframe: TIMEFRAME, side: "BUY" });
      assert(
        exactProjection.json?.setupPreview?.dataFreshness?.basis === "VERIFIED",
        `projection drawn at the issued levels → VERIFIED (got ${String(exactProjection.json?.setupPreview?.dataFreshness?.basis)})`,
      );
      assert((await reportRender({ projections: drawnAt(lv.entry * 1e-4) })) === 200, "render evidence (misplaced projection) accepted → 200");
      pushBoundQuote();
      const misplaced = await postJson({ symbol: VERIFIED_SYMBOL, timeframe: TIMEFRAME, side: "BUY" });
      assert(
        misplaced.json?.setupPreview?.dataFreshness?.basis !== "VERIFIED",
        `projection entry drawn off its issued price → not VERIFIED (got ${String(misplaced.json?.setupPreview?.dataFreshness?.basis)})`,
      );
      assert((await reportRender({ projections: [{ ...drawnAt(0)[0]!, previewId: "never-issued" }] })) === 200, "render evidence (unissued projection) accepted → 200");
      pushBoundQuote();
      const unissued = await postJson({ symbol: VERIFIED_SYMBOL, timeframe: TIMEFRAME, side: "BUY" });
      assert(
        unissued.json?.setupPreview?.dataFreshness?.basis !== "VERIFIED",
        `projection the server never issued → not VERIFIED (got ${String(unissued.json?.setupPreview?.dataFreshness?.basis)})`,
      );
      assert((await reportRender()) === 200, "render evidence (exact draw) restored → 200");
    }

    // The enriched signal fields must SURFACE in the envelope — present as keys,
    // each either a correctly-typed value or honestly null (never fabricated,
    // never dropped). This is the crux of Task #385: the scanner/scalp/governance
    // sources actually populate the response shape the client receives.
    const hasKey = (k: string) => preview != null && Object.prototype.hasOwnProperty.call(preview, k);
    assert(hasKey("scannerScore"), "verified: scannerScore key surfaces in the envelope");
    assert(hasKey("riskScore"), "verified: riskScore key surfaces in the envelope");
    assert(hasKey("flameStage"), "verified: flameStage key surfaces in the envelope");
    assert(hasKey("runOnQuality"), "verified: runOnQuality key surfaces in the envelope");
    assert(hasKey("governanceOutcome"), "verified: governanceOutcome key surfaces in the envelope");

    assert(
      preview?.scannerScore === null || typeof preview?.scannerScore === "number",
      `verified: scannerScore is number-or-null (got ${typeof preview?.scannerScore} = ${String(preview?.scannerScore)})`,
    );
    assert(
      preview?.riskScore === null || typeof preview?.riskScore === "number",
      `verified: riskScore is number-or-null (got ${typeof preview?.riskScore} = ${String(preview?.riskScore)})`,
    );
    assert(
      preview?.flameStage === null || typeof preview?.flameStage === "string",
      `verified: flameStage is string-or-null (got ${typeof preview?.flameStage} = ${String(preview?.flameStage)})`,
    );
    assert(
      preview?.runOnQuality === null ||
        preview?.runOnQuality === "strong" ||
        preview?.runOnQuality === "moderate" ||
        preview?.runOnQuality === "weak",
      `verified: runOnQuality is a band-or-null (got ${String(preview?.runOnQuality)})`,
    );
    assert(
      preview?.governanceOutcome === null || typeof preview?.governanceOutcome === "string",
      `verified: governanceOutcome is enum-or-null (got ${typeof preview?.governanceOutcome} = ${String(preview?.governanceOutcome)})`,
    );

    // The response must carry the compile-time read-only safety envelope.
    assert(verified.json?.safetyMode === "paper_only", `verified: safetyMode === "paper_only" (got ${String(verified.json?.safetyMode)})`);
    assert(verified.json?.liveLocked === true, "verified: liveLocked === true");
    assert(verified.json?.readOnlyMode === true, "verified: readOnlyMode === true");
    assert(verified.json?.allowOrderExecution === false, "verified: allowOrderExecution === false");

    // ── 2. GATED feed → the route refuses to draw, fabricates nothing ───────
    // eslint-disable-next-line no-console
    console.log(`\nPOST draw-setup (${GATED_SYMBOL}) — no feed → refused, no fabrication`);
    const gated = await postJson({ symbol: GATED_SYMBOL, timeframe: TIMEFRAME, side: "BUY" });
    assert(gated.status === 200, `gated HTTP 200 (got ${gated.status})`);
    const gatedPreview = gated.json?.setupPreview;
    assert(!!gatedPreview, "gated: setupPreview present");
    assert(
      gatedPreview?.dataFreshness?.basis !== "VERIFIED",
      `gated: basis is not VERIFIED (got ${String(gatedPreview?.dataFreshness?.basis)})`,
    );
    assert(gatedPreview?.verdict === "refused", `gated: verdict === "refused" (got ${String(gatedPreview?.verdict)})`);
    assert(gatedPreview?.levels === null, `gated: no fabricated levels (got ${gatedPreview?.levels === null ? "null" : "set"})`);
    assert(gatedPreview?.side === null, `gated: no side asserted (got ${String(gatedPreview?.side)})`);
    // A gated draw must never enrich — no real signal exists on an unconfirmed feed.
    assert(gatedPreview?.scannerScore === null, "gated: scannerScore null on unconfirmed feed");
    assert(gatedPreview?.riskScore === null, "gated: riskScore null on unconfirmed feed");
    assert(gatedPreview?.flameStage === null, "gated: flameStage null on unconfirmed feed");
    assert(gatedPreview?.runOnQuality === null, "gated: runOnQuality null on unconfirmed feed");
    assert(gatedPreview?.governanceOutcome === null, "gated: governanceOutcome null on unconfirmed feed");
    assert(gated.json?.allowOrderExecution === false, "gated: allowOrderExecution === false");

    // ── 3. A LIVE SCANNER SIGNAL DEMONSTRABLY CHANGES THE DRAWN SETUP ───────
    // The live scanner now reads the SAME router series as the chart (source
    // unification), ranks M15/H1 only, and its score labels ONLY its own
    // timeframe (setupSignals.selectScannerCandidate: no cross-timeframe
    // fallback). So this section draws on M15 from its own verified M15 series,
    // and the scanner's input is that same series plus the broker quote.
    // Control and treatment share the chart series, symbol and BUY request; the
    // ONLY difference is the broker's quoted spread, which the scanner's
    // riskScore reads (riskScore = 20 + spreadPenalty, liveScanner.ts). A wide
    // spread puts risk in the [70, 85) caution band. The deterministic preview
    // safety policy acts even when no agent has earned measured authority.
    // The live scanner runs only while the assistant's market-data adapter is
    // connected; this connected stub serves NO candles of its own, so every
    // scanned bar comes from the router's MT5 series above.
    _setMarketProviderForTests(makeScannerProvider([], CHOPPY_QUOTE));
    updateCandlesFromMT5(VERIFIED_SYMBOL, buildCleanWindow(15 * 60_000), SIGNAL_TIMEFRAME, bridge);
    assert((await reportRender({}, SIGNAL_TIMEFRAME)) === 200, "render evidence (M15 exact draw) accepted → 200");

    // Control — tight one-point spread: a populated, low-risk candidate.
    // eslint-disable-next-line no-console
    console.log(`\nPOST draw-setup (${VERIFIED_SYMBOL} ${SIGNAL_TIMEFRAME}) — control: tight spread`);
    pushBoundQuote();
    const control = await postJson({ symbol: VERIFIED_SYMBOL, timeframe: SIGNAL_TIMEFRAME, side: "BUY" });
    assert(control.status === 200, `control HTTP 200 (got ${control.status})`);
    const controlPreview = control.json?.setupPreview;
    assert(!!controlPreview, "control: setupPreview present");
    assert(
      controlPreview?.dataFreshness?.basis === "VERIFIED",
      `control: basis VERIFIED from the measured M15 chart (got ${String(controlPreview?.dataFreshness?.basis)})`,
    );
    assert(
      typeof controlPreview?.scannerScore === "number",
      `control: scannerScore populated from the same series (got ${String(controlPreview?.scannerScore)})`,
    );
    assert(
      typeof controlPreview?.riskScore === "number" && controlPreview.riskScore < 70,
      `control: riskScore below the downgrade band (got ${String(controlPreview?.riskScore)})`,
    );
    assert(controlPreview?.governanceOutcome !== "downgraded", `control: not downgraded (got ${String(controlPreview?.governanceOutcome)})`);
    assert(controlPreview?.verdict === "tradeable", `control: verdict tradeable on the clean uptrend (got ${String(controlPreview?.verdict)})`);

    // Treatment — the broker quotes a 6-pip spread (still centred on the
    // closed close, so the broker comparison stays bound): spreadPenalty ≈ 55,
    // riskScore ≈ 75.
    // eslint-disable-next-line no-console
    console.log(`\nPOST draw-setup (${VERIFIED_SYMBOL} ${SIGNAL_TIMEFRAME}) — treatment: wide broker spread`);
    pushBoundQuote(0.0003);
    const treatment = await postJson({ symbol: VERIFIED_SYMBOL, timeframe: SIGNAL_TIMEFRAME, side: "BUY" });
    assert(treatment.status === 200, `treatment HTTP 200 (got ${treatment.status})`);
    const treatmentPreview = treatment.json?.setupPreview;
    assert(!!treatmentPreview, "treatment: setupPreview present");
    assert(
      treatmentPreview?.dataFreshness?.basis === "VERIFIED",
      `treatment: basis still VERIFIED from the chart feed (got ${String(treatmentPreview?.dataFreshness?.basis)})`,
    );
    assert(
      typeof treatmentPreview?.scannerScore === "number" && Number.isFinite(treatmentPreview?.scannerScore),
      `treatment: scannerScore is a populated number (got ${typeof treatmentPreview?.scannerScore} = ${String(treatmentPreview?.scannerScore)})`,
    );
    assert(
      typeof treatmentPreview?.riskScore === "number" &&
        treatmentPreview.riskScore >= 70 && treatmentPreview.riskScore < 85,
      `treatment: riskScore in the RISK DOWNGRADE band [70,85) (got ${String(treatmentPreview?.riskScore)})`,
    );
    assert(
      treatmentPreview?.governanceOutcome === null,
      `treatment: unmeasured agent gets no fabricated governance authority (got ${String(treatmentPreview?.governanceOutcome)})`,
    );
    assert(treatmentPreview?.explanation?.some((line: string) => line.includes("scanner reports elevated risk")), "treatment: deterministic scanner risk caution is explained");
    assert(treatmentPreview?.verdict === "caution", `treatment: verdict caution (got ${String(treatmentPreview?.verdict)})`);
    assert(
      controlPreview?.verdict === "tradeable" && treatmentPreview?.verdict === "caution",
      `signal changes the setup: verdict tradeable→caution (control=${String(controlPreview?.verdict)}, treatment=${String(treatmentPreview?.verdict)})`,
    );

    // Restore the real provider for the side-effect tally below.
    _resetMarketProviderForTests();

    // ── 3b. UNBOUND quote → never VERIFIED (fail closed) ─────────────────────
    // Same attributed, clean feed and the SAME straddling numbers, but no
    // quote is bound: the live tick carries no observed tick time, and the
    // spec row's EA quote (same bridge, same owner) is stale. Numbers alone
    // cannot measure the broker comparison, so the read must not be VERIFIED.
    // eslint-disable-next-line no-console
    console.log(`\nPOST draw-setup (${VERIFIED_SYMBOL}) — unbound broker quote → not VERIFIED`);
    pushQuote({ tickTimeObserved: false });
    await db.update(arxSymbolSpecsTable).set({
      bid: lastClosedClose - 0.00001,
      ask: lastClosedClose + 0.00001,
      bridgeConnectionId: TEST_BRIDGE_CONNECTION_ID,
      lastTickTime: new Date(Date.now() - 120_000),
    }).where(eq(arxSymbolSpecsTable.userId, user.id));
    const unbound = await postJson({ symbol: VERIFIED_SYMBOL, timeframe: TIMEFRAME, side: "BUY" });
    assert(unbound.status === 200, `unbound HTTP 200 (got ${unbound.status})`);
    const unboundPreview = unbound.json?.setupPreview;
    assert(!!unboundPreview, "unbound: setupPreview present");
    assert(
      unboundPreview?.dataFreshness?.basis !== "VERIFIED",
      `unbound: basis is not VERIFIED (got ${String(unboundPreview?.dataFreshness?.basis)})`,
    );
    assert(unboundPreview?.verdict === "refused", `unbound: verdict === "refused" (got ${String(unboundPreview?.verdict)})`);
    assert(unboundPreview?.levels === null, `unbound: no levels drawn (got ${unboundPreview?.levels === null ? "null" : "set"})`);
    assert(unbound.json?.allowOrderExecution === false, "unbound: allowOrderExecution === false");
    // Binding was the ONLY difference: the same feed with a bound tick from
    // the same bridge is VERIFIED again (the stale spec row is not used).
    pushBoundQuote();
    const rebound = await postJson({ symbol: VERIFIED_SYMBOL, timeframe: TIMEFRAME, side: "BUY" });
    assert(
      rebound.json?.setupPreview?.dataFreshness?.basis === "VERIFIED",
      `rebound: bound tick restores VERIFIED (got ${String(rebound.json?.setupPreview?.dataFreshness?.basis)})`,
    );

    // ── 3c. Withdraw only the original producer price-basis declaration. ────
    // Keep the same candles, bound quote and exact render. Cached numbers or
    // an old declaration must not establish the new series' original basis.
    // Wait for the documented 3-second cache rather than bypassing its gate.
    updateCandlesFromMT5(VERIFIED_SYMBOL, cleanWindow.map((bar) => ({ ...bar, priceBasisEvidence: undefined })), TIMEFRAME, bridge);
    await delay(3_100);
    assert((await reportRender()) === 200, "render evidence (undeclared series) accepted → 200");
    assert(lastRenderedState?.brokerAlignment?.chartPriceBasis === "UNKNOWN", "numeric-only fixture retains UNKNOWN price basis");
    pushBoundQuote();
    const undeclared = await postJson({ symbol: VERIFIED_SYMBOL, timeframe: TIMEFRAME, side: "BUY" });
    assert(undeclared.json?.setupPreview?.dataFreshness?.basis !== "VERIFIED", "undeclared basis: bound quote and exact render still cannot establish VERIFIED");
    assert(undeclared.json?.setupPreview?.levels === null, "undeclared basis: no levels invented");

    // ── 4. NO LIVE SIDE EFFECTS — a drawing can never act ───────────────────
    const cmdAfter = await countCommands();
    assert(cmdAfter.live === cmdBefore.live, "no live side effects: arx_live_commands unchanged");
    assert(cmdAfter.mt5 === cmdBefore.mt5, "no live side effects: mt5_commands unchanged");
  } finally {
    await cleanupByEmail();
  }

  // eslint-disable-next-line no-console
  console.log(`\nResult: ${passes} passed, ${failures} failed`);
  return { name: "eleanorDrawSetupRouteTest", passes, failures };
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
      console.error("[eleanorDrawSetupRouteTest] FAILED:", err);
      process.exit(1);
    },
  );
}
