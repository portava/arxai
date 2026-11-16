// Fetch the pinned INTRADAY real-history fixture (scripts/fixtures/real-history-intraday-v1/).
//
// This is the ONLY way that fixture is produced. It is run by hand, not in CI;
// CI only re-hashes the committed files against the manifest and against the
// dataset hash pinned in code.
//
// SOURCE: Deriv's public market-data WebSocket — the same public endpoint the
// API server's DerivPublicDataClient uses (no account, no token, no authorize).
// Only `ticks_history` with `style: "candles"` is sent. These are the feeds ARX
// actually trades: Volatility indices (R_50, R_75, R_100, 1HZ75V, 1HZ100V) and
// Deriv FX/metal (frxEURUSD, frxGBPUSD, frxUSDJPY, frxXAUUSD).
//
// HOW THE CANDLES ARE KEPT HONEST
//   - The window is PINNED: every series ends at the last bar that closed at or
//     before WINDOW_END. No forming bar can enter.
//   - Deriv serves history in pages bounded by time; the first candle of a page
//     is a PARTIAL bucket whose epoch is off the timeframe grid. Every
//     non-aligned candle is dropped and counted.
//   - Each next page is requested to END exactly at the close of the oldest
//     bar already kept, so that bar is served again, complete, in the next page.
//     Its OHLC must match byte-for-byte or the whole fetch aborts — every page
//     boundary is cross-checked, not assumed.
//   - Malformed OHLC (high < max(open, close), etc.) aborts the fetch.
//   - Missing bars (FX weekends, quiet minutes) stay missing. Nothing is filled.
//   - A series is included only if it reaches BAR_CAP closed bars; shorter ones
//     are listed under `excluded` with the count that was available.
//
// Usage (network required; run from arxai/):
//   pnpm --filter @workspace/scripts exec tsx ./src/research/fetchIntradayHistoryFixture.ts

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { serialiseBarsCsv, type FixtureBar } from "./realHistoryFixture.js";
import {
  INTRADAY_FIXTURE_DIR_NAME,
  INTRADAY_MANIFEST_VERSION,
  TIMEFRAME_ORDER,
  TIMEFRAME_SECONDS,
  intradayDatasetHashOf,
  type IntradayExclusion,
  type IntradayFixtureManifest,
  type IntradayInstrumentSpec,
  type IntradayTimeframe,
} from "./intradayHistoryFixture.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "..", "..", "fixtures", INTRADAY_FIXTURE_DIR_NAME);

export const DERIV_PUBLIC_WS = "wss://api.derivws.com/trading/v1/options/ws/public";
/** Fixed window end (a Tuesday, mid-session). Bars must have CLOSED by then. */
export const WINDOW_END = "2026-11-10T12:00:00Z";
/** Bars per series. Keeps the fixture a few MB while giving CPCV ~500 bars a group. */
export const BAR_CAP = 3000;
const MAX_PAGES = 40;

const SYMBOLS: Array<{ symbol: string; assetClass: IntradayInstrumentSpec["assetClass"]; note: string }> = [
  { symbol: "R_50", assetClass: "synthetic", note: "Deriv Volatility 50 Index — synthetic, driftless by construction" },
  { symbol: "R_75", assetClass: "synthetic", note: "Deriv Volatility 75 Index — synthetic, driftless by construction" },
  { symbol: "R_100", assetClass: "synthetic", note: "Deriv Volatility 100 Index — synthetic, driftless by construction" },
  { symbol: "1HZ75V", assetClass: "synthetic", note: "Deriv Volatility 75 (1s) Index — synthetic, driftless by construction" },
  { symbol: "1HZ100V", assetClass: "synthetic", note: "Deriv Volatility 100 (1s) Index — synthetic, driftless by construction" },
  { symbol: "frxEURUSD", assetClass: "fx", note: "Deriv EUR/USD feed" },
  { symbol: "frxGBPUSD", assetClass: "fx", note: "Deriv GBP/USD feed" },
  { symbol: "frxUSDJPY", assetClass: "fx", note: "Deriv USD/JPY feed" },
  { symbol: "frxXAUUSD", assetClass: "metal", note: "Deriv XAU/USD (gold) feed" },
];

interface Candle { epoch: number; open: number; high: number; low: number; close: number }

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const iso = (epoch: number) => new Date(epoch * 1000).toISOString().replace(".000Z", "Z");

