// Test: the scalp "flame" read survives the REAL candle-fetch + HTTP API path.
//
// Engine unit tests already pin the flame math. This test proves the flame
// object is well-formed AND honest across the genuine service/endpoint path —
// the actual Express routes, the real market-data router, the real per-user
// spec loader, and the real candle window fetch — for the three scalp surfaces:
//
//   - POST /api/me/scalp/focus  (deep, per-symbol candle-backed read)
//   - POST /api/me/scalp/rank   (Broad scan: best/safer/fastest + ranked list)
//   - POST /api/me/scalp/build  (Ruby Scalp Builder)
//
// WHAT IT PROVES
//   1. LIVE-DATA case (flame.blind === false): Focus on a symbol with a REAL
//      pushed candle window (via the genuine mt5Provider injection seam the EA
//      bridge uses) returns a fully-formed flame whose `blind` is false. This is
//      the only path that fetches a per-symbol candle window, so it is the only
//      one that can legitimately be non-blind.
//   2. AWAITING-DATA case (flame.blind === true): Focus on a symbol that has a
//      real quote but NO live candle feed (so the scanner falls back to the
//      SIMULATOR) returns a well-formed flame whose `blind` is true — proving a
//      simulator/non-live read NEVER promotes the flame to non-blind.
//   3. NO-FABRICATION on the hot path: Broad + Builder evaluate the same live
//      EURUSD that produced a non-blind Focus flame, yet they intentionally do
//      NOT re-fetch a per-symbol candle window (rate-limit guard), so EVERY
//      flame they return is honestly blind. We assert the only non-blind flame
//      anywhere in the run is the Focus live read.
//   4. SHAPE: every returned flame carries all required keys with valid enum
//      values (a contract guard against a future refactor dropping a field or
//      emitting an off-contract enum through the API projection).
//
// SAFETY / ISOLATION
//   - Seeds a single isolated system user (isSystemUser=true, fixed email) and
//     operates ONLY on that user's rows. Idempotent: cleans up specs, session,
//     and user at start and end, even on failure.
//   - Read-only against the trade surfaces: only the scalp READ endpoints are
//     called (focus/rank/build). Never places a trade, never inserts
//     arx_live_commands, never reaches the EA or a broker.
//   - The candle/quote "live feed" is injected via the same in-memory seam the
//     real MT5 bridge uses (updateCandlesFromMT5 / updateQuoteFromMT5). It is a
//     genuine real-data path, not fabricated simulator OHLC.
//   - CI-safe / self-contained: spins up the REAL Express app in-process on an
//     ephemeral port. Set ARX_QA_BASE_URL to probe an already-running server
//     instead (note: the live-feed injection only applies in-process). Only
//     DATABASE_URL is required.
//
// Run: pnpm --filter @workspace/scripts run test:scalp-flame-endpoint

import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  db,
  usersTable,
  authUserSessionsTable,
  arxSymbolSpecsTable,
} from "@workspace/db";
import app from "../../artifacts/api-server/src/app.js";
import {
  updateCandlesFromMT5,
  updateQuoteFromMT5,
} from "../../artifacts/api-server/src/lib/data/providers/mt5Provider.js";

const EXTERNAL_BASE = process.env["ARX_QA_BASE_URL"];
const TEST_EMAIL = "qa+scalp-flame-endpoint@arx.test";

