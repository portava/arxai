// The pinned real-history fixture: format, manifest, and hash-verified loading.
//
// A fixture file is used ONLY after:
//   1. its bytes re-hash to the sha256 recorded in manifest.json, AND
//   2. the manifest's dataset hash (over every instrument spec, file hashes
//      included) re-derives, AND
//   3. that dataset hash equals the one pinned in code by the caller.
// Any mismatch throws. There is no "load anyway" path: a dataset that does not
// verify is not the dataset the results claim to be about.
//
// Nothing here generates data. Synthetic series live in @workspace/validation's
// nullOracle and are never written into this directory.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Bar } from "@workspace/validation";
import { stableStringify } from "@workspace/discovery";

export const REAL_HISTORY_FIXTURE_DIR_NAME = "real-history-v1";
export const REAL_HISTORY_MANIFEST_VERSION = "arx-real-history-fixture-v1";

export interface FixtureBar { t: string; o?: string; h?: string; l?: string; c: string }

export interface FixtureInstrumentSpec {
  symbol: string;
  assetClass: "fx" | "crypto" | "metal" | "index";
  timeframe: "1d";
  /** "close_only" ⇒ the source publishes one fixing per day; ranges are DERIVED. */
  ohlc: "ohlc" | "close_only";
  file: string;
  sha256: string;
  bars: number;
  first: string;
  last: string;
  source: { name: string; url: string; upstreamVerification: string; upstreamDigest: string; note: string };
}

export interface FixtureManifest {
  version: typeof REAL_HISTORY_MANIFEST_VERSION;
  retrievedOn: string;
  /** sha256 over stableStringify(instruments) — the dataset identity. */
  datasetHash: string;
  syntheticData: false;
  instruments: FixtureInstrumentSpec[];
}

export interface LoadedInstrument {
  spec: FixtureInstrumentSpec;
  /** ISO date per bar. */
  dates: string[];
  bars: Bar[];
}

const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

export function datasetHashOf(instruments: readonly FixtureInstrumentSpec[]): string {
  return sha256(stableStringify(instruments));
}

export function buildManifest(instruments: FixtureInstrumentSpec[], retrievedOn: string): FixtureManifest {
  return {
    version: REAL_HISTORY_MANIFEST_VERSION,
    retrievedOn,
    datasetHash: datasetHashOf(instruments),
    syntheticData: false,
    instruments,
  };
}

export function serialiseBarsCsv(bars: readonly FixtureBar[], kind: "ohlc" | "close_only"): string {
  if (kind === "ohlc") return `date,open,high,low,close\n${bars.map((b) => `${b.t},${b.o},${b.h},${b.l},${b.c}`).join("\n")}\n`;
  return `date,close\n${bars.map((b) => `${b.t},${b.c}`).join("\n")}\n`;
}

/** Parse a fixture CSV. Close-only rows get a range DERIVED from the open→close move. */
export function parseBarsCsv(body: string, kind: "ohlc" | "close_only"): { dates: string[]; bars: Bar[] } {
  const lines = body.trim().split("\n").slice(1);
  const dates: string[] = [];
  const bars: Bar[] = [];
  let prevClose: number | null = null;
  for (const line of lines) {
    const f = line.split(",");
    const d = f[0]!;
    if (dates.length > 0 && d <= dates.at(-1)!) throw new Error(`fixture dates not strictly increasing at ${d}`);
    if (kind === "ohlc") {
      const [o, h, l, c] = f.slice(1).map(Number) as [number, number, number, number];
      if (![o, h, l, c].every((x) => x > 0) || h < Math.max(o, c) || l > Math.min(o, c)) {
        throw new Error(`fixture bar ${d} is not a valid OHLC bar`);
      }
      bars.push({ open: o, high: h, low: l, close: c });
    } else {
      const c = Number(f[1]);
      if (!(c > 0)) throw new Error(`fixture close ${d} is not positive`);
      const o = prevClose ?? c;
      // Same derivation as @workspace/validation barsFromCloses: the range is a
      // function of the open→close move only, so it carries no information the
      // close series lacks. Labelled DERIVED everywhere it is reported.
      const spread = Math.abs(c - o);
      bars.push({ open: o, high: Math.max(o, c) + spread * 0.5, low: Math.min(o, c) - spread * 0.5, close: c });
      prevClose = c;
    }
    dates.push(d);
  }
  return { dates, bars };
}

export class FixtureIntegrityError extends Error {
  constructor(message: string) { super(message); this.name = "FixtureIntegrityError"; }
}

/**
 * Load and VERIFY the fixture. Throws FixtureIntegrityError on any mismatch.
 * `pinnedDatasetHash` is the hash the caller's code commits to; passing the
 * manifest's own hash back in would make the check circular, so callers pin it.
 */
export function loadVerifiedFixture(dir: string, pinnedDatasetHash: string): { manifest: FixtureManifest; instruments: LoadedInstrument[] } {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as FixtureManifest;
  if (manifest.version !== REAL_HISTORY_MANIFEST_VERSION) throw new FixtureIntegrityError(`unknown manifest version ${String(manifest.version)}`);
  if (manifest.syntheticData !== false) throw new FixtureIntegrityError("manifest does not attest syntheticData=false");
  const derived = datasetHashOf(manifest.instruments);
  if (derived !== manifest.datasetHash) throw new FixtureIntegrityError(`manifest datasetHash ${manifest.datasetHash} does not re-derive (${derived})`);
  if (derived !== pinnedDatasetHash) throw new FixtureIntegrityError(`dataset hash ${derived} is not the pinned ${pinnedDatasetHash}`);
  const instruments: LoadedInstrument[] = manifest.instruments.map((spec) => {
    const body = readFileSync(join(dir, spec.file), "utf8");
    const actual = sha256(body);
    if (actual !== spec.sha256) throw new FixtureIntegrityError(`${spec.file}: sha256 ${actual} ≠ manifest ${spec.sha256}`);
    const { dates, bars } = parseBarsCsv(body, spec.ohlc);
    if (bars.length !== spec.bars || dates[0] !== spec.first || dates.at(-1) !== spec.last) {
      throw new FixtureIntegrityError(`${spec.file}: bar count/range disagrees with manifest`);
    }
    return { spec, dates, bars };
  });
  return { manifest, instruments };
}
