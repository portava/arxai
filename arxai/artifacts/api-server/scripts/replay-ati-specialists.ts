// Offline replay of an archived public feed. The simulated issue timestamps are
// used only for chronological scoring. This tool never writes forecast receipts.
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import {
  evaluateForecast, fitStructuralModel, forecastStructural, validateBars, type StructuralBar,
} from "@workspace/domain/structural";
import { reportAtiSpecialists } from "../src/lib/structural/atiSpecialistReport.js";
import type { StoredForecast } from "../src/lib/structural/service.js";

const minute = 60_000, barsPerWindow = 15, plannedWindows = 60, embargoBars = 60;
const filename = process.argv[2];
if (!filename) throw new Error("Supply the path to a V75 public M1 archive");
const bytes = await readFile(filename);
const content = filename.endsWith(".gz") ? gunzipSync(bytes) : bytes;
const archive: { source: string; symbol: string; venueSymbol: string; barSeconds: number; archivedAt: string; cutoff: number; bars: StructuralBar[] } = JSON.parse(content.toString());
const { bars, cutoff } = archive;
if (archive.source !== "deriv_public" || archive.symbol !== "V75" || archive.venueSymbol !== "R_75" || archive.barSeconds !== 60 ||
    !(Date.parse(archive.archivedAt) >= cutoff) || !Array.isArray(bars) ||
    !Number.isSafeInteger(cutoff) || bars.at(-1)?.closeTime !== cutoff ||
    bars.some((b, i) => !Number.isSafeInteger(b.closeTime) || b.openTime + minute !== b.closeTime ||
      b.closeTime > cutoff || (i > 0 && b.openTime < bars[i - 1]!.closeTime))) throw new Error("INVALID_ARCHIVE");
const testStart = cutoff - barsPerWindow * plannedWindows * minute;
const trainingBars = bars.filter(b => b.closeTime <= testStart - embargoBars * minute);
const origin = { symbol: archive.symbol, provider: archive.source, kind: "BROKER_HISTORY" as const,
  historicalArrivalTimesKnown: false as const, fetchedAt: archive.archivedAt };
const model = fitStructuralModel(trainingBars, origin);
const rows: StoredForecast[] = [];
let unusableHistory = 0;
for (let asOf = testStart; asOf < cutoff; asOf += barsPerWindow * minute) {
  const history = bars.filter(b => b.closeTime <= asOf).slice(-120);
  if (history.at(-1)?.closeTime !== asOf) { unusableHistory++; continue; }
  try { validateBars(history, asOf, 120); } catch { unusableHistory++; continue; }
  const forecast = forecastStructural(model, history, origin, false, barsPerWindow, "15m");
  const end = asOf + barsPerWindow * minute;
  const future = bars.filter(b => b.openTime >= asOf && b.closeTime <= end);
  let scores: StoredForecast["scores"] = [];
  try { validateBars(future, end, barsPerWindow); } catch {
    rows.push({ id: String(asOf), forecast, issuedAt: asOf, recordedAt: asOf, scores });
    continue;
  }
  scores = evaluateForecast(forecast, future, end, asOf);
  rows.push({ id: String(asOf), forecast, issuedAt: asOf, recordedAt: asOf, scores });
}
console.log(JSON.stringify({
  mode: "HISTORICAL_REPLAY", historicalArrivalTimesKnown: false, timestampsSimulated: true, sourceSha256: createHash("sha256").update(content).digest("hex"),
  plannedWindows, embargoBars, unusableHistory, trainingBars: trainingBars.length, trainedWindows: model.atiSpecialists?.trainedWindows,
  testStart: new Date(testStart).toISOString(), cutoff: new Date(cutoff).toISOString(), report: reportAtiSpecialists(rows),
}, null, 2));
