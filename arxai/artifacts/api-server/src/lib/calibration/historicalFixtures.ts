// Real-history fixtures for the calibration bootstrap: discovery + verification.
//
// Picks up EVERY `scripts/fixtures/real-history-*` directory that has a
// manifest.json. A fixture is used only after:
//   1. manifest.syntheticData === false (it attests recorded market data),
//   2. its datasetHash re-derives from its instrument specs (sha256 over the
//      stable-stringified specs, the same identity scripts/src/research uses),
//   3. every instrument file re-hashes to the sha256 its spec records, and its
//      bar count matches,
//   4. for a fixture pinned below, the dataset hash equals the pinned one.
// A fixture that fails any check is skipped with the reason; nothing loads
// "anyway". Unpinned fixtures that verify are used and reported pinned=false,
// with their dataset hash in every fit's provenance.
//
// Close-only sources (FRED fixings) publish one number per day. Their bars are
// built from consecutive fixings ONLY: open = previous fixing, close = this
// fixing, high/low = the larger/smaller of the two. No wick is derived, so a
// first-touch grade is never decided by a price that was not observed.
//
// Nothing here generates data.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stableStringify } from "@workspace/features/event-chain";
import type { Candle } from "../strategyEngine.js";

export const PINNED_REAL_HISTORY: Readonly<Record<string, string>> = Object.freeze({
  "real-history-v1": "fa83f149997cb8f96f7adfba349a60d409f689712311d32728755549dbc6d232",
  // Real Deriv intraday M1/M5/M15/H1 (PR #137, scripts/fixtures/real-history-intraday-v1).
  "real-history-intraday-v1": "a5f9b3cc7147bdae0e95eb7052397b2e478e018634c01bb13580a35fca9725dc",
});

export interface RealHistoryInstrumentSpec {
  symbol: string;
  timeframe: string;
  ohlc: "ohlc" | "close_only";
  file: string;
  sha256: string;
  bars: number;
  first?: string;
  last?: string;
  assetClass?: string;
  source?: { name?: string; url?: string };
}

export interface RealHistoryManifest {
  version: string;
  datasetHash: string;
  syntheticData: boolean;
  instruments: RealHistoryInstrumentSpec[];
}

export interface RealHistorySeries {
  fixtureId: string;
  datasetHash: string;
  pinned: boolean;
  spec: RealHistoryInstrumentSpec;
  /** Chart timeframe ("D1", "M5", ...). */
  timeframe: string;
  candles: Candle[];
}

export interface LoadedFixture {
  fixtureId: string;
  dir: string;
  datasetHash: string;
  pinned: boolean;
  series: RealHistorySeries[];
}

export interface FixtureDiscovery {
  root: string | null;
  fixtures: LoadedFixture[];
  skipped: { fixtureId: string; reason: string }[];
}

const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

/** "1d" → "D1", "5m" → "M5", "1h" → "H1"; chart names pass through. */
export function chartTimeframe(tf: string): string | null {
  const t = tf.trim();
  if (/^(M|H|D|W|MN)\d+$/.test(t)) return t;
  const m = /^(\d+)\s*(m|min|h|d|w)$/i.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  switch (m[2].toLowerCase()) {
    case "m":
    case "min":
      return `M${n}`;
    case "h":
      return `H${n}`;
    case "d":
      return `D${n}`;
    case "w":
      return `W${n}`;
  }
  return null;
}

function parseTime(raw: string): number {
  const s = raw.trim();
  if (/^\d+$/.test(s)) {
    const v = Number(s);
    return v < 1e12 ? v * 1000 : v;
  }
  // A bare date is that day's 00:00 UTC.
  return Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s);
}

