// Test: POST /api/me/assistant/read-chart never silently reads an unconfirmed
// feed (Task #287 behaviour, guarded here).
//
// The Ruby chart-read endpoint must stamp `chartRead.dataQuality = "insufficient"`
// in BOTH honesty cases:
//
//   1. GATED read — the server's own chart-truth gate could not verify the feed
//      (basis !== "VERIFIED"). A symbol with NO live feed pushed and no provider
//      data falls to basis "INSUFFICIENT", so the read is gated and explicitly
//      insufficient (gated === true, dataQuality === "insufficient").
//
//   2. OVERRIDE read — the server gate PASSED (basis === "VERIFIED" over a real
//      pushed candle window) but the CLIENT reported its own chart feed was not
//      confirmed at read-time (body `aiUsable: false`). The endpoint must STILL
//      mark the read insufficient and attach the read-time caution, so the caveat
//      surfaces even on a server-verified read.
//
// The control (verified read WITHOUT the override) proves the override is doing
// real work: the same symbol/window read with aiUsable omitted reaches the
// verified branch (gated !== true, basis === "VERIFIED") and is NOT insufficient.
//
// HOW THE VERIFIED BRANCH IS REACHED (deterministically, no real broker):
//   We push a clean, fresh, ≥150-bar M5 candle window through the genuine MT5
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
//   - Read-only: only the read-only POST /me/assistant/read-chart endpoint is
//     called. Never places a trade, never inserts arx_live_commands, never
//     reaches the EA or a broker.
//   - The candle "live feed" is injected via the same in-memory seam the real
//     MT5 bridge uses (updateCandlesFromMT5), a genuine real-data path — not
//     fabricated simulator OHLC.
//   - CI-safe / self-contained: spins up the REAL Express app in-process on an
//     ephemeral port. Set ARX_QA_BASE_URL to probe an already-running server
//     instead (note: the live-feed injection only applies in-process). Only
//     DATABASE_URL is required.
//
// Run: pnpm --filter @workspace/scripts run test:ruby-read-chart-feed-honesty

import { randomBytes, createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  db,
  usersTable,
  authUserSessionsTable,
  arxSymbolSpecsTable,
} from "@workspace/db";
import { updateCandlesFromMT5 } from "../../artifacts/api-server/src/lib/data/providers/mt5Provider.js";
import {
  getSharedBaseUrl,
  closeSharedServer,
  isEntrypoint,
  type CiTestResultLike,
} from "./ci/inProcessAppHarness.js";

const TEST_EMAIL = "qa+ruby-read-chart-feed-honesty@arx.test";

// A forex symbol with a REAL pushed candle window → the only server-verifiable
// read. Forex routes through [mt5_broker, assistant_real]; the mt5_broker seam is
// FIRST, so our push wins outright (deterministic even if assistant providers are
// configured in this env).
const VERIFIED_SYMBOL = "EURUSD";
// A symbol with NO feed pushed and no provider coverage → basis INSUFFICIENT →
// the gated read. A clearly non-existent ticker so no real provider can serve it.
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
 * Equal candle ranges, zero gaps, valid OHLC — no anomalies that would degrade
 * the truth assessment below CLEAN.
 */
