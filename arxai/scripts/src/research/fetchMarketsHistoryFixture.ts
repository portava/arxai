// Fetch the pinned REAL-MARKETS fixture (scripts/fixtures/real-markets-v1/).
//
// The only way that fixture is produced. Run by hand, not in CI.
//
// SOURCE: Deriv's public market-data WebSocket, the endpoint the API server's
// DerivPublicDataClient uses (no account, no token). Only `ticks_history` with
// `style: "candles"` is sent. Real markets only: FX, metals, stock indices.
// Deriv synthetic indices are excluded on purpose (they are random by design).
//
// HONESTY RULES (same as fetchIntradayHistoryFixture.ts):
//   - A pinned window: every series ends at the last bar that CLOSED by WINDOW_END.
//   - Partial (off-grid) candles are dropped and counted.
//   - Each next page ends at the close of the oldest kept bar, so that bar is
//     re-served and must match byte-for-byte, or the fetch aborts.
//   - Malformed OHLC aborts. Missing bars (weekends, holidays) stay missing.
//   - A series shorter than MIN_BARS is excluded and reported, never padded.
// PACING: Deriv rate-limits history paging. Requests are spaced, and a
// RateLimit reply waits and retries the SAME request; nothing is skipped.
//
// Usage (network required; run from arxai/):
//   pnpm --filter @workspace/scripts exec tsx ./src/research/fetchMarketsHistoryFixture.ts

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { serialiseBarsCsv, type FixtureBar } from "./realHistoryFixture.js";
import { TIMEFRAME_SECONDS, intradayDatasetHashOf, type IntradayExclusion, type IntradayFixtureManifest, type IntradayInstrumentSpec, type IntradayTimeframe } from "./intradayHistoryFixture.js";
import { MARKETS_FIXTURE_DIR_NAME, MARKETS_MANIFEST_VERSION } from "./marketsHistoryFixture.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "..", "..", "fixtures", MARKETS_FIXTURE_DIR_NAME);

export const DERIV_PUBLIC_WS = "wss://api.derivws.com/trading/v1/options/ws/public";
/** Fixed window end: Tuesday 2026-11-10, after the New York close. */
export const WINDOW_END = "2026-11-10T21:00:00Z";
/** How far back each timeframe goes (open time of the first bar kept). */
const WINDOW_START: Partial<Record<IntradayTimeframe, string>> = { M15: "2025-11-10T21:00:00Z", H1: "2024-11-10T21:00:00Z" };
const TIMEFRAMES: IntradayTimeframe[] = ["M15", "H1"];
const MIN_BARS = 2000;
const MAX_PAGES = 120;
const REQUEST_GAP_MS = 1200;
const RATE_LIMIT_WAIT_MS = 65_000;
const MAX_RETRIES = 12;

const SYMBOLS: Array<{ symbol: string; assetClass: IntradayInstrumentSpec["assetClass"]; note: string }> = [
  { symbol: "frxEURUSD", assetClass: "fx", note: "Deriv EUR/USD feed" },
  { symbol: "frxGBPUSD", assetClass: "fx", note: "Deriv GBP/USD feed" },
  { symbol: "frxUSDJPY", assetClass: "fx", note: "Deriv USD/JPY feed" },
  { symbol: "frxAUDUSD", assetClass: "fx", note: "Deriv AUD/USD feed" },
  { symbol: "frxUSDCAD", assetClass: "fx", note: "Deriv USD/CAD feed" },
  { symbol: "frxUSDCHF", assetClass: "fx", note: "Deriv USD/CHF feed" },
  { symbol: "frxEURGBP", assetClass: "fx", note: "Deriv EUR/GBP feed" },
  { symbol: "frxEURJPY", assetClass: "fx", note: "Deriv EUR/JPY feed" },
  { symbol: "frxXAUUSD", assetClass: "metal", note: "Deriv XAU/USD (gold) feed" },
  { symbol: "OTC_SPC", assetClass: "index", note: "Deriv OTC US 500 index feed" },
  { symbol: "OTC_NDX", assetClass: "index", note: "Deriv OTC US Tech 100 index feed" },
  { symbol: "OTC_GDAXI", assetClass: "index", note: "Deriv OTC Germany 40 index feed" },
  { symbol: "OTC_FTSE", assetClass: "index", note: "Deriv OTC UK 100 index feed" },
  { symbol: "OTC_N225", assetClass: "index", note: "Deriv OTC Japan 225 index feed" },
];

