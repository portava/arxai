// Fetch the pinned REAL-HISTORY fixture used by the real-data validation lane.
//
// This is the ONLY way the committed fixture under
// scripts/fixtures/real-history-v1/ is produced. It is run by hand, not in CI;
// CI only re-hashes the committed files against the manifest (and against the
// manifest hash pinned in code), so a changed byte anywhere fails the lane.
//
// SOURCES (both free, documented, no account or key):
//
//   1. Binance public market-data archive — https://data.binance.vision
//      (documented at https://github.com/binance/binance-public-data).
//      Spot daily klines, one zip per month. Every zip is verified against the
//      upstream `.CHECKSUM` file Binance publishes next to it BEFORE it is
//      parsed; a mismatch aborts the whole fetch. Real exchange OHLC.
//
//   2. FRED (Federal Reserve Bank of St. Louis) — https://fred.stlouisfed.org
//      H.10 noon-buying-rate FX series (Board of Governors data: public domain).
//      CLOSE ONLY: FRED publishes one daily fixing, not OHLC. The fixture says
//      so (`ohlc: "close_only"`), and the runner reports every wick-dependent
//      family on those instruments as running on DERIVED ranges, never as if
//      real wicks had been observed.
//
//   Deliberately NOT included: FRED's equity-index series (SP500, DJIA,
//   NASDAQCOM). They are licensed by their index publishers with reproduction
//   restricted, and this repository is public. Indices enter the real-data
//   runner through stored market_candles / broker_candles instead.
//
// Usage (network required; run from arxai/):
//   pnpm --filter @workspace/scripts exec tsx ./src/research/fetchRealHistoryFixture.ts

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  REAL_HISTORY_FIXTURE_DIR_NAME,
  buildManifest,
  serialiseBarsCsv,
  type FixtureBar,
  type FixtureInstrumentSpec,
} from "./realHistoryFixture.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "..", "..", "fixtures", REAL_HISTORY_FIXTURE_DIR_NAME);

/** Last month/day included. Fixed so the fixture is a pinned, finite window. */
const END_MONTH = "2025-10";
const END_DATE = "2025-10-31";

const BINANCE: Array<{ symbol: string; assetClass: FixtureInstrumentSpec["assetClass"]; startMonth: string; note: string }> = [
  { symbol: "BTCUSDT", assetClass: "crypto", startMonth: "2018-01", note: "Bitcoin vs Tether, Binance spot" },
  { symbol: "ETHUSDT", assetClass: "crypto", startMonth: "2018-01", note: "Ether vs Tether, Binance spot" },
  { symbol: "PAXGUSDT", assetClass: "metal", startMonth: "2020-09", note: "PAX Gold (1 token = 1 troy oz LBMA gold) vs Tether, Binance spot — a traded gold proxy, not the LBMA fix" },
  { symbol: "EURUSDT", assetClass: "fx", startMonth: "2020-01", note: "Euro vs Tether, Binance spot — real FX OHLC on a crypto venue" },
];

const FRED: Array<{ series: string; symbol: string; invert: boolean; note: string }> = [
  { series: "DEXUSEU", symbol: "EURUSD", invert: false, note: "FRED H.10 U.S. dollars to one euro" },
  { series: "DEXUSUK", symbol: "GBPUSD", invert: false, note: "FRED H.10 U.S. dollars to one pound" },
  { series: "DEXJPUS", symbol: "USDJPY", invert: false, note: "FRED H.10 Japanese yen to one U.S. dollar" },
  { series: "DEXUSAL", symbol: "AUDUSD", invert: false, note: "FRED H.10 U.S. dollars to one Australian dollar" },
  { series: "DEXCAUS", symbol: "USDCAD", invert: false, note: "FRED H.10 Canadian dollars to one U.S. dollar" },
  { series: "DEXSZUS", symbol: "USDCHF", invert: false, note: "FRED H.10 Swiss francs to one U.S. dollar" },
];
const FRED_START = "2010-01-01";

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

async function get(url: string): Promise<Buffer | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { headers: { "user-agent": "arx-research-fixture-fetcher" } });
    if (res.status === 404) return null;
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
  throw new Error(`fetch failed after retries: ${url}`);
}

