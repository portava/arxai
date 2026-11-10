// The pinned INTRADAY real-history fixture: format, manifest, hash-verified loading.
//
// Same contract as the daily fixture (realHistoryFixture.ts): a file is used
// ONLY after its bytes re-hash to the manifest's sha256, the manifest's dataset
// hash re-derives over every instrument spec, and that hash equals the one the
// caller pins in code. Any mismatch throws FixtureIntegrityError; there is no
// "load anyway" path.
//
// Source: Deriv's public market-data WebSocket (no account, no auth) — the feed
// ARX actually trades for V-indices and Deriv FX/metal. Produced only by
// fetchIntradayHistoryFixture.ts, by hand; CI only re-verifies.
//
// Nothing here generates data.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Bar } from "@workspace/validation";
import { stableStringify } from "@workspace/discovery";
import { createHash } from "node:crypto";
import { FixtureIntegrityError, parseBarsCsv } from "./realHistoryFixture.js";

export const INTRADAY_FIXTURE_DIR_NAME = "real-history-intraday-v1";
export const INTRADAY_MANIFEST_VERSION = "arx-real-history-intraday-fixture-v1";

export type IntradayTimeframe = "M1" | "M5" | "M15" | "H1";
export const TIMEFRAME_SECONDS: Record<IntradayTimeframe, number> = { M1: 60, M5: 300, M15: 900, H1: 3600 };
export const TIMEFRAME_ORDER: readonly IntradayTimeframe[] = ["M1", "M5", "M15", "H1"];

export interface IntradayInstrumentSpec {
  /** Deriv symbol, e.g. R_75, 1HZ100V, frxEURUSD. */
  symbol: string;
  /** "synthetic" = Deriv Volatility index (driftless by construction). */
  assetClass: "synthetic" | "fx" | "metal";
  timeframe: IntradayTimeframe;
  ohlc: "ohlc";
  file: string;
  sha256: string;
  bars: number;
  /** ISO open time of the first / last bar (UTC). */
  first: string;
  last: string;
  source: {
    name: "deriv-public-ws";
    url: string;
    request: string;
    /** Response pages fetched, and how each page boundary was cross-checked. */
    upstreamVerification: string;
    /** sha256 over every raw response message, in order. */
    upstreamDigest: string;
    /** Candles dropped as partial (non-aligned) or beyond the pinned window. */
    dropped: { partial: number; outsideWindow: number };
    note: string;
  };
}

export interface IntradayExclusion { symbol: string; timeframe: IntradayTimeframe; closedBarsAvailable: number; reason: string }

export interface IntradayFixtureManifest {
  version: typeof INTRADAY_MANIFEST_VERSION;
  retrievedOn: string;
  /** Every series ends at the last bar that CLOSED at or before this instant. */
  windowEnd: string;
  barCapPerSeries: number;
  /** sha256 over stableStringify(instruments). */
  datasetHash: string;
  syntheticData: false;
  instruments: IntradayInstrumentSpec[];
  /** Requested series that are NOT in the fixture, and why. Reported, never padded. */
  excluded: IntradayExclusion[];
}

export interface LoadedIntradayInstrument { spec: IntradayInstrumentSpec; dates: string[]; bars: Bar[] }

const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

export function intradayDatasetHashOf(instruments: readonly IntradayInstrumentSpec[]): string {
  return sha256(stableStringify(instruments));
}

export function loadVerifiedIntradayFixture(dir: string, pinnedDatasetHash: string): { manifest: IntradayFixtureManifest; instruments: LoadedIntradayInstrument[] } {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as IntradayFixtureManifest;
  if (manifest.version !== INTRADAY_MANIFEST_VERSION) throw new FixtureIntegrityError(`unknown manifest version ${String(manifest.version)}`);
  if (manifest.syntheticData !== false) throw new FixtureIntegrityError("manifest does not attest syntheticData=false");
  const derived = intradayDatasetHashOf(manifest.instruments);
  if (derived !== manifest.datasetHash) throw new FixtureIntegrityError(`manifest datasetHash ${manifest.datasetHash} does not re-derive (${derived})`);
  if (derived !== pinnedDatasetHash) throw new FixtureIntegrityError(`dataset hash ${derived} is not the pinned ${pinnedDatasetHash}`);
  const instruments = manifest.instruments.map((spec) => {
    const body = readFileSync(join(dir, spec.file), "utf8");
    const actual = sha256(body);
    if (actual !== spec.sha256) throw new FixtureIntegrityError(`${spec.file}: sha256 ${actual} ≠ manifest ${spec.sha256}`);
    const { dates, bars } = parseBarsCsv(body, "ohlc");
    if (bars.length !== spec.bars || dates[0] !== spec.first || dates.at(-1) !== spec.last) {
      throw new FixtureIntegrityError(`${spec.file}: bar count/range disagrees with manifest`);
    }
    // Every open time must sit on the timeframe grid: a non-aligned bar is a
    // partial bucket and must never have been written.
    const step = TIMEFRAME_SECONDS[spec.timeframe] * 1000;
    if (dates.some((d) => Date.parse(d) % step !== 0)) throw new FixtureIntegrityError(`${spec.file}: a bar is off the ${spec.timeframe} grid`);
    if (Date.parse(spec.last) + step > Date.parse(manifest.windowEnd)) throw new FixtureIntegrityError(`${spec.file}: last bar had not closed by windowEnd`);
    return { spec, dates, bars };
  });
  return { manifest, instruments };
}