interface Candle { epoch: number; open: number; high: number; low: number; close: number }

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const iso = (epoch: number) => new Date(epoch * 1000).toISOString().replace(".000Z", "Z");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class DerivSocket {
  private ws!: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (raw: string) => void; reject: (e: Error) => void }>();
  private last = 0;
  async open(): Promise<void> {
    this.ws = new WebSocket(DERIV_PUBLIC_WS);
    await new Promise<void>((resolve, reject) => { this.ws.onopen = () => resolve(); this.ws.onerror = () => reject(new Error("deriv socket error")); });
    this.ws.onmessage = (m) => {
      const raw = String(m.data);
      const id = (JSON.parse(raw) as { req_id?: number }).req_id;
      const p = id === undefined ? undefined : this.pending.get(id);
      if (p) { this.pending.delete(id!); p.resolve(raw); }
    };
    this.ws.onclose = () => { for (const p of this.pending.values()) p.reject(new Error("deriv socket closed")); this.pending.clear(); };
  }
  private once(payload: Record<string, unknown>): Promise<string> {
    const req_id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(req_id); reject(new Error(`timeout ${JSON.stringify(payload)}`)); }, 30_000);
      this.pending.set(req_id, { resolve: (r) => { clearTimeout(timer); resolve(r); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.ws.send(JSON.stringify({ ...payload, req_id }));
    });
  }
  /**
   * Paced request. A RateLimit reply waits and retries the SAME request; a
   * dropped or silent socket (Deriv closes idle connections during the wait) is
   * reopened and the same request retried. Nothing is ever skipped.
   */
  async request(payload: Record<string, unknown>): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      if (attempt > MAX_RETRIES) throw new Error(`gave up after ${MAX_RETRIES} retries: ${JSON.stringify(payload)}`);
      const wait = this.last + REQUEST_GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      this.last = Date.now();
      let raw: string;
      try {
        if (this.ws.readyState !== WebSocket.OPEN) await this.open();
        raw = await this.once(payload);
      } catch (e) {
        console.log(`  socket problem (${(e as Error).message.slice(0, 60)}); reconnecting`);
        try { this.ws.close(); } catch { /* already closed */ }
        await sleep(5_000);
        await this.open();
        continue;
      }
      const err = (JSON.parse(raw) as { error?: { code?: string } }).error;
      if (err?.code !== "RateLimit") return raw;
      console.log(`  rate limited; waiting ${RATE_LIMIT_WAIT_MS / 1000}s`);
      await sleep(RATE_LIMIT_WAIT_MS);
    }
  }
  close() { this.ws.close(); }
}

function wellFormed(c: Candle): boolean {
  return [c.open, c.high, c.low, c.close].every((x) => typeof x === "number" && Number.isFinite(x) && x > 0)
    && c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close) && Number.isSafeInteger(c.epoch);
}

