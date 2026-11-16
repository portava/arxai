/**
 * Real-browser render accuracy check (owner ruling 2026-11-09: every chart
 * read, drawing and prediction must be accurate, measured in a real browser).
 *
 * Boots the real api-server and the dashboard's Vite dev server in-process,
 * opens Chromium on e2e/render-evidence.html, and lets the dashboard's REAL
 * chart engine (ArxCanvasAdapter on the first-party ARX canvas —
 * not jsdom, not a mock) draw a deterministic candle feed served by this test
 * in OHLC candles, OHLC bars, close line, hollow and Heikin Ashi styles with
 * six drawings. The REAL reporter posts the engine's own measurement through
 * the Vite proxy to the real POST /api/me/chart/render-evidence (signed-in
 * session, zod schema, feed scope, store). The server's real judge then rules
 * on that stored report against the served series — the same fixture bars the
 * page loaded — and must say measured 100.
 *
 * Negative cases inject ONE fault into the engine (one drawn bar, one drawn
 * Heikin Ashi bar, one painted drawing stroke) and require a measured FAIL
 * (score 0) with the reason. The Heikin Ashi FAIL must come from the server's
 * own re-derivation of the transform, not only from the chart's word.
 *
 * Seeds and removes one throwaway USER; never enables a broker, places an
 * order or touches live settings.
 */
import { randomBytes, scryptSync } from "node:crypto";
import type { Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { resolve } from "node:path";
import { chromium, type Page } from "playwright";
import { createServer as createViteServer } from "vite";
import { pool } from "@workspace/db";
import {
  judgeRenderEvidence, type RenderEvidenceVerdict,
} from "../../artifacts/api-server/src/lib/data/chart/renderEvidence.js";
import type { ChartIntelligenceState } from "../../artifacts/api-server/src/lib/data/chart/chartIntelligence.js";

// Shapes shared with the page (artifacts/trading-dashboard/src/e2e/
// renderEvidenceHarness.ts). Declared here, not imported: the scripts unit
// typechecks without the DOM lib the dashboard sources need.
interface ChartDrawing {
  id: string; kind: string; color: string;
  start: { time: number; price: number }; end?: { time: number; price: number }; offset?: { time: number; price: number };
}
interface HarnessRun {
  symbol: string; timeframe: string; source: string; style: string; drawings: ChartDrawing[];
  corruptBarIndex?: number; corruptDrawingId?: string;
}
interface HarnessResult {
  bars: number; posted: boolean;
  fidelity: null | {
    barsCompared: number; mismatchedBars: number; droppedBars: number;
    priceRoundTripOk: boolean; timeRoundTripOk: boolean | null; visibleBarsRoundTripped: number;
    drawings: { checked: number; failed: number; unplaced: number; failedIds: string[] };
    transform?: string; transformVerified?: boolean; transformCheck?: { samples: unknown[] };
  };
}
type HarnessGlobal = { __arxRenderHarness?: { run(c: HarnessRun): Promise<HarnessResult> } };

const ROOT = resolve(import.meta.dirname, "../..");
const DASHBOARD_ROOT = resolve(ROOT, "artifacts/trading-dashboard");
const DISABLED_ENV = [
  "DERIV_API_TOKEN", "DERIV_APP_ID", "DERIV_ACCOUNT_ID", "DERIV_API_MODE", "DERIV_ENABLED", "DERIV_WS_URL",
  "MT5_BRIDGE_TOKEN", "MT5_ENVIRONMENT", "BROKER_PROVIDER", "LIVE_TRADING_ALLOWED", "ARX_DERIV_OWNER_USER_ID",
  "ARX_EXECUTION_TIER", "TWELVE_DATA_API_KEY", "TWELVEDATA_API_KEY", "ALPHA_VANTAGE_API_KEY", "POLYGON_API_KEY",
  "FINNHUB_API_KEY",
] as const;

const SYMBOL = "QARENDER";
const TIMEFRAME = "M5";
const SOURCE = "qa_fixture_feed";
const BARS = 240;
const T0 = Date.UTC(2026, 10, 2, 0, 0, 0) / 1000;

interface Bar { time: number; open: number; high: number; low: number; close: number }

/** Deterministic M5 feed: same bars every run, 5-decimal prices. */
function fixtureCandles(): Bar[] {
  const r = (v: number) => Math.round(v * 1e5) / 1e5;
  const out: Bar[] = [];
  let prev = 1.1;
  for (let i = 0; i < BARS; i++) {
    const open = r(prev);
    const close = r(1.1 + 0.002 * Math.sin(i / 9) + 0.0005 * Math.sin(i / 2.3));
    const high = r(Math.max(open, close) + 0.0003 * (1 + (i % 5) / 5));
    const low = r(Math.min(open, close) - 0.0002 * (1 + (i % 3) / 3));
    out.push({ time: T0 + i * 300, open, high, low, close });
    prev = close;
  }
  return out;
}

const CANDLES = fixtureCandles();
const at = (i: number) => CANDLES[i]!.time;
const DRAWINGS: ChartDrawing[] = [
  { id: "level-1", kind: "horizontal", start: { time: at(BARS - 30), price: 1.1005 }, color: "#22d3ee" },
  { id: "trend-1", kind: "trend", start: { time: at(BARS - 50), price: 1.0995 }, end: { time: at(BARS - 10), price: 1.1015 }, color: "#f59e0b" },
  { id: "zone-1", kind: "rectangle", start: { time: at(BARS - 45), price: 1.0990 }, end: { time: at(BARS - 25), price: 1.1010 }, color: "#a78bfa" },
  { id: "fib-1", kind: "fibonacci", start: { time: at(BARS - 40), price: 1.0985 }, end: { time: at(BARS - 15), price: 1.1020 }, color: "#34d399" },
  { id: "channel-1", kind: "channel", start: { time: at(BARS - 48), price: 1.0992 }, end: { time: at(BARS - 20), price: 1.1004 }, offset: { time: at(BARS - 34), price: 1.1012 }, color: "#f472b6" },
  { id: "vline-1", kind: "vertical", start: { time: at(BARS - 35), price: 1.1 }, color: "#e4e4e7" },
];

/** The series the server "serves" for this chart: the same fixture bars. */
const newest = CANDLES[BARS - 1]!;
const SERVED_STATE = {
  symbol: SYMBOL, timeframe: TIMEFRAME,
  truthState: { source: SOURCE },
  currentCandle: null,
  latestClosedCandle: {
    openTime: new Date(newest.time * 1000).toISOString(),
    open: newest.open, high: newest.high, low: newest.low, close: newest.close, isComplete: true,
  },
} as unknown as ChartIntelligenceState;

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: 65_536, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
  return `scrypt$65536$8$1$${salt.toString("base64")}$${hash.toString("base64")}`;
}