class DerivSocket {
  private ws!: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (raw: string) => void; reject: (e: Error) => void }>();
  async open(): Promise<void> {
    this.ws = new WebSocket(DERIV_PUBLIC_WS);
    await new Promise<void>((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error("deriv socket error"));
    });
    this.ws.onmessage = (m) => {
      const raw = String(m.data);
      const id = (JSON.parse(raw) as { req_id?: number }).req_id;
      const p = id === undefined ? undefined : this.pending.get(id);
      if (p) { this.pending.delete(id!); p.resolve(raw); }
    };
    this.ws.onclose = () => { for (const p of this.pending.values()) p.reject(new Error("deriv socket closed")); this.pending.clear(); };
  }
  request(payload: Record<string, unknown>): Promise<string> {
    const req_id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(req_id); reject(new Error(`timeout ${JSON.stringify(payload)}`)); }, 30_000);
      this.pending.set(req_id, { resolve: (r) => { clearTimeout(timer); resolve(r); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.ws.send(JSON.stringify({ ...payload, req_id }));
    });
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
  const kept = new Map<number, Candle>();
  const raws: string[] = [];
  let partial = 0;
  let outsideWindow = 0;
  let boundaryChecks = 0;
  let end = windowEnd - 1;
  let pages = 0;
  for (; pages < MAX_PAGES && kept.size < BAR_CAP; pages++) {
    const raw = await sock.request({ ticks_history: symbol, style: "candles", granularity: gran, end, count: 5000 });
    raws.push(raw);
    const msg = JSON.parse(raw) as { error?: { code: string; message: string }; candles?: Candle[]; echo_req?: { ticks_history?: string } };
    if (msg.error) throw new Error(`${symbol} ${tf}: ${msg.error.code} ${msg.error.message}`);
    if (msg.echo_req?.ticks_history !== symbol) throw new Error(`${symbol} ${tf}: response echoes ${msg.echo_req?.ticks_history}`);
    const candles = msg.candles ?? [];
    const oldestKept = kept.size ? Math.min(...kept.keys()) : null;
    let added = 0;
    let prev = -Infinity;
    for (const c of candles) {
      if (!(c.epoch > prev)) throw new Error(`${symbol} ${tf}: candles not strictly increasing at ${c.epoch}`);
      prev = c.epoch;
      if (!wellFormed(c)) throw new Error(`${symbol} ${tf}: malformed candle ${JSON.stringify(c)}`);
      if (c.epoch % gran !== 0) { partial++; continue; }
      if (c.epoch + gran > windowEnd) { outsideWindow++; continue; }
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
    if (oldestKept !== null && candles.length > 0 && !candles.some((c) => c.epoch === oldestKept)) {
      throw new Error(`${symbol} ${tf}: page did not re-serve the boundary bar ${iso(oldestKept)}`);
    }
    if (added === 0) break; // history exhausted
    // Next page ends at the CLOSE of the oldest kept bar: that bar comes back complete and is compared.
    end = Math.min(...kept.keys()) + gran - 1;
  }
  const all = [...kept.values()].sort((a, b) => a.epoch - b.epoch);
  return { candles: all.slice(-BAR_CAP), available: all.length, raws, pages: raws.length, partial, outsideWindow, boundaryChecks };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const sock = new DerivSocket();
  await sock.open();
  const instruments: IntradayInstrumentSpec[] = [];
  const excluded: IntradayExclusion[] = [];
  try {
    for (const s of SYMBOLS) {
      for (const tf of TIMEFRAME_ORDER) {
        const r = await fetchSeries(sock, s.symbol, tf);
        console.log(`${s.symbol.padEnd(10)} ${tf.padEnd(4)} pages ${r.pages} closed ${r.available} partial-dropped ${r.partial} boundary-checks ${r.boundaryChecks}`);
        if (r.candles.length < BAR_CAP) {
          excluded.push({ symbol: s.symbol, timeframe: tf, closedBarsAvailable: r.available,
            reason: `Deriv public history holds only ${r.available} closed ${tf} bars before ${WINDOW_END} (< cap ${BAR_CAP}); not padded` });
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
            request: `ticks_history ${s.symbol} style=candles granularity=${TIMEFRAME_SECONDS[tf]} paged backwards from end=${WINDOW_END}`,
            upstreamVerification: `${r.pages} response pages; ${r.boundaryChecks} page-boundary bars re-served complete and matched exactly; prices kept as served`,
            upstreamDigest: sha256(r.raws.join("\n")),
            dropped: { partial: r.partial, outsideWindow: r.outsideWindow },
            note: s.note,
          },
        });
      }
    }
  } finally {
    sock.close();
  }
  const manifest: IntradayFixtureManifest = {
    version: INTRADAY_MANIFEST_VERSION,
    retrievedOn: new Date().toISOString().slice(0, 10),
    windowEnd: WINDOW_END,
    barCapPerSeries: BAR_CAP,
    datasetHash: intradayDatasetHashOf(instruments),
    syntheticData: false,
    instruments,
    excluded,
  };
  writeFileSync(join(OUT_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${instruments.length} series (${excluded.length} excluded); datasetHash=${manifest.datasetHash}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
