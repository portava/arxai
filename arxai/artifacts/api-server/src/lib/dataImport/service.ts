// Build KK — Data Import service.
//
// SAFETY: DATA_IMPORT_ONLY. Never places trades, never calls MT5, never
// modifies canPlaceTrades. Imported rows live in `imported_candles` only.

import { randomUUID } from "node:crypto";
import { db, dataImportsTable, importedCandlesTable, dataImportLogsTable, replayScenariosTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { validateAndNormalize, type ValidationResult } from "./validate.js";

export type ImportSource = "CSV" | "JSON" | "MANUAL" | "DEMO";
export type ImportStatus = "VALIDATED" | "IMPORTED" | "REJECTED" | "PARTIAL";

export interface ImportInput {
  symbol: string;
  timeframe: string;
  source: ImportSource;
  candles: unknown;
  validateOnly?: boolean;
}

export interface ImportRecord {
  importId: string; status: ImportStatus; symbol: string; timeframe: string; source: ImportSource;
  candlesReceived: number; candlesValid: number; candlesRejected: number;
  startTime: Date | null; endTime: Date | null;
  dataQuality: ValidationResult["quality"];
  warnings: string[]; errors: string[]; createdAt: Date;
}

async function logEvent(importId: string, eventType: string, severity: string, message: string, details: Record<string, unknown> = {}) {
  try { await db.insert(dataImportLogsTable).values({ importId, eventType, severity, message, details }); } catch { /* swallow */ }
}

export async function runImport(input: ImportInput): Promise<ImportRecord> {
  const importId = `imp_${randomUUID()}`;
  await logEvent(importId, "IMPORT_RECEIVED", "INFO", `Received ${input.source} import for ${input.symbol} ${input.timeframe}`,
    { received: Array.isArray(input.candles) ? (input.candles as unknown[]).length : 0 });
  await logEvent(importId, "VALIDATION_STARTED", "INFO", "Validation started");

  const v = validateAndNormalize(input.candles, input.timeframe);
  const received = Array.isArray(input.candles) ? (input.candles as unknown[]).length : 0;
  const valid = v.candles.length;
  const rejected = v.rejected.length;
  let status: ImportStatus;
  if (!v.ok) status = "REJECTED";
  else if (input.validateOnly) status = "VALIDATED";
  else if (rejected > 0 || v.quality.status === "DEGRADED") status = valid > 0 ? "PARTIAL" : "REJECTED";
  else status = "IMPORTED";

  await logEvent(importId, "VALIDATION_RESULT", v.ok ? "INFO" : "ERROR",
    `Validation ${v.quality.status}: valid=${valid} rejected=${rejected}`,
    { duplicateCount: v.quality.duplicateCount, gapCount: v.quality.gapCount, invalidOhlcCount: v.quality.invalidOhlcCount });

  await db.insert(dataImportsTable).values({
    importId, symbol: input.symbol, timeframe: input.timeframe, source: input.source, status,
    candlesReceived: received, candlesValid: valid, candlesRejected: rejected,
    startTime: v.startTime, endTime: v.endTime,
    dataQuality: v.quality, warnings: v.quality.warnings, errors: v.quality.errors,
  });

  if (status === "IMPORTED" || status === "PARTIAL") {
    if (valid > 0) {
      const rows = v.candles.map(c => ({
        candleId: `cdl_${randomUUID()}`, importId,
        symbol: input.symbol, timeframe: input.timeframe,
        time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
        source: input.source,
      }));
      // Chunked insert to keep payloads sane.
      for (let i = 0; i < rows.length; i += 500) {
        await db.insert(importedCandlesTable).values(rows.slice(i, i + 500));
      }
      await logEvent(importId, "CANDLES_STORED", "INFO", `Stored ${valid} normalized candles`);
    }
    await logEvent(importId, status === "IMPORTED" ? "IMPORT_COMPLETED" : "IMPORT_PARTIAL", "INFO",
      `Import ${status} (valid=${valid}, rejected=${rejected})`);
  } else if (status === "REJECTED") {
    await logEvent(importId, "IMPORT_REJECTED", "ERROR", `Import REJECTED: ${v.quality.errors.join("; ") || "no valid candles"}`);
  } else {
    await logEvent(importId, "IMPORT_VALIDATED", "INFO", "Validation-only complete; no rows persisted.");
  }

  return {
    importId, status, symbol: input.symbol, timeframe: input.timeframe, source: input.source,
    candlesReceived: received, candlesValid: valid, candlesRejected: rejected,
    startTime: v.startTime, endTime: v.endTime,
    dataQuality: v.quality, warnings: v.quality.warnings, errors: v.quality.errors,
    createdAt: new Date(),
  };
}

export async function listImports(limit = 20) {
  return db.select().from(dataImportsTable).orderBy(desc(dataImportsTable.id)).limit(limit);
}
export async function getImport(importId: string) {
  const [row] = await db.select().from(dataImportsTable).where(eq(dataImportsTable.importId, importId));
  return row ?? null;
}
export async function getImportCandles(importId: string, limit = 200) {
  return db.select().from(importedCandlesTable).where(eq(importedCandlesTable.importId, importId))
    .orderBy(importedCandlesTable.time).limit(limit);
}
export async function listImportLogs(limit = 50) {
  return db.select().from(dataImportLogsTable).orderBy(desc(dataImportLogsTable.id)).limit(limit);
}

// Build KK ↔ Build JJ bridge. Creates a replay scenario with source=IMPORTED.
export async function createReplayScenarioFromImport(importId: string, opts: { title?: string } = {}) {
  const imp = await getImport(importId);
  if (!imp) return { ok: false as const, error: "import not found" };
  if (imp.status !== "IMPORTED" && imp.status !== "PARTIAL") {
    return { ok: false as const, error: `import status ${imp.status} cannot be replayed` };
  }
  const candles = await db.select().from(importedCandlesTable).where(eq(importedCandlesTable.importId, importId)).orderBy(importedCandlesTable.time);
  if (candles.length < 5) return { ok: false as const, error: "imported set has too few candles for replay" };
  const scenarioId = `scn_${randomUUID()}`;
  const sCandles = candles.map(c => ({ t: c.time.getTime(), o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume ?? 0 }));
  await db.insert(replayScenariosTable).values({
    scenarioId,
    title: opts.title ?? `Imported scenario from ${importId}`,
    symbol: imp.symbol, timeframe: imp.timeframe,
    source: "IMPORTED",
    marketCondition: "IMPORTED",
    candles: sCandles,
    notes: `Imported scenario built from data import ${importId} (source=${imp.source}, dataQuality=${(imp.dataQuality as { status?: string })?.status ?? "?"}).`,
  });
  await logEvent(importId, "REPLAY_SCENARIO_CREATED", "INFO", `Created replay scenario ${scenarioId} from import`,
    { scenarioId, candles: sCandles.length });
  return { ok: true as const, scenarioId, candles: sCandles.length };
}

// Build KK ↔ Build DD bridge. Read-only: returns imported candles annotated as fallback.
export async function readImportedFallback(symbol: string, timeframe: string, limit = 200) {
  const rows = await db.select().from(importedCandlesTable)
    .orderBy(desc(importedCandlesTable.time))
    .limit(limit);
  const filtered = rows.filter(r => r.symbol === symbol && r.timeframe === timeframe);
  return filtered.map(r => ({
    t: r.time.getTime(), o: r.open, h: r.high, l: r.low, c: r.close, v: r.volume ?? 0,
    source: "IMPORTED", liveQuote: false,
  }));
}

// Synthetic demo helper.
export function buildDemoCandles(count = 60, seed = 7): unknown[] {
  let s = seed;
  const rand = () => (s = (s * 9301 + 49297) % 233280) / 233280;
  let price = 1000;
  const start = Date.UTC(2026, 0, 1, 0, 0, 0);
  const out: unknown[] = [];
  for (let i = 0; i < count; i++) {
    const drift = (rand() - 0.45) * 1.5;
    const o = price;
    const c = +(price + drift).toFixed(4);
    const h = +Math.max(o, c, o + Math.abs(drift) * 0.6).toFixed(4);
    const l = +Math.min(o, c, o - Math.abs(drift) * 0.6).toFixed(4);
    out.push({ time: start + i * 300_000, open: o, high: h, low: l, close: c, volume: Math.round(rand() * 200) });
    price = c;
  }
  return out;
}
