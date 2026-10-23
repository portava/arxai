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
//   feed quality resolves "clean" (aiUsable=true) and the basis is VERIFIED.
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
// Run: pnpm --filter @workspace/scripts run test:ruby-draw-setup-route

import { randomBytes, createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  db,
  pool,
  usersTable,
  authUserSessionsTable,
  arxSymbolSpecsTable,
} from "@workspace/db";
import { updateCandlesFromMT5 } from "../../artifacts/api-server/src/lib/data/providers/mt5Provider.js";
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

const TEST_EMAIL = "qa+ruby-draw-setup-route@arx.test";

// A forex symbol with a REAL pushed candle window → the only server-verifiable
// draw. Forex routes through [mt5_broker, assistant_real]; the mt5_broker seam is
// FIRST, so our push wins outright (deterministic even if assistant providers are
// configured in this env).
const VERIFIED_SYMBOL = "EURUSD";
// A symbol with NO feed pushed and no provider coverage → basis INSUFFICIENT →
// the gated draw. A clearly non-existent ticker so no real provider can serve it.
const GATED_SYMBOL = "ZZNOFEEDXX";
const TIMEFRAME = "M5";
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
 * 5-minute bucket (trailing 0 → feed quality "clean" → aiUsable=true → VERIFIED).
 * A gentle persistent uptrend so the structural read is directional + clean,
 * yielding a drawable BUY setup. Equal candle ranges, zero gaps, valid OHLC — no
 * anomalies that would degrade the truth assessment below CLEAN.
 */