function buildCleanWindow(): Array<{ time: string; open: number; high: number; low: number; close: number; volume: number }> {
  const out: Array<{ time: string; open: number; high: number; low: number; close: number; volume: number }> = [];
  const base = 1.1000;
  const stepUp = 0.00002; // tiny per-bar drift → no spike/outlier anomalies
  const body = 0.00010;
  const wick = 0.00015;
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
  console.log("rubyReadChartFeedHonestyTest");
  // eslint-disable-next-line no-console
  console.log("===========================\n");

  await cleanupByEmail();

  const baseUrl = await getSharedBaseUrl();

  // ── Seed isolated user + session ─────────────────────────────────────────
  const insertedUsers = await db.insert(usersTable).values({
    email: TEST_EMAIL,
    name: "QA Ruby Read-Chart Feed Honesty",
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
    const res = await fetch(`${baseUrl}/api/me/assistant/read-chart`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, json } as { status: number; json: any };
  };

  // ── 1. GATED read — no feed for the symbol → insufficient ────────────────
  // eslint-disable-next-line no-console
  console.log(`POST read-chart (${GATED_SYMBOL}) — no feed → gated + insufficient`);
  const gated = await postJson({ symbol: GATED_SYMBOL, timeframe: TIMEFRAME });
  assert(gated.status === 200, `gated HTTP 200 (got ${gated.status})`);
  const gatedRead = gated.json?.chartRead;
  assert(!!gatedRead, "gated: chartRead present");
  assert(gatedRead?.gated === true, `gated: chartRead.gated === true (got ${String(gatedRead?.gated)})`);
  assert(
    gatedRead?.dataQuality === "insufficient",
    `gated: chartRead.dataQuality === "insufficient" (got ${String(gatedRead?.dataQuality)})`,
  );

  // ── 2. CONTROL — verified read WITHOUT the override → NOT insufficient ────
  // Proves the override (case 3) is doing real work: the same window read with
  // aiUsable omitted reaches the verified branch and is not insufficient.
  // eslint-disable-next-line no-console
  console.log(`\nPOST read-chart (${VERIFIED_SYMBOL}) — verified feed, no override → control`);
  const control = await postJson({ symbol: VERIFIED_SYMBOL, timeframe: TIMEFRAME });
  assert(control.status === 200, `control HTTP 200 (got ${control.status})`);
  const controlRead = control.json?.chartRead;
  assert(!!controlRead, "control: chartRead present");
  assert(
    controlRead?.gated !== true,
    `control: read is not gated (basis=${String(controlRead?.basis)}, gated=${String(controlRead?.gated)})`,
  );
  assert(
    controlRead?.basis === "VERIFIED",
    `control: basis === "VERIFIED" (got ${String(controlRead?.basis)})`,
  );
  assert(
    controlRead?.dataQuality !== "insufficient",
    `control: a verified read is NOT insufficient (got ${String(controlRead?.dataQuality)})`,
  );

  // ── 3. OVERRIDE — verified read WITH aiUsable:false → forced insufficient ─
  // eslint-disable-next-line no-console
  console.log(`\nPOST read-chart (${VERIFIED_SYMBOL}) — verified feed + aiUsable:false → forced insufficient`);
  const override = await postJson({ symbol: VERIFIED_SYMBOL, timeframe: TIMEFRAME, aiUsable: false });
  assert(override.status === 200, `override HTTP 200 (got ${override.status})`);
  const overrideRead = override.json?.chartRead;
  assert(!!overrideRead, "override: chartRead present");
  // The server still verified the feed (it reached the verified branch), but the
  // client's read-time verdict forces the insufficient stamp + caution.
  assert(
    overrideRead?.gated !== true,
    `override: still reached the verified branch (gated=${String(overrideRead?.gated)})`,
  );
  assert(
    overrideRead?.dataQuality === "insufficient",
    `override: aiUsable:false forces dataQuality === "insufficient" (got ${String(overrideRead?.dataQuality)})`,
  );
  assert(
    Array.isArray(overrideRead?.cautions) &&
      overrideRead.cautions.includes("Feed not confirmed at read-time — limited visibility."),
    "override: read carries the read-time feed caution",
  );

  // ── Cleanup ──────────────────────────────────────────────────────────────
  await cleanupByEmail();

  // eslint-disable-next-line no-console
  console.log(`\nResult: ${passes} passed, ${failures} failed`);
  return { name: "rubyReadChartFeedHonestyTest", passes, failures };
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
      console.error("[rubyReadChartFeedHonestyTest] FAILED:", err);
      process.exit(1);
    },
  );
}
