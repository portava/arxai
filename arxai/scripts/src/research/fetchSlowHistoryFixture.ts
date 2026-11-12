// Fetch the slow-horizon fixture (slowHistoryFixture.ts) from FRED and write it
// with its manifest. Values are written exactly as FRED publishes them (no
// inversion, no rounding); holidays ("." or empty) are dropped. FRED publishes
// no checksum, so the committed bytes are pinned by sha256 and the dataset hash.
//
// Usage (network required; run from arxai/scripts):
//   node --import tsx ./src/research/fetchSlowHistoryFixture.ts

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SLOW_CURRENCIES, USD_RATE_SERIES, SLOW_WINDOW, SLOW_FIXTURE_DIR_NAME, SLOW_MANIFEST_VERSION,
  slowDatasetHashOf, serialiseSeries, type Series, type SlowFileSpec, type SlowManifest,
} from "./slowHistoryFixture.js";
import { createHash } from "node:crypto";

const OUT = join(fileURLToPath(new URL("../../fixtures", import.meta.url)), SLOW_FIXTURE_DIR_NAME);

async function fetchSeries(id: string): Promise<Series> {
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${SLOW_WINDOW.start}&coed=${SLOW_WINDOW.end}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FRED ${id}: HTTP ${res.status}`);
  const body = await res.text();
  if (!body.startsWith("observation_date,")) throw new Error(`FRED ${id}: not a CSV`);
  const out: Series = [];
  for (const line of body.trim().split("\n").slice(1)) {
    const [d, v] = line.split(",");
    if (!d || !v || v === ".") continue;
    if (d < SLOW_WINDOW.start || d > SLOW_WINDOW.end) continue;
    const x = Number(v);
    if (!Number.isFinite(x)) continue;
    out.push([d, x]);
  }
  if (out.length === 0) throw new Error(`FRED ${id}: empty`);
  return out;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const files: SlowFileSpec[] = [];
  const add = async (series: string, kind: SlowFileSpec["kind"]) => {
    console.log(`fred ${series} …`);
    const rows = await fetchSeries(series);
    const file = `${series}.${kind === "fx_daily" ? "1d" : "1m"}.csv`;
    const body = serialiseSeries(rows, series);
    writeFileSync(join(OUT, file), body);
    files.push({
      file, kind, series, sha256: createHash("sha256").update(body, "utf8").digest("hex"), rows: rows.length,
      first: rows[0]![0], last: rows[rows.length - 1]![0], url: `https://fred.stlouisfed.org/series/${series}`,
      license: kind === "fx_daily" ? "Federal Reserve Board H.10, public domain" : series.startsWith("INTDSR") ? "IMF International Financial Statistics via FRED" : series === "TB3MS" ? "Federal Reserve Board H.15, public domain" : "OECD Main Economic Indicators, CC BY 4.0",
    });
  };
  for (const c of SLOW_CURRENCIES) await add(c.fxSeries, "fx_daily");
  const rateIds = [...new Set([...USD_RATE_SERIES, ...SLOW_CURRENCIES.flatMap((c) => c.rateSeries)])];
  for (const id of rateIds) await add(id, "rate_monthly");
  const manifest: SlowManifest = {
    version: SLOW_MANIFEST_VERSION, retrievedOn: new Date().toISOString().slice(0, 10), window: SLOW_WINDOW,
    datasetHash: slowDatasetHashOf(files), syntheticData: false, files,
  };
  writeFileSync(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`dataset ${manifest.datasetHash} (${files.length} files)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