function buildCleanWindow(): Array<{ time: string; open: number; high: number; low: number; close: number; volume: number }> {
  const out: Array<{ time: string; open: number; high: number; low: number; close: number; volume: number }> = [];
  const base = 1.1000;
  const stepUp = 0.00008; // gentle per-bar drift → directional, no spike anomaly
  const body = 0.00004;
  const wick = 0.00010;
  // Align the newest bar to the current 5-minute bucket so trailingIntervals === 0.
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

// ── Task #389: prove a live scanner signal actually CHANGES the drawn setup ──
// No synthetic agents are seeded: the REAL production agents (seeded on boot by
// seedCoreAgents) react to the live signal. The ACTIVE core RISK agent reads
// safety = (1 - riskScore/100); a populated riskScore in the [70, 85) downgrade
// band makes it request a DOWNGRADE through the real advisory → Traffic → Court
// flow, which flips the drawn setup's verdict tradeable → caution. Everything is
// ADVISORY/SHADOW only — it never gates demo/live execution.

/**
 * A CHOPPY M15/H1 window that the REAL live scanner (scoreLiveCandidates →
 * scoreCandles) ranks as a real LOW-score candidate: a flat body for most bars
 * then one outsized final bar (volatilityRatio > 1.8 → bias "choppy"). Combined
 * with the moderate bid/ask spread below, the scanner deterministically produces
 * scannerScore ~36 (a populated, non-null candidate) and riskScore ~77 — inside
 * the RISK agent's [70, 85) DOWNGRADE band (below the 85 rejection threshold).
 * This is a REAL populated signal derived from this fixed window — never
 * fabricated structure, and deterministic (not random).
 */
function buildChoppyCandles(): Candle[] {
  const out: Candle[] = [];
  const base = 1.1000;
  const n = 12; // >= MIN_CANDLES (10)
  for (let i = 0; i < n; i++) {
    const isLast = i === n - 1;
    const open = isLast ? 1.1000 : base;
    const close = isLast ? 1.1006 : base; // first close = last close diff → drift > 0.0005 (not "neutral")
    const high = isLast ? 1.1009 : base + 0.00005;
    const low = isLast ? 1.0997 : base - 0.00005; // last range 0.0012 ≫ others 0.0001 → choppy
    out.push({
      t: new Date(Date.now() - (n - 1 - i) * 15 * 60 * 1000).toISOString(),
      o: Number(open.toFixed(5)),
      h: Number(high.toFixed(5)),
      l: Number(low.toFixed(5)),
      c: Number(close.toFixed(5)),
      v: 1000,
    });
  }
  return out;
}

/**
 * A moderate bid/ask spread (0.0003 ≈ 27 spread-penalty points). Combined with
 * the choppy bias's +30, the scanner's riskScore lands at ~77 — in the RISK
 * agent's [70, 85) DOWNGRADE band, below the 85 rejection threshold.
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

/** Per-user broker-truth spec row for a forex symbol. */
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
  console.log("rubyDrawSetupRouteTest");
  // eslint-disable-next-line no-console
  console.log("======================\n");

  await cleanupByEmail();

  const baseUrl = await getSharedBaseUrl();

  // ── Seed isolated user + session ─────────────────────────────────────────
  const insertedUsers = await db.insert(usersTable).values({
    email: TEST_EMAIL,
    name: "QA Ruby Draw-Setup Route",
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
  await db.insert(arxSymbolSpecsTable).values([specRow(user.id, VERIFIED_SYMBOL)]);
  updateCandlesFromMT5(VERIFIED_SYMBOL, buildCleanWindow());

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
    console.log(`\nPOST draw-setup (${VERIFIED_SYMBOL}) — verified feed, side BUY → drawable`);
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
    // Same VERIFIED chart feed, same symbol, same BUY request. The ONLY thing
    // that differs between the control and the treatment is the live scanner
    // signal. This proves the scanner/governance sources are not cosmetic: a
    // populated low-score signal, fed to the REAL production agents, flips the
    // drawn verdict from tradeable to caution (Task #389).

    // Control — a provider that yields NO scanner candidate (empty candles).
    // scannerScore / riskScore / governanceOutcome come back honestly null
    // (no candidate → governance is never consulted) and the clean uptrend
    // draws as tradeable.
    _setMarketProviderForTests(makeScannerProvider([], CHOPPY_QUOTE));
    // eslint-disable-next-line no-console
    console.log(`\nPOST draw-setup (${VERIFIED_SYMBOL}) — control: no scanner signal`);
    const control = await postJson({ symbol: VERIFIED_SYMBOL, timeframe: TIMEFRAME, side: "BUY" });
    assert(control.status === 200, `control HTTP 200 (got ${control.status})`);
    const controlPreview = control.json?.setupPreview;
    assert(!!controlPreview, "control: setupPreview present");
    assert(
      controlPreview?.dataFreshness?.basis === "VERIFIED",
      `control: basis still VERIFIED from the chart feed (got ${String(controlPreview?.dataFreshness?.basis)})`,
    );
    assert(controlPreview?.scannerScore === null, `control: scannerScore null with no scanner candidate (got ${String(controlPreview?.scannerScore)})`);
    assert(controlPreview?.riskScore === null, `control: riskScore null with no scanner candidate (got ${String(controlPreview?.riskScore)})`);
    assert(controlPreview?.governanceOutcome === null, `control: governanceOutcome null with no scanner candidate (got ${String(controlPreview?.governanceOutcome)})`);
    assert(controlPreview?.verdict === "tradeable", `control: verdict tradeable on the clean uptrend (got ${String(controlPreview?.verdict)})`);

    // Treatment — a populated CHOPPY scanner signal (a REAL low score with a
    // riskScore in the [70, 85) band). The ACTIVE core RISK agent reads the
    // elevated risk through the real advisory → Traffic → Court flow and
    // requests a DOWNGRADE, flipping the team verdict to caution.
    _setMarketProviderForTests(makeScannerProvider(buildChoppyCandles(), CHOPPY_QUOTE));
    // eslint-disable-next-line no-console
    console.log(`\nPOST draw-setup (${VERIFIED_SYMBOL}) — treatment: populated low-score scanner signal`);
    const treatment = await postJson({ symbol: VERIFIED_SYMBOL, timeframe: TIMEFRAME, side: "BUY" });
    assert(treatment.status === 200, `treatment HTTP 200 (got ${treatment.status})`);
    const treatmentPreview = treatment.json?.setupPreview;
    assert(!!treatmentPreview, "treatment: setupPreview present");
    assert(
      treatmentPreview?.dataFreshness?.basis === "VERIFIED",
      `treatment: basis still VERIFIED from the chart feed (got ${String(treatmentPreview?.dataFreshness?.basis)})`,
    );
    // The populated signal SURFACES as real, non-null numbers (not fabricated).
    assert(
      typeof treatmentPreview?.scannerScore === "number" && Number.isFinite(treatmentPreview?.scannerScore),
      `treatment: scannerScore is a populated number (got ${typeof treatmentPreview?.scannerScore} = ${String(treatmentPreview?.scannerScore)})`,
    );
    assert(
      typeof treatmentPreview?.riskScore === "number" && Number.isFinite(treatmentPreview?.riskScore),
      `treatment: riskScore is a populated number (got ${typeof treatmentPreview?.riskScore} = ${String(treatmentPreview?.riskScore)})`,
    );
    // The populated risk sits in the RISK agent's [70, 85) DOWNGRADE band
    // (below the 85 rejection threshold) — the deterministic driver of the flip.
    assert(
      typeof treatmentPreview?.riskScore === "number" &&
        treatmentPreview.riskScore >= 70 && treatmentPreview.riskScore < 85,
      `treatment: riskScore in the RISK DOWNGRADE band [70,85) (got ${String(treatmentPreview?.riskScore)})`,
    );
    // Governance demonstrably acted: the team DOWNGRADED the read.
    assert(
      treatmentPreview?.governanceOutcome === "downgraded",
      `treatment: governanceOutcome "downgraded" (got ${String(treatmentPreview?.governanceOutcome)})`,
    );
    assert(treatmentPreview?.verdict === "caution", `treatment: verdict caution (got ${String(treatmentPreview?.verdict)})`);

    // The crux of Task #389: the ONLY change was the live scanner signal, and it
    // flipped the drawn verdict. A no-signal control and a populated-signal
    // treatment cannot draw the same setup.
    assert(
      controlPreview?.verdict === "tradeable" && treatmentPreview?.verdict === "caution",
      `signal changes the setup: verdict tradeable→caution (control=${String(controlPreview?.verdict)}, treatment=${String(treatmentPreview?.verdict)})`,
    );
    assert(
      controlPreview?.governanceOutcome === null && treatmentPreview?.governanceOutcome === "downgraded",
      `signal changes governance: null→downgraded (control=${String(controlPreview?.governanceOutcome)}, treatment=${String(treatmentPreview?.governanceOutcome)})`,
    );

    // Restore the real provider for the side-effect tally below.
    _resetMarketProviderForTests();

    // ── 4. NO LIVE SIDE EFFECTS — a drawing can never act ───────────────────
    const cmdAfter = await countCommands();
    assert(cmdAfter.live === cmdBefore.live, "no live side effects: arx_live_commands unchanged");
    assert(cmdAfter.mt5 === cmdBefore.mt5, "no live side effects: mt5_commands unchanged");
  } finally {
    await cleanupByEmail();
  }

  // eslint-disable-next-line no-console
  console.log(`\nResult: ${passes} passed, ${failures} failed`);
  return { name: "rubyDrawSetupRouteTest", passes, failures };
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
      console.error("[rubyDrawSetupRouteTest] FAILED:", err);
      process.exit(1);
    },
  );
}
