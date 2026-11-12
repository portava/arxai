// The pinned SLOW-HORIZON fixture: decades of daily FX fixings and monthly
// short-term interest rates, for direction research at monthly horizons
// (time-series momentum, carry). Hash-verified exactly like real-history-v1:
// every file re-hashes to its manifest sha256, the manifest's dataset hash
// re-derives, and it must equal the hash pinned in code. No "load anyway" path.
//
// Sources (all via FRED, https://fred.stlouisfed.org):
//   - FX: Federal Reserve Board H.10 noon buying rates (public domain), one
//     fixing per business day. Close only: no ranges are claimed.
//   - Rates: OECD Main Economic Indicators short-term rates (CC BY 4.0, OECD),
//     and for early Japan the IMF discount rate series FRED republishes. Monthly
//     averages. Which series supplies each month is recorded per row.
//
// Deliberately NOT included: equity indices (publisher-licensed; this
// repository is public) and gold (FRED no longer carries the LBMA fixing).

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stableStringify } from "@workspace/discovery";

export const SLOW_FIXTURE_DIR_NAME = "slow-history-v1";
export const SLOW_MANIFEST_VERSION = "arx-slow-history-fixture-v1";
/** Pinned dataset identity. Change only with a deliberate re-fetch. */
export const PINNED_SLOW_DATASET_HASH = "e255ddfbc69ccb8f6f9cf97d27737059b475588f25b5c3086b2dbd8d92294415";

/** A currency's FX series against USD and its short-rate sources, in priority order. */
export interface SlowCurrencySpec {
  ccy: string;
  /** FRED H.10 series id. */
  fxSeries: string;
  /** true when FRED quotes foreign units per USD (the series is inverted to USD per unit). */
  fxInverted: boolean;
  /** FRED rate series ids, first available wins per month. */
  rateSeries: string[];
}

export const SLOW_CURRENCIES: readonly SlowCurrencySpec[] = [
  { ccy: "EUR", fxSeries: "DEXUSEU", fxInverted: false, rateSeries: ["IR3TIB01EZM156N", "IR3TIB01DEM156N"] },
  { ccy: "GBP", fxSeries: "DEXUSUK", fxInverted: false, rateSeries: ["IR3TIB01GBM156N"] },
  { ccy: "JPY", fxSeries: "DEXJPUS", fxInverted: true, rateSeries: ["IR3TIB01JPM156N", "IRSTCI01JPM156N", "INTDSRJPM193N"] },
  { ccy: "AUD", fxSeries: "DEXUSAL", fxInverted: false, rateSeries: ["IR3TIB01AUM156N"] },
  { ccy: "CAD", fxSeries: "DEXCAUS", fxInverted: true, rateSeries: ["IR3TIB01CAM156N"] },
  { ccy: "CHF", fxSeries: "DEXSZUS", fxInverted: true, rateSeries: ["IR3TIB01CHM156N", "IRSTCI01CHM156N"] },
  { ccy: "NZD", fxSeries: "DEXUSNZ", fxInverted: false, rateSeries: ["IR3TIB01NZM156N"] },
  { ccy: "NOK", fxSeries: "DEXNOUS", fxInverted: true, rateSeries: ["IR3TIB01NOM156N"] },
  { ccy: "SEK", fxSeries: "DEXSDUS", fxInverted: true, rateSeries: ["IR3TIB01SEM156N"] },
];
export const USD_RATE_SERIES = ["IR3TIB01USM156N", "TB3MS"];
export const SLOW_WINDOW = { start: "1971-01-01", end: "2026-10-31" } as const;

export interface SlowFileSpec { file: string; kind: "fx_daily" | "rate_monthly"; series: string; sha256: string; rows: number; first: string; last: string; url: string; license: string }
export interface SlowManifest { version: typeof SLOW_MANIFEST_VERSION; retrievedOn: string; window: typeof SLOW_WINDOW; datasetHash: string; syntheticData: false; files: SlowFileSpec[] }

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
export const slowDatasetHashOf = (files: readonly SlowFileSpec[]) => sha256(stableStringify(files));

export class SlowFixtureIntegrityError extends Error {
  constructor(m: string) { super(m); this.name = "SlowFixtureIntegrityError"; }
}

/** One series as [date, value] rows, strictly increasing dates, finite values. */
export type Series = Array<[string, number]>;

function parseSeries(body: string, file: string): Series {
  const out: Series = [];
  for (const line of body.trim().split("\n").slice(1)) {
    const [d, v] = line.split(",");
    const x = Number(v);
    if (!d || !Number.isFinite(x)) throw new SlowFixtureIntegrityError(`${file}: bad row "${line}"`);
    if (out.length && d <= out[out.length - 1]![0]) throw new SlowFixtureIntegrityError(`${file}: dates not increasing at ${d}`);
    out.push([d, x]);
  }
  return out;
}

export function loadVerifiedSlowFixture(fixturesRoot: string, pinned: string = PINNED_SLOW_DATASET_HASH): { manifest: SlowManifest; series: Map<string, Series> } {
  const dir = join(fixturesRoot, SLOW_FIXTURE_DIR_NAME);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as SlowManifest;
  if (manifest.version !== SLOW_MANIFEST_VERSION) throw new SlowFixtureIntegrityError(`unknown manifest version ${String(manifest.version)}`);
  if (manifest.syntheticData !== false) throw new SlowFixtureIntegrityError("manifest does not attest syntheticData=false");
  const derived = slowDatasetHashOf(manifest.files);
  if (derived !== manifest.datasetHash) throw new SlowFixtureIntegrityError(`dataset hash ${derived} does not match manifest ${manifest.datasetHash}`);
  if (derived !== pinned) throw new SlowFixtureIntegrityError(`dataset hash ${derived} is not the pinned ${pinned}`);
  const series = new Map<string, Series>();
  for (const f of manifest.files) {
    const body = readFileSync(join(dir, f.file), "utf8");
    if (sha256(body) !== f.sha256) throw new SlowFixtureIntegrityError(`${f.file} does not match its sha256`);
    const s = parseSeries(body, f.file);
    if (s.length !== f.rows) throw new SlowFixtureIntegrityError(`${f.file}: ${s.length} rows, manifest says ${f.rows}`);
    series.set(f.series, s);
  }
  return { manifest, series };
}

export function serialiseSeries(rows: Series, valueHeader: string): string {
  return `date,${valueHeader}\n${rows.map(([d, v]) => `${d},${v}`).join("\n")}\n`;
}