// Symbol with a REAL pushed candle window (>= MIN_FLAME_CANDLES) shaped as a
// long unbroken run → a legitimately non-blind read that the engine honestly
// reads as overextended/non-actionable (proves blind === false, but NOT the
// fresh-ignition branch).
//
// MUST be news-immune for determinism: the engine's NEWS_DANGER veto turns a
// focus read BLIND, but it fires ONLY when scanner newsRisk === "HIGH"
// (scalpEngine.ts; MEDIUM merely trims quality, LOW/none never veto). That risk
// is scored from the ONE real economic-calendar seam (getNewsIntelligence →
// getEconomicCalendar) plus the Market Impact Radar escalation off the SAME real
// snapshot — NOT a built-in mock schedule. THIS environment runs a real provider
// (FRED). Every HIGH-impact event FRED classifies is a US release → currency
// "USD" (its sole non-USD mapping is a LOW-impact €STR, which can never escalate
// to a HIGH veto). The radar/base scorer match an event onto a symbol BY
// CURRENCY, so EVERY pair containing USD (the earlier USDCHF/NZDUSD/AUDUSD picks
// all do) got escalated to HIGH whenever a USD release fell in the window and was
// vetoed date-dependently — that was the flakiness. EURGBP contains NO USD, so it
// shares no currency with any HIGH-impact event this calendar can produce →
// newsRisk can never reach HIGH → never vetoed. When no provider is configured
// (e.g. plain CI) the seam reports disconnected → no events → "none" for every
// symbol. Either way the read is deterministic, with no weakening of the
// production news gate (its own behaviour is covered by scalpEngine's tests).
// (A synthetic name that isSyntheticInstrument() recognises — BOOM/CRASH/JUMP/1S
// forms — would hard-short-circuit news entirely and survive any future provider
// swap; non-USD forex is the lower-risk pick that keeps forex specs/scale.)
const LIVE_SYMBOL = "EURGBP";
// Symbol with a REAL pushed candle window shaped as a fresh momentum burst (a
// flat base then a 2-candle ignition) → a non-blind read the engine reads as an
// ACTIONABLE flame: IGNITING/ACTIVE stage, a real BUY readDirection, and a
// positive scalpScore. EURJPY is a forex-major and so IS in the Broad/Builder
// forex universe; in the rank/build scans it appears only as a BLIND read
// (candles omitted there), which the blind invariant already covers. Like
// EURGBP it contains NO USD, so no HIGH-impact event this env's calendar (FRED,
// US-only at HIGH impact) can produce will ever match it → news-immune, never
// flaky.
const ACTIONABLE_SYMBOL = "EURJPY";
// Symbol with a REAL but sub-threshold candle window (< MIN_FLAME_CANDLES) → the
// engine's flame read is honestly BLIND. We push this window through the same
// mt5_broker seam, which is FIRST in the router chain, so the real fetch returns
// exactly our short window with zero external-provider interference (this env
// has live TwelveData/Polygon forex feeds, so a "no-push" symbol would be served
// real candles non-deterministically). AUDUSD is a forex-major and so IS in the
// Broad/Builder forex universe, but with a sub-threshold window it stays AWAITING
// (filtered) in the rank/build scans, so it never disturbs them.
const AWAITING_SYMBOL = "AUDUSD";
// The flame read is BLIND below this many candles (mirrors MIN_FLAME_CANDLES in
// flameRead.ts). We push fewer than this to force the honest awaiting/blind read.
const MIN_FLAME_CANDLES = 5;

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

// ── Flame contract: required keys + valid enum domains ───────────────────────
const FLAME_ENUMS: Record<string, readonly string[]> = {
  scalpStatus: ["STRONG", "POSSIBLE", "WEAK", "NOT_A_SCALP"],
  readDirection: ["BUY", "SELL", "WAIT", "MIXED", "NO_SCALP"],
  flameStage: ["IGNITING", "ACTIVE", "RUN_ON", "STRETCH", "WEAKENING", "EXHAUSTED", "FAILED", "REVERSAL_RISK", "NONE"],
  freshness: ["FRESH", "ACTIVE", "LATE", "EXPIRED"],
  entryTiming: ["EARLY", "CLEAN", "ACCEPTABLE", "LATE", "CHASING", "NO_ENTRY"],
  chaseRisk: ["LOW", "MEDIUM", "HIGH", "EXTREME"],
  runway: ["CLEAR", "MODERATE", "TIGHT", "NONE"],
  executionQuality: ["EXCELLENT", "GOOD", "FAIR", "POOR", "BLOCKED"],
  htfContext: ["ALIGNED", "COUNTER_TREND", "NEUTRAL", "UNKNOWN"],
  setupType: ["BREAKOUT", "RETEST", "CONTINUATION", "REJECTION", "REVERSAL", "EXHAUSTION", "LIQUIDITY_SWEEP", "FAILED_BREAKOUT", "PULLBACK", "NO_SCALP"],
  riskPersonality: ["CONSERVATIVE", "BALANCED", "AGGRESSIVE", "OWNER_ADMIN"],
};
const NULLABLE_STRING_KEYS = ["whyNow", "entryTrigger", "targetIdea", "invalidationIdea", "decayNote"] as const;