/** Parse one fixture CSV into candles. Throws on any malformed row. */
export function parseFixtureCsv(body: string, kind: "ohlc" | "close_only"): Candle[] {
  const lines = body.trim().split(/\r?\n/);
  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const col = (names: string[]) => header.findIndex((h) => names.includes(h));
  const iT = col(["date", "time", "timestamp", "open_time", "epoch"]);
  const iO = col(["open", "o"]);
  const iH = col(["high", "h"]);
  const iL = col(["low", "l"]);
  const iC = col(["close", "c"]);
  if (iT < 0 || iC < 0) throw new Error("fixture CSV needs a time and a close column");
  if (kind === "ohlc" && (iO < 0 || iH < 0 || iL < 0)) throw new Error("ohlc fixture CSV needs open/high/low/close");
  const out: Candle[] = [];
  let prevMs = -Infinity;
  let prevClose: number | null = null;
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const f = line.split(",");
    const ms = parseTime(f[iT]);
    if (!Number.isFinite(ms) || ms <= prevMs) throw new Error(`fixture times not strictly increasing at ${f[iT]}`);
    prevMs = ms;
    const c = Number(f[iC]);
    if (!(c > 0)) throw new Error(`fixture close at ${f[iT]} is not positive`);
    let o: number;
    let h: number;
    let l: number;
    if (kind === "ohlc") {
      o = Number(f[iO]);
      h = Number(f[iH]);
      l = Number(f[iL]);
      if (![o, h, l].every((x) => x > 0) || h < Math.max(o, c) || l > Math.min(o, c)) {
        throw new Error(`fixture bar ${f[iT]} is not a valid OHLC bar`);
      }
    } else {
      o = prevClose ?? c;
      h = Math.max(o, c);
      l = Math.min(o, c);
    }
    prevClose = c;
    out.push({ time: new Date(ms).toISOString(), open: o, high: h, low: l, close: c, volume: 0 });
  }
  return out;
}

/** Find `scripts/fixtures` walking up from the cwd and from this module. */
export function findFixturesRoot(): string | null {
  const env = process.env["ARX_REAL_HISTORY_FIXTURES_ROOT"];
  if (env) return existsSync(env) ? resolve(env) : null;
  const starts = [process.cwd()];
  try {
    starts.push(dirname(fileURLToPath(import.meta.url)));
  } catch {
    // bundled without import.meta.url: cwd only
  }
  for (const start of starts) {
    let dir = resolve(start);
    for (let i = 0; i < 8; i++) {
      for (const cand of [join(dir, "scripts", "fixtures"), join(dir, "arxai", "scripts", "fixtures")]) {
        if (existsSync(cand) && statSync(cand).isDirectory()) return cand;
      }
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return null;
}

export function loadFixtureDir(fixtureId: string, dir: string): LoadedFixture {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as RealHistoryManifest;
  if (manifest.syntheticData !== false) throw new Error("manifest does not attest syntheticData=false");
  if (!Array.isArray(manifest.instruments) || manifest.instruments.length === 0) throw new Error("manifest lists no instruments");
  const derived = sha256(stableStringify(manifest.instruments));
  if (derived !== manifest.datasetHash) throw new Error(`datasetHash ${manifest.datasetHash} does not re-derive (${derived})`);
  const pinnedHash = PINNED_REAL_HISTORY[fixtureId];
  if (pinnedHash && pinnedHash !== derived) throw new Error(`dataset hash ${derived} is not the pinned ${pinnedHash}`);
  const series: RealHistorySeries[] = [];
  for (const spec of manifest.instruments) {
    const body = readFileSync(join(dir, spec.file));
    const actual = sha256(body);
    if (actual !== spec.sha256) throw new Error(`${spec.file}: sha256 ${actual} != manifest ${spec.sha256}`);
    const tf = chartTimeframe(spec.timeframe);
    if (!tf) throw new Error(`${spec.file}: unknown timeframe ${spec.timeframe}`);
    const candles = parseFixtureCsv(body.toString("utf8"), spec.ohlc);
    if (candles.length !== spec.bars) throw new Error(`${spec.file}: ${candles.length} bars, manifest says ${spec.bars}`);
    series.push({ fixtureId, datasetHash: derived, pinned: Boolean(pinnedHash), spec, timeframe: tf, candles });
  }
  return { fixtureId, dir, datasetHash: derived, pinned: Boolean(pinnedHash), series };
}

/** Every verified real-history fixture under the fixtures root. */
export function discoverRealHistoryFixtures(root: string | null = findFixturesRoot()): FixtureDiscovery {
  const out: FixtureDiscovery = { root, fixtures: [], skipped: [] };
  if (!root) return out;
  const ids = readdirSync(root)
    .filter((d) => d.startsWith("real-history-") && existsSync(join(root, d, "manifest.json")))
    .sort();
  for (const id of ids) {
    try {
      out.fixtures.push(loadFixtureDir(id, join(root, id)));
    } catch (e) {
      out.skipped.push({ fixtureId: id, reason: String((e as Error)?.message ?? e).slice(0, 240) });
    }
  }
  // A pinned fixture that is missing is reported, never silently ignored.
  for (const id of Object.keys(PINNED_REAL_HISTORY)) {
    if (!ids.includes(id)) out.skipped.push({ fixtureId: id, reason: "pinned fixture not found under the fixtures root" });
  }
  return out;
}
