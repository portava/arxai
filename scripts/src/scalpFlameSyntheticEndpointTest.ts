// Test: the scalp "flame" read survives the REAL path on SYNTHETIC markets too.
//
// Sibling of scalpFlameEndpointTest.ts (which only exercises forex symbols).
// The Deriv-backed synthetic asset class routes through a DIFFERENT provider
// chain ([mt5_broker, deriv] vs forex's [mt5_broker, assistant_real]) and the
// live-feed warm-up behaves differently, so the flame contract on synthetics
// must be pinned at the service/endpoint level independently. A regression that
// fabricated a non-blind flame from synthetic data would otherwise slip through.
//
// This proves the same honesty contract across the genuine Express routes, the
// real synthetic-class market-data router, the real per-user spec loader, and
// the real candle window fetch, for the three scalp surfaces:
//
//   - POST /api/me/scalp/focus  (deep, per-symbol candle-backed read)
//   - POST /api/me/scalp/rank   (Broad scan over the synthetic universe)
//   - POST /api/me/scalp/build  (Ruby Scalp Builder over the synthetic universe)
//
// WHAT IT PROVES
//   1. LIVE-DATA case (flame.blind === false): Focus on a synthetic symbol with
//      a REAL pushed candle window (via the genuine mt5Provider injection seam
//      the EA bridge uses — FIRST in the synthetic chain) returns a fully-formed
//      flame whose `blind` is false. Focus is the only path that fetches a
//      per-symbol candle window, so it is the only one that can legitimately be
//      non-blind.
//   2. AWAITING-DATA case (flame.blind === true): Focus on a synthetic symbol
//      with a REAL but sub-threshold candle window (< MIN_FLAME_CANDLES) pushed
//      through the same mt5_broker seam returns a well-formed flame whose `blind`
//      is true — proving an insufficient/non-actionable synthetic read NEVER
//      promotes the flame to non-blind, and never falls through to fabricated
//      simulator OHLC (synthetics have NO simulator fallback).
//   3. NO-FABRICATION on the hot path: Broad + Builder evaluate the same live
//      synthetic universe, yet they intentionally do NOT re-fetch a per-symbol
//      candle window (rate-limit guard → candles:null), so EVERY flame they
//      return is honestly blind. We assert the only non-blind flame anywhere in
//      the run is the single Focus live read.
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
//     real MT5 bridge uses (updateCandlesFromMT5 / updateQuoteFromMT5), which is
//     FIRST in the synthetic router chain. It is a genuine real-data path, not
//     fabricated simulator OHLC. Deriv is the chain's fallback; because the
//     mt5_broker push always wins for our symbols, the result is deterministic
//     even when Deriv is configured/connected in this environment.
//   - CI-safe / self-contained: spins up the REAL Express app in-process on an
//     ephemeral port. Set ARX_QA_BASE_URL to probe an already-running server
//     instead (note: the live-feed injection only applies in-process). Only
//     DATABASE_URL is required.
//
// Run: pnpm --filter @workspace/scripts run test:scalp-flame-synthetic-endpoint

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
const TEST_EMAIL = "qa+scalp-flame-synthetic-endpoint@arx.test";

// Synthetic (Deriv) symbol with a REAL pushed candle window (>= MIN_FLAME_CANDLES)
// → the only legitimately non-blind read. "V75" is the canonical ARX label for
// the Deriv "Volatility 75 Index" (R_75); it classifies as the synthetic asset
// class so the router uses the [mt5_broker, deriv] chain. The mt5_broker seam is
// FIRST, so our push wins outright and the real fetch returns exactly our window
// (deterministic even though Deriv is configured/connected in this env).
const LIVE_SYMBOL = "V75";
// A SECOND synthetic symbol with a REAL but sub-threshold candle window
// (< MIN_FLAME_CANDLES) pushed through the same mt5_broker seam → the engine's
// flame read MUST be honestly blind. Because the push wins, the real candle
// fetch returns exactly this short window and never falls through to Deriv
// (which could otherwise serve a full window non-deterministically).
const AWAITING_SYMBOL = "V25";
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
 * Drives the scanner to a high-confidence BUY (all rules pass) so the engine
 * reaches the full candle-backed flame read (non-blind) on the Focus path.
 * The numeric scale is irrelevant to the (percentage-based) analyzer and the
 * (count-based) flame blindness check — what matters is a real, sufficiently
 * long window injected via the genuine mt5_broker seam.
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