/** Validate one flame object is fully well-formed; returns true on success. */
function assertWellFormedFlame(flame: unknown, ctx: string): boolean {
  if (!flame || typeof flame !== "object") {
    assert(false, `${ctx}: flame is a present object`);
    return false;
  }
  const f = flame as Record<string, unknown>;
  let ok = true;
  for (const [key, domain] of Object.entries(FLAME_ENUMS)) {
    const valid = typeof f[key] === "string" && domain.includes(f[key] as string);
    if (!valid) ok = false;
    assert(valid, `${ctx}: ${key}="${String(f[key])}" is a valid enum`);
  }
  const scoreOk = typeof f["scalpScore"] === "number" && Number.isFinite(f["scalpScore"]) && (f["scalpScore"] as number) >= 0 && (f["scalpScore"] as number) <= 100;
  if (!scoreOk) ok = false;
  assert(scoreOk, `${ctx}: scalpScore is a finite 0..100 number (got ${String(f["scalpScore"])})`);

  const ageOk = typeof f["flameAgeCandles"] === "number" && Number.isInteger(f["flameAgeCandles"]) && (f["flameAgeCandles"] as number) >= 0;
  if (!ageOk) ok = false;
  assert(ageOk, `${ctx}: flameAgeCandles is a non-negative integer (got ${String(f["flameAgeCandles"])})`);

  for (const key of NULLABLE_STRING_KEYS) {
    const v = f[key];
    const valid = v === null || typeof v === "string";
    if (!valid) ok = false;
    assert(valid, `${ctx}: ${key} is string|null`);
  }
  const blindOk = typeof f["blind"] === "boolean";
  if (!blindOk) ok = false;
  assert(blindOk, `${ctx}: blind is a boolean (got ${typeof f["blind"]})`);
  return ok;
}

/**
 * A clean, steady ~0.8% uptrend with equal candle ranges and zero spread.
 * Drives the scanner to a high-confidence BUY (all 5 rules pass) so the engine
 * reaches the full candle-backed flame read (non-blind) on the Focus path.
 */
function buildUptrendCandles(): Array<{ time: string; open: number; high: number; low: number; close: number; volume: number }> {
  const out: Array<{ time: string; open: number; high: number; low: number; close: number; volume: number }> = [];
  const base = 1.1000;
  const stepUp = 0.0003;     // per-candle close increase → ~0.8% total drift
  const body = 0.0002;       // bullish body
  const wick = 0.0004;       // symmetric wick → constant range 0.0010 for all
  const start = Date.now() - 30 * 5 * 60 * 1000;
  for (let i = 0; i < 30; i++) {
    const close = base + i * stepUp;
    const open = close - body;
    const high = close + wick;
    const low = open - wick;
    out.push({
      time: new Date(start + i * 5 * 60 * 1000).toISOString(),
      open: Number(open.toFixed(5)),
      high: Number(high.toFixed(5)),
      low: Number(low.toFixed(5)),
      close: Number(close.toFixed(5)),
      volume: 1000,
    });
  }
  return out;
}

/**
 * A fresh ignition: a gentle uptrend that flattens into a base, then a clean
 * 2-candle momentum burst to a new extreme. The full 30-candle window keeps the
 * scanner in a high-confidence BUY (clear positive drift, in-range volatility,
 * tight spread → all 5 rules pass), while the last 14 candles (the flame window)
 * read as a fresh burst: flame age 2, low extension (~1.7 ATR), a new window
 * extreme, an expanding body, and a strong close. The engine therefore reaches
 * an ACTIONABLE flame — IGNITING stage, BUY readDirection, positive scalpScore —
 * the fresh-ignition branch the long-run LIVE_SYMBOL case never exercises.
 */