function months(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split("-").map(Number) as [number, number];
  const [ty, tm] = to.split("-").map(Number) as [number, number];
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

async function fetchBinance(symbol: string, startMonth: string, scratch: string): Promise<{ bars: FixtureBar[]; upstream: string[] }> {
  const bars: FixtureBar[] = [];
  const upstream: string[] = [];
  for (const month of months(startMonth, END_MONTH)) {
    const name = `${symbol}-1d-${month}.zip`;
    const url = `https://data.binance.vision/data/spot/monthly/klines/${symbol}/1d/${name}`;
    const zip = await get(url);
    if (!zip) throw new Error(`missing month ${name} — the window must be contiguous`);
    const checksumFile = await get(`${url}.CHECKSUM`);
    if (!checksumFile) throw new Error(`no upstream CHECKSUM for ${name}; refusing unverified data`);
    const expected = checksumFile.toString("utf8").trim().split(/\s+/)[0]!;
    const actual = sha256(zip);
    if (expected !== actual) throw new Error(`CHECKSUM MISMATCH ${name}: upstream ${expected} vs downloaded ${actual}`);
    upstream.push(`${name} sha256=${actual}`);
    const zipPath = join(scratch, name);
    writeFileSync(zipPath, zip);
    const csv = execFileSync("unzip", ["-p", zipPath], { encoding: "utf8" });
    for (const line of csv.split(/\r?\n/)) {
      if (!line || !/^\d/.test(line)) continue; // header rows (newer files) are skipped
      const f = line.split(",");
      let t = Number(f[0]);
      // Binance switched spot timestamps to MICROseconds from 2025-01-01.
      if (t > 1e14) t = Math.floor(t / 1000);
      bars.push({ t: new Date(t).toISOString().slice(0, 10), o: f[1]!, h: f[2]!, l: f[3]!, c: f[4]! });
    }
  }
  return { bars, upstream };
}

async function fetchFred(series: string): Promise<{ bars: FixtureBar[]; rawSha256: string }> {
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${series}&cosd=${FRED_START}&coed=${END_DATE}`;
  const raw = await get(url);
  if (!raw) throw new Error(`FRED series ${series} not found`);
  const bars: FixtureBar[] = [];
  for (const line of raw.toString("utf8").split(/\r?\n/).slice(1)) {
    const [d, v] = line.split(",");
    // FRED marks market holidays with "." or an empty value: no fixing that day.
    // They are DROPPED, never filled — a filled bar is an invented price.
    if (!d || !v || v === "." || !(Number(v) > 0)) continue;
    if (d < FRED_START || d > END_DATE) continue;
    bars.push({ t: d, c: v });
  }
  return { bars, rawSha256: sha256(raw) };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), "arx-fixture-"));
  const specs: FixtureInstrumentSpec[] = [];
  try {
    for (const b of BINANCE) {
      console.log(`binance ${b.symbol} …`);
      const { bars, upstream } = await fetchBinance(b.symbol, b.startMonth, scratch);
      const file = `${b.symbol}.binance.1d.csv`;
      const body = serialiseBarsCsv(bars, "ohlc");
      writeFileSync(join(OUT_DIR, file), body);
      specs.push({
        symbol: b.symbol, assetClass: b.assetClass, timeframe: "1d", ohlc: "ohlc", file,
        sha256: sha256(body), bars: bars.length, first: bars[0]!.t, last: bars.at(-1)!.t,
        source: {
          name: "binance-public-data",
          url: `https://data.binance.vision/data/spot/monthly/klines/${b.symbol}/1d/`,
          upstreamVerification: `every monthly zip matched its published .CHECKSUM (${upstream.length} files)`,
          upstreamDigest: sha256(upstream.join("\n")),
          note: b.note,
        },
      });
    }
    for (const f of FRED) {
      console.log(`fred ${f.series} …`);
      const { bars, rawSha256 } = await fetchFred(f.series);
      const file = `${f.symbol}.fred-${f.series}.1d.csv`;
      const body = serialiseBarsCsv(bars, "close_only");
      writeFileSync(join(OUT_DIR, file), body);
      specs.push({
        symbol: f.symbol, assetClass: "fx", timeframe: "1d", ohlc: "close_only", file,
        sha256: sha256(body), bars: bars.length, first: bars[0]!.t, last: bars.at(-1)!.t,
        source: {
          name: "fred",
          url: `https://fred.stlouisfed.org/series/${f.series}`,
          upstreamVerification: "FRED publishes no checksum; the raw download digest is recorded and the committed file is pinned by sha256",
          upstreamDigest: rawSha256,
          note: `${f.note}. Public domain (Board of Governors H.10). Close-only daily fixing.`,
        },
      });
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const manifest = buildManifest(specs, new Date().toISOString().slice(0, 10));
  writeFileSync(join(OUT_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${specs.length} instruments; datasetHash=${manifest.datasetHash}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