async function reservePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((ok, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", ok); });
  const address = server.address();
  await new Promise<void>((done) => server.close(() => done()));
  if (!address || typeof address === "string") throw new Error("Could not reserve a local test port.");
  return address.port;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const suffix = randomBytes(8).toString("hex");
  const email = `qa-render-${suffix}@arx.local`;
  const password = `Render-${randomBytes(12).toString("hex")}`;
  const inserted = await pool.query<{ id: number }>(
    `INSERT INTO users (email, name, password_hash, role) VALUES ($1, 'QA Render User', $2, 'USER') RETURNING id`,
    [email, hashPassword(password)],
  );
  const userId = inserted.rows[0]?.id;
  assert(userId !== undefined, "Could not create the isolated standard-user fixture.");

  const originalEnv = new Map<string, string | undefined>();
  for (const name of [...DISABLED_ENV, "ARX_LIVE_BROKER_EXECUTION_ENABLED"]) {
    originalEnv.set(name, process.env[name]);
    delete process.env[name];
  }
  process.env["ARX_LIVE_BROKER_EXECUTION_ENABLED"] = "false";

  let apiServer: Server | undefined;
  let viteServer: Awaited<ReturnType<typeof createViteServer>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const apiApp = (await import("../../artifacts/api-server/src/app.js")).default;
    apiApp.set("trust proxy", 1);
    apiServer = await new Promise<Server>((ok, fail) => {
      const server = apiApp.listen(0, "127.0.0.1", () => ok(server));
      server.once("error", fail);
    });
    const apiAddress = apiServer.address();
    assert(apiAddress && typeof apiAddress !== "string", "API test server did not start.");
    const apiOrigin = `http://127.0.0.1:${apiAddress.port}`;

    const vitePort = await reservePort();
    process.env["PORT"] = String(vitePort);
    process.env["BASE_PATH"] = "/";
    viteServer = await createViteServer({
      configFile: resolve(DASHBOARD_ROOT, "vite.config.ts"),
      server: {
        host: "127.0.0.1", port: vitePort, strictPort: true, hmr: false,
        proxy: { "/api": { target: apiOrigin, changeOrigin: false, headers: { "x-forwarded-for": `2001:db8::${suffix}` } } },
      },
    });
    await viteServer.listen();
    const uiOrigin = `http://127.0.0.1:${vitePort}`;

    const executablePath = process.env["REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE"];
    browser = await chromium.launch({
      headless: true, ...(executablePath ? { executablePath } : {}),
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const context = await browser.newContext({ viewport: { width: 1100, height: 700 } });
    const external: string[] = [];
    // The deterministic candle feed, served by this test; nothing leaves loopback.
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== uiOrigin) { external.push(url.origin); await route.abort(); return; }
      if (url.pathname === "/__fixture/candles.json") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(CANDLES) });
        return;
      }
      await route.continue();
    });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    await page.goto(`${uiOrigin}/e2e/render-evidence.html`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Boolean((globalThis as HarnessGlobal).__arxRenderHarness), undefined, { timeout: 60_000 });
    const login = await page.evaluate(async ([e, p]) => {
      const res = await fetch("/api/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ email: e, password: p }),
      });
      return res.status;
    }, [email, password] as const);
    assert(login === 200, `Sign-in for the render test user returned ${login}.`);

    // Engine identity: this is the first-party ARX renderer painting to a canvas.
    const run = async (cfg: Partial<HarnessRun>): Promise<{ result: HarnessResult; verdict: RenderEvidenceVerdict }> => {
      const full: HarnessRun = { symbol: SYMBOL, timeframe: TIMEFRAME, source: SOURCE, style: "candles", drawings: DRAWINGS, ...cfg };
      const [response, result] = await Promise.all([page.waitForResponse(
        (r) => new URL(r.url()).pathname === "/api/me/chart/render-evidence" && r.request().method() === "POST",
        { timeout: 30_000 },
      ), page.evaluate((c) => (globalThis as HarnessGlobal).__arxRenderHarness!.run(c), full)]);
      assert(response.status() === 200, `POST render-evidence returned ${response.status()}: ${await response.text()}`);
      const sent = response.request().postDataJSON() as Record<string, unknown>;
      assert(sent["source"] === SOURCE && sent["symbol"] === SYMBOL, "The posted evidence is not bound to the fixture chart.");
      // The server's real judge on the report the real route stored.
      const verdict = judgeRenderEvidence(userId, SERVED_STATE);
      return { result, verdict };
    };
    const score = (v: RenderEvidenceVerdict) => (v.status === "measured" ? v.score : v.status);
    const canvases = async (p: Page) => p.locator("#chart canvas").count();

    // ── Exact draws: measured 100 in every price style ─────────────────────
    for (const style of ["candles", "bars", "line", "hollow", "heikinAshi"] as const) {
      const { result, verdict } = await run({ style });
      const f = result.fidelity;
      assert(f, `${style}: the engine reported no measurement.`);
      assert(await canvases(page) > 0, `${style}: ARX did not paint a canvas.`);
      assert(f.barsCompared === BARS && f.mismatchedBars === 0 && f.droppedBars === 0, `${style}: bars ${JSON.stringify(f)}`);
      assert(f.visibleBarsRoundTripped > 20 && f.priceRoundTripOk && f.timeRoundTripOk === true, `${style}: axes ${JSON.stringify(f)}`);
      assert(f.drawings.checked === DRAWINGS.length && f.drawings.failed === 0 && f.drawings.unplaced === 0,
        `${style}: drawings ${JSON.stringify(f.drawings)}`);
      if (style === "heikinAshi") {
        assert(f.transform === "heikinAshi" && f.transformVerified === true && f.transformCheck?.samples.length === 64,
          "heikinAshi: the transform check was not reported.");
      }
      assert(score(verdict) === 100, `${style}: server verdict ${verdict.status} ${score(verdict)} — ${verdict.detail}`);
      if (style === "heikinAshi") {
        assert(/server re-derived the newest 64 Heikin Ashi bar/.test(verdict.detail) && /not tradable prices/.test(verdict.detail),
          `heikinAshi: verdict does not state the server's own transform check: ${verdict.detail}`);
      }
      console.log(`PASS  ${style}: ${BARS} bars, ${f.visibleBarsRoundTripped} visible round-trips, ${f.drawings.checked} drawings → server measured 100`);
    }

    // ── One corrupted drawn bar → measured FAIL ────────────────────────────
    {
      const { result, verdict } = await run({ style: "candles", corruptBarIndex: BARS - 12 });
      assert(result.fidelity?.mismatchedBars === 1, `corrupt bar: chart counted ${result.fidelity?.mismatchedBars}`);
      assert(score(verdict) === 0 && /1 drawn bar\(s\) differ from the source/.test(verdict.detail),
        `corrupt bar: server verdict ${score(verdict)} — ${verdict.detail}`);
      console.log("PASS  one corrupted drawn bar → server measured FAIL (0)");
    }

    // ── One corrupted drawn Heikin Ashi bar → FAIL from the server's own transform
    {
      const { verdict } = await run({ style: "heikinAshi", corruptBarIndex: BARS - 10 });
      assert(score(verdict) === 0 && /drawn Heikin Ashi bar\(s\) differ from the server's own transform/.test(verdict.detail),
        `corrupt HA bar: server verdict ${score(verdict)} — ${verdict.detail}`);
      console.log("PASS  one corrupted Heikin Ashi bar → server re-derivation measured FAIL (0)");
    }

    // ── One painted drawing off its anchor → measured FAIL naming it ───────
    {
      const { result, verdict } = await run({ style: "candles", corruptDrawingId: "trend-1" });
      assert(result.fidelity?.drawings.failed === 1 && result.fidelity.drawings.failedIds.includes("trend-1"),
        `corrupt drawing: chart reported ${JSON.stringify(result.fidelity?.drawings)}`);
      assert(score(verdict) === 0 && /trend-1/.test(verdict.detail), `corrupt drawing: server verdict ${score(verdict)} — ${verdict.detail}`);
      console.log("PASS  one drawing painted off its anchor → server measured FAIL (0) naming trend-1");
    }

    // ── The chip's route answers for the signed-in reader ──────────────────
    {
      const body = await page.evaluate(async (q) => {
        const res = await fetch(`/api/me/chart/render-evidence?${q}`, { credentials: "include" });
        return { status: res.status, json: await res.json() as { verdict?: { status?: string }; report?: { barsCompared?: number } | null } };
      }, new URLSearchParams({ symbol: SYMBOL, timeframe: TIMEFRAME }).toString());
      assert(body.status === 200 && typeof body.json.verdict?.status === "string" && body.json.report?.barsCompared === BARS,
        `GET render-evidence: ${JSON.stringify(body)}`);
      console.log(`PASS  GET render verdict route answers (${body.json.verdict!.status} against the real served series)`);
    }

    assert(pageErrors.length === 0, `Page errors: ${pageErrors.join(" | ")}`);
    assert(external.length === 0, `The test attempted an external browser connection: ${external.join(", ")}`);
  } finally {
    await browser?.close().catch(() => {});
    if (viteServer) await viteServer.close().catch(() => {});
    if (apiServer) await new Promise<void>((done) => apiServer!.close(() => done()));
    for (const [name, value] of originalEnv) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await pool.query(`DELETE FROM auth_user_sessions WHERE user_id = $1`, [userId]).catch(() => {});
    await pool.query(`DELETE FROM user_activity_events WHERE user_id = $1`, [userId]).catch(() => {});
    await pool.query(`DELETE FROM user_settings WHERE user_id = $1`, [userId]).catch(() => {});
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]).catch(() => {});
  }
}

main()
  .then(async () => {
    console.log("Chart render accuracy browser check passed.");
    await pool.end();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : "Chart render accuracy browser check failed.");
    await pool.end();
    process.exit(1);
  });