function buildActionableFlameCandles(): Array<{ time: string; open: number; high: number; low: number; close: number; volume: number }> {
  const out: Array<{ time: string; open: number; high: number; low: number; close: number; volume: number }> = [];
  const base = 1.10000;
  const riseStep = 0.0001;    // candles 0..15 rise → clear positive scanner drift
  const burstStep = 0.0005;   // candles 28,29 each step up → fresh 2-candle flame
  const wickRise = 0.00025;   // rise-candle wick → range 0.0006
  const wickFlat = 0.0003;    // flat-base wick → range 0.0006 (keeps ATR healthy)
  const wickBurst = 0.00006;  // small burst wick → strong close, tiny opposing tail
  const plateau = base + 15 * riseStep; // base of the flame window
  const start = Date.now() - 30 * 5 * 60 * 1000;
  for (let i = 0; i < 30; i++) {
    let open: number, high: number, low: number, close: number;
    if (i <= 15) {
      // Rising lead-in (outside the 14-candle flame window).
      close = base + i * riseStep;
      open = close - riseStep; // bullish body
      high = close + wickRise;
      low = open - wickRise;
    } else if (i <= 27) {
      // Flat base: no trailing run, so the flame age resets here.
      close = plateau;
      open = plateau;
      high = plateau + wickFlat;
      low = plateau - wickFlat;
    } else {
      // Fresh 2-candle ignition to a new extreme.
      const steps = i - 27; // 28 → 1, 29 → 2
      close = plateau + steps * burstStep;
      open = plateau + (steps - 1) * burstStep; // previous close → body = burstStep
      high = close + wickBurst;
      low = open - wickBurst;
    }
    out.push({
      time: new Date(start + i * 5 * 60 * 1000).toISOString(),
      open: Number(open.toFixed(5)),
      high: Number(high.toFixed(5)),
      low: Number(low.toFixed(5)),
      close: Number(close.toFixed(5)),
      volume: 1000,
    });
  }
  return out;
}