async function fetchSeries(sock: DerivSocket, symbol: string, tf: IntradayTimeframe) {
  const gran = TIMEFRAME_SECONDS[tf];
  const windowEnd = Date.parse(WINDOW_END) / 1000;
  const windowStart = Date.parse(WINDOW_START[tf]!) / 1000;
  const kept = new Map<number, Candle>();
  const raws: string[] = [];
  let partial = 0, outsideWindow = 0, boundaryChecks = 0, beforeStart = 0;
  let end = windowEnd - 1;
  let pages = 0;
  for (; pages < MAX_PAGES; pages++) {
    const raw = await sock.request({ ticks_history: symbol, style: "candles", granularity: gran, end, count: 5000 });
    raws.push(raw);
    const msg = JSON.parse(raw) as { error?: { code: string; message: string }; candles?: Candle[]; echo_req?: { ticks_history?: string } };
    if (msg.error) throw new Error(`${symbol} ${tf}: ${msg.error.code} ${msg.error.message}`);
    if (msg.echo_req?.ticks_history !== symbol) throw new Error(`${symbol} ${tf}: response echoes ${msg.echo_req?.ticks_history}`);
    const candles = msg.candles ?? [];
    const oldestKept = kept.size ? Math.min(...kept.keys()) : null;
    let added = 0;
    let prev = -Infinity;
    let reachedStart = false;
    for (const c of candles) {
      if (!(c.epoch > prev)) throw new Error(`${symbol} ${tf}: candles not strictly increasing at ${c.epoch}`);
      prev = c.epoch;
      if (!wellFormed(c)) throw new Error(`${symbol} ${tf}: malformed candle ${JSON.stringify(c)}`);
      if (c.epoch % gran !== 0) { partial++; continue; }
      if (c.epoch + gran > windowEnd) { outsideWindow++; continue; }
      if (c.epoch < windowStart) { beforeStart++; reachedStart = true; continue; }
      const existing = kept.get(c.epoch);
      if (existing) {
        if (c.epoch !== oldestKept) throw new Error(`${symbol} ${tf}: unexpected overlap at ${iso(c.epoch)}`);
        if ((["open", "high", "low", "close"] as const).some((k) => existing[k] !== c[k])) {
          throw new Error(`${symbol} ${tf}: page-boundary bar ${iso(c.epoch)} differs between pages ${JSON.stringify(existing)} vs ${JSON.stringify(c)}`);
        }
        boundaryChecks++;
        continue;
      }
      kept.set(c.epoch, { epoch: c.epoch, open: c.open, high: c.high, low: c.low, close: c.close });
      added++;
    }
    if (oldestKept !== null && candles.length > 0 && !reachedStart && !candles.some((c) => c.epoch === oldestKept)) {
      throw new Error(`${symbol} ${tf}: page did not re-serve the boundary bar ${iso(oldestKept)}`);
    }
    if (reachedStart || added === 0) break;
    end = Math.min(...kept.keys()) + gran - 1;
  }
  const all = [...kept.values()].sort((a, b) => a.epoch - b.epoch);
  return { candles: all, raws, pages: raws.length, partial, outsideWindow, beforeStart, boundaryChecks };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const sock = new DerivSocket();
  await sock.open();
  const instruments: IntradayInstrumentSpec[] = [];
  const excluded: IntradayExclusion[] = [];
  try {
    for (const s of SYMBOLS) {
      for (const tf of TIMEFRAMES) {
        const r = await fetchSeries(sock, s.symbol, tf);
        console.log(`${s.symbol.padEnd(10)} ${tf.padEnd(4)} pages ${r.pages} closed ${r.candles.length} ${r.candles.length ? iso(r.candles[0]!.epoch) : "-"} partial-dropped ${r.partial} boundary-checks ${r.boundaryChecks}`);
        if (r.candles.length < MIN_BARS) {
          excluded.push({ symbol: s.symbol, timeframe: tf, closedBarsAvailable: r.candles.length,
            reason: `only ${r.candles.length} closed ${tf} bars in the window (< ${MIN_BARS}); not padded` });
          continue;
        }
        const bars: FixtureBar[] = r.candles.map((c) => ({ t: iso(c.epoch), o: String(c.open), h: String(c.high), l: String(c.low), c: String(c.close) }));
        const body = serialiseBarsCsv(bars, "ohlc");
        const file = `${s.symbol}.deriv.${tf}.csv`;
        writeFileSync(join(OUT_DIR, file), body);
        instruments.push({
          symbol: s.symbol, assetClass: s.assetClass, timeframe: tf, ohlc: "ohlc", file,
          sha256: sha256(body), bars: bars.length, first: bars[0]!.t, last: bars.at(-1)!.t,
          source: {
            name: "deriv-public-ws",
            url: DERIV_PUBLIC_WS,
            request: `ticks_history ${s.symbol} style=candles granularity=${TIMEFRAME_SECONDS[tf]} paged backwards from end=${WINDOW_END} to ${WINDOW_START[tf]}`,
            upstreamVerification: `${r.pages} response pages; ${r.boundaryChecks} page-boundary bars re-served complete and matched exactly; prices kept as served`,
            upstreamDigest: sha256(r.raws.join("\n")),
            dropped: { partial: r.partial, outsideWindow: r.outsideWindow + r.beforeStart },
            note: s.note,
          },
        });
      }
    }
  } finally {
    sock.close();
  }
  const manifest: IntradayFixtureManifest = {
    version: MARKETS_MANIFEST_VERSION,
    retrievedOn: new Date().toISOString().slice(0, 10),
    windowEnd: WINDOW_END,
    barCapPerSeries: 0,
    datasetHash: intradayDatasetHashOf(instruments),
    syntheticData: false,
    instruments,
    excluded,
  };
  writeFileSync(join(OUT_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${instruments.length} series (${excluded.length} excluded); datasetHash=${manifest.datasetHash}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