/** Broker-truth spec row for a synthetic-index symbol (lets the engine size). */
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
    contractSize: 1,
    tickSize: 0.00001,
    tickValue: 1,
    stopsLevelPoints: 0,
    spreadPoints: 0,
    category: "synthetic",
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
  console.log("scalpFlameSyntheticEndpointTest");
  // eslint-disable-next-line no-console
  console.log("===============================\n");

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
    name: "QA Scalp Flame Synthetic Endpoint",
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

  // ── Seed per-user broker truth for both synthetic symbols ────────────────
  await db.insert(arxSymbolSpecsTable).values([
    specRow(user.id, LIVE_SYMBOL),
    specRow(user.id, AWAITING_SYMBOL),
  ]);

  // ── Inject the live feed via the genuine MT5 bridge seam ─────────────────
  // The mt5_broker provider is FIRST in the synthetic router chain, so these
  // pushes win outright over Deriv — making the result deterministic.
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
  // AWAITING_SYMBOL: a REAL but sub-threshold candle window (< MIN_FLAME_CANDLES)
  // pushed through the same mt5_broker seam. The real candle fetch returns
  // exactly these candles, so the engine's flame read MUST be honestly blind
  // (the window is too short to read a flame) — proving the genuine synthetic
  // data path never promotes an insufficient window to a non-blind flame and
  // never falls through to fabricated simulator OHLC.
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

  // ── 1. Focus — LIVE synthetic data → flame present, well-formed, blind===false
  // eslint-disable-next-line no-console
  console.log(`POST /api/me/scalp/focus (${LIVE_SYMBOL}) — live synthetic candle window → non-blind flame`);
  const focusLive = await postJson("/api/me/scalp/focus", { symbol: LIVE_SYMBOL });
  assert(focusLive.status === 200, `focus(live) HTTP 200 (got ${focusLive.status})`);
  const liveFlame = focusLive.json?.flame;
  assertWellFormedFlame(liveFlame, "focus(live)");
  assert(liveFlame?.blind === false, `focus(live): flame.blind === false (got ${String(liveFlame?.blind)})`);
  // The flame age proves the REAL candle window was actually consumed and
  // analyzed (a blind read reports age 0). A non-blind read need not be
  // actionable — a long unbroken run reads as overextended — but it MUST
  // reflect genuine candle analysis of the injected synthetic window.
  assert(
    typeof liveFlame?.flameAgeCandles === "number" && liveFlame.flameAgeCandles >= 1,
    `focus(live): real synthetic candle window was consumed (flameAgeCandles >= 1, got ${String(liveFlame?.flameAgeCandles)})`,
  );
  countFlame(liveFlame);

  // ── 2. Focus — AWAITING synthetic data → flame present, well-formed, blind===true
  // eslint-disable-next-line no-console
  console.log(`\nPOST /api/me/scalp/focus (${AWAITING_SYMBOL}) — sub-threshold real synthetic window → blind flame`);
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
  console.log("\nPOST /api/me/scalp/rank (synthetic) — Broad hot path → every returned flame is blind");
  const rank = await postJson("/api/me/scalp/rank", { marketGroup: "synthetic", limit: 20 });
  assert(rank.status === 200, `rank HTTP 200 (got ${rank.status})`);
  const rankResult = rank.json ?? {};
  const rankReads: any[] = [
    ...(Array.isArray(rankResult.opportunities) ? rankResult.opportunities : []),
    rankResult.best,
    rankResult.safer,
    rankResult.fastest,
  ].filter(Boolean);
  // `scanned` reflects the synthetic universe size — proves Broad actually
  // scanned the synthetic asset class (not an empty/forex universe).
  assert(typeof rankResult.scanned === "number" && rankResult.scanned >= 1, `rank: scanned the synthetic universe (got ${String(rankResult.scanned)})`);
  let rankBlindOk = true;
  for (let i = 0; i < rankReads.length; i++) {
    const r = rankReads[i];
    const formed = assertWellFormedFlame(r?.flame, `rank[#${i} ${String(r?.symbol)}]`);
    if (!formed || r?.flame?.blind !== true) rankBlindOk = false;
    countFlame(r?.flame);
  }
  assert(rankBlindOk, "rank: EVERY returned flame is blind (Broad never fabricates a non-blind flame, even for live synthetic V75)");

  // ── 4. Builder (build) — same hot path → every flame blind ───────────────
  // eslint-disable-next-line no-console
  console.log("\nPOST /api/me/scalp/build (synthetic) — Builder hot path → every returned flame is blind");
  const build = await postJson("/api/me/scalp/build", { marketGroup: "synthetic" });
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
  console.log("\nNo-fabrication invariant across all synthetic routes");
  assert(
    nonBlindCount === 1,
    `exactly ONE non-blind flame in the entire run — the Focus live synthetic read (got ${nonBlindCount})`,
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
    console.error("[scalpFlameSyntheticEndpointTest] FAILED:", err);
    process.exit(1);
  },
);

export {};