/** Full broker-truth spec row for a forex symbol (lets the engine size honestly). */
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
    spreadPoints: 8,
    category: "forex",
    displaySymbol: symbol,
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

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log("scalpFlameEndpointTest");
  // eslint-disable-next-line no-console
  console.log("======================\n");

  await cleanupByEmail();

  // ── Resolve a base URL: in-process ephemeral server (CI-safe) unless an
  //    external server URL was supplied via ARX_QA_BASE_URL. ────────────────
  let server: Server | null = null;
  let baseUrl: string;
  if (EXTERNAL_BASE) {
    baseUrl = EXTERNAL_BASE;
    // eslint-disable-next-line no-console
    console.log(`[setup] probing external server at ${baseUrl}`);
    // eslint-disable-next-line no-console
    console.log("[setup] NOTE: the live-feed injection only applies in-process.\n");
  } else {
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
    // eslint-disable-next-line no-console
    console.log(`[setup] in-process app listening on ${baseUrl}\n`);
  }
  const closeServer = async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  };

  // ── Seed isolated user + session ─────────────────────────────────────────
  const insertedUsers = await db.insert(usersTable).values({
    email: TEST_EMAIL,
    name: "QA Scalp Flame Endpoint",
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

  // ── Seed per-user broker truth for both symbols ──────────────────────────
  await db.insert(arxSymbolSpecsTable).values([
    specRow(user.id, LIVE_SYMBOL),
    specRow(user.id, ACTIONABLE_SYMBOL),
    specRow(user.id, AWAITING_SYMBOL),
  ]);

  // ── Inject the live feed via the genuine MT5 bridge seam ─────────────────
  // LIVE_SYMBOL: real candle window + quote → eligible for a non-blind flame.
  const candles = buildUptrendCandles();
  const lastClose = candles[candles.length - 1]!.close;
  updateCandlesFromMT5(LIVE_SYMBOL, candles);
  updateQuoteFromMT5(LIVE_SYMBOL, {
    symbol: LIVE_SYMBOL,
    last: lastClose,
    bid: Number((lastClose - 0.00004).toFixed(5)),
    ask: Number((lastClose + 0.00004).toFixed(5)),
    timestamp: new Date().toISOString(),
  });
  // ACTIONABLE_SYMBOL: a REAL candle window shaped as a fresh momentum burst →
  // eligible for an ACTIONABLE non-blind flame (IGNITING/ACTIVE + BUY).
  const actionableCandles = buildActionableFlameCandles();
  const actionableLast = actionableCandles[actionableCandles.length - 1]!.close;
  updateCandlesFromMT5(ACTIONABLE_SYMBOL, actionableCandles);
  updateQuoteFromMT5(ACTIONABLE_SYMBOL, {
    symbol: ACTIONABLE_SYMBOL,
    last: actionableLast,
    bid: Number((actionableLast - 0.00004).toFixed(5)),
    ask: Number((actionableLast + 0.00004).toFixed(5)),
    timestamp: new Date().toISOString(),
  });
  // AWAITING_SYMBOL: a REAL but sub-threshold candle window (< MIN_FLAME_CANDLES)
  // pushed through the same mt5_broker seam. The real candle fetch returns
  // exactly these candles, so the engine's flame read MUST be honestly blind
  // (the candle window is too short to read a flame) — proving the genuine
  // data path never promotes an insufficient window to a non-blind flame.
  const shortCandles = candles.slice(0, MIN_FLAME_CANDLES - 1); // 4 real candles
  const awaitingLast = shortCandles[shortCandles.length - 1]!.close;
  updateCandlesFromMT5(AWAITING_SYMBOL, shortCandles);
  updateQuoteFromMT5(AWAITING_SYMBOL, {
    symbol: AWAITING_SYMBOL,
    last: awaitingLast,
    bid: Number((awaitingLast - 0.00004).toFixed(5)),
    ask: Number((awaitingLast + 0.00004).toFixed(5)),
    timestamp: new Date().toISOString(),
  });

  const postJson = async (path: string, body: unknown) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, json } as { status: number; json: any };
  };

  // Track: the ONLY non-blind flame allowed in the whole run is the Focus live read.
  let nonBlindCount = 0;
  const countFlame = (flame: any) => {
    if (flame && flame.blind === false) nonBlindCount++;
  };

  // ── 1. Focus — LIVE data → flame present, well-formed, blind === false ────
  // eslint-disable-next-line no-console
  console.log(`POST /api/me/scalp/focus (${LIVE_SYMBOL}) — live candle window → non-blind flame`);
  const focusLive = await postJson("/api/me/scalp/focus", { symbol: LIVE_SYMBOL });
  assert(focusLive.status === 200, `focus(live) HTTP 200 (got ${focusLive.status})`);
  const liveFlame = focusLive.json?.flame;
  assertWellFormedFlame(liveFlame, "focus(live)");
  assert(liveFlame?.blind === false, `focus(live): flame.blind === false (got ${String(liveFlame?.blind)})`);
  // The flame age proves the REAL candle window was actually consumed and
  // analyzed (a blind read reports age 0). A non-blind read need not be
  // actionable — here a long unbroken run reads as overextended — but it MUST
  // reflect genuine candle analysis.
  assert(
    typeof liveFlame?.flameAgeCandles === "number" && liveFlame.flameAgeCandles >= 1,
    `focus(live): real candle window was consumed (flameAgeCandles >= 1, got ${String(liveFlame?.flameAgeCandles)})`,
  );
  countFlame(liveFlame);

  // ── 1b. Focus — ACTIONABLE flame → non-blind AND fresh-ignition branch ────
  // A fresh momentum burst (flat base + 2-candle ignition) drives the engine to
  // its ACTIONABLE flame branch: an IGNITING/ACTIVE stage, a real BUY
  // readDirection, and a positive scalpScore. This is the branch the long-run
  // LIVE_SYMBOL case (read as overextended) never exercises.
  // eslint-disable-next-line no-console
  console.log(`\nPOST /api/me/scalp/focus (${ACTIONABLE_SYMBOL}) — fresh momentum burst → actionable flame`);
  const focusAction = await postJson("/api/me/scalp/focus", { symbol: ACTIONABLE_SYMBOL });
  assert(focusAction.status === 200, `focus(actionable) HTTP 200 (got ${focusAction.status})`);
  const actionFlame = focusAction.json?.flame;
  assertWellFormedFlame(actionFlame, "focus(actionable)");
  assert(actionFlame?.blind === false, `focus(actionable): flame.blind === false (got ${String(actionFlame?.blind)})`);
  assert(
    actionFlame?.flameStage === "IGNITING" || actionFlame?.flameStage === "ACTIVE",
    `focus(actionable): a fresh burst reads as IGNITING/ACTIVE (got ${String(actionFlame?.flameStage)})`,
  );
  assert(
    actionFlame?.readDirection === "BUY",
    `focus(actionable): actionable read carries a real BUY direction (got ${String(actionFlame?.readDirection)})`,
  );
  assert(
    typeof actionFlame?.scalpScore === "number" && actionFlame.scalpScore > 0,
    `focus(actionable): actionable read carries a positive scalpScore (got ${String(actionFlame?.scalpScore)})`,
  );
  countFlame(actionFlame);

  // ── 2. Focus — AWAITING data → flame present, well-formed, blind === true ─
  // eslint-disable-next-line no-console
  console.log(`\nPOST /api/me/scalp/focus (${AWAITING_SYMBOL}) — sub-threshold real candle window → blind flame`);
  const focusAwait = await postJson("/api/me/scalp/focus", { symbol: AWAITING_SYMBOL });
  assert(focusAwait.status === 200, `focus(awaiting) HTTP 200 (got ${focusAwait.status})`);
  const awaitFlame = focusAwait.json?.flame;
  assertWellFormedFlame(awaitFlame, "focus(awaiting)");
  assert(awaitFlame?.blind === true, `focus(awaiting): flame.blind === true (got ${String(awaitFlame?.blind)})`);
  assert(
    awaitFlame?.flameStage === "NONE",
    `focus(awaiting): a blind read keeps flameStage NONE (got ${String(awaitFlame?.flameStage)})`,
  );
  countFlame(awaitFlame);

  // ── 3. Broad (rank) — hot path never re-fetches candles → every flame blind
  // eslint-disable-next-line no-console
  console.log("\nPOST /api/me/scalp/rank (forex) — Broad hot path → every returned flame is blind");
  const rank = await postJson("/api/me/scalp/rank", { marketGroup: "forex", limit: 20 });
  assert(rank.status === 200, `rank HTTP 200 (got ${rank.status})`);
  const rankResult = rank.json ?? {};
  const rankReads: any[] = [
    ...(Array.isArray(rankResult.opportunities) ? rankResult.opportunities : []),
    rankResult.best,
    rankResult.safer,
    rankResult.fastest,
  ].filter(Boolean);
  assert(typeof rankResult.scanned === "number", `rank: scanned is a number (got ${String(rankResult.scanned)})`);
  assert(rankReads.length > 0, `rank: returned at least one actionable read with live ${LIVE_SYMBOL} in the universe (got ${rankReads.length})`);
  let rankBlindOk = true;
  for (let i = 0; i < rankReads.length; i++) {
    const r = rankReads[i];
    const formed = assertWellFormedFlame(r?.flame, `rank[#${i} ${String(r?.symbol)}]`);
    if (!formed || r?.flame?.blind !== true) rankBlindOk = false;
    countFlame(r?.flame);
  }
  assert(rankBlindOk, "rank: EVERY returned flame is blind (Broad never fabricates a non-blind flame, even for live EURUSD)");

  // ── 4. Builder (build) — same hot path → every flame blind ───────────────
  // eslint-disable-next-line no-console
  console.log("\nPOST /api/me/scalp/build (forex) — Builder hot path → every returned flame is blind");
  const build = await postJson("/api/me/scalp/build", { marketGroup: "forex" });
  assert(build.status === 200, `build HTTP 200 (got ${build.status})`);
  const buildResult = build.json ?? {};
  const buildReads: any[] = [
    buildResult.primary,
    ...(Array.isArray(buildResult.alternatives) ? buildResult.alternatives : []),
  ].filter(Boolean);
  assert(typeof buildResult.scanned === "number", `build: scanned is a number (got ${String(buildResult.scanned)})`);
  let buildBlindOk = true;
  for (let i = 0; i < buildReads.length; i++) {
    const r = buildReads[i];
    const formed = assertWellFormedFlame(r?.flame, `build[#${i} ${String(r?.symbol)}]`);
    if (!formed || r?.flame?.blind !== true) buildBlindOk = false;
    countFlame(r?.flame);
  }
  // Builder may legitimately return no primary if nothing qualifies; the blind
  // invariant still holds over whatever it does return.
  assert(buildBlindOk, "build: EVERY returned flame is blind (Builder never fabricates a non-blind flame)");

  // ── 5. Cross-cutting no-fabrication invariant ────────────────────────────
  // eslint-disable-next-line no-console
  console.log("\nNo-fabrication invariant across all routes");
  assert(
    nonBlindCount === 2,
    `exactly TWO non-blind flames in the entire run — the two Focus live reads (overextended ${LIVE_SYMBOL} + actionable ${ACTIONABLE_SYMBOL}); every Broad/Builder flame stays blind (got ${nonBlindCount})`,
  );

  // ── Cleanup ──────────────────────────────────────────────────────────────
  await cleanupByEmail();
  await closeServer();

  // eslint-disable-next-line no-console
  console.log(`\nResult: ${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().then(
  () => process.exit(0),
  async (err) => {
    await cleanupByEmail().catch(() => {});
    // eslint-disable-next-line no-console
    console.error("[scalpFlameEndpointTest] FAILED:", err);
    process.exit(1);
  },
);

export {};
