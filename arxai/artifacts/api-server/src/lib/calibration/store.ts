// Calibration fit persistence — versioned, append-only (calibration_fits).
//
// A fit for a key is appended as version+1 only when its graded data changed
// (N, wins or the newest outcome time). An unchanged refit writes nothing, so
// versions mark real changes in evidence, not worker ticks.

import { and, desc, eq, sql } from "drizzle-orm";
import { db, calibrationFitsTable } from "@workspace/db";
import type { CalibrationFit } from "@workspace/domain/calibration";
import { replaceCalibrationCache } from "./cache.js";

export interface FitToPersist {
  fitKey: string;
  source: string;
  strategy: string;
  symbol: string;
  timeframe: string;
  fit: CalibrationFit;
  dataFrom: Date | null;
  dataTo: Date | null;
}

export async function persistFit(f: FitToPersist): Promise<{ version: number; written: boolean }> {
  const latest = await db
    .select({
      version: calibrationFitsTable.version,
      n: calibrationFitsTable.n,
      wins: calibrationFitsTable.wins,
      dataTo: calibrationFitsTable.dataTo,
      source: calibrationFitsTable.source,
    })
    .from(calibrationFitsTable)
    .where(eq(calibrationFitsTable.fitKey, f.fitKey))
    .orderBy(desc(calibrationFitsTable.version))
    .limit(1);
  const prev = latest[0];
  const sameData =
    prev &&
    prev.n === f.fit.n &&
    prev.wins === f.fit.wins &&
    prev.source === f.source &&
    (prev.dataTo?.getTime() ?? null) === (f.dataTo?.getTime() ?? null);
  if (prev && sameData) return { version: prev.version, written: false };
  const version = (prev?.version ?? 0) + 1;
  const inserted = await db
    .insert(calibrationFitsTable)
    .values({
      fitKey: f.fitKey,
      version,
      source: f.source,
      strategy: f.strategy,
      symbol: f.symbol,
      timeframe: f.timeframe,
      method: f.fit.method,
      status: f.fit.status,
      model: f.fit.model,
      n: f.fit.n,
      wins: f.fit.wins,
      baseRate: f.fit.baseRate,
      brier: f.fit.brier,
      brierBaseline: f.fit.brierBaseline,
      brierRaw: f.fit.brierRaw,
      edgeDetected: f.fit.edgeDetected,
      fit: f.fit as unknown as Record<string, unknown>,
      dataFrom: f.dataFrom,
      dataTo: f.dataTo,
    })
    .onConflictDoNothing()
    .returning({ version: calibrationFitsTable.version });
  return { version, written: inserted.length > 0 };
}

export interface CurrentFitRow {
  fitKey: string;
  version: number;
  source: string;
  strategy: string;
  symbol: string;
  timeframe: string;
  fit: CalibrationFit;
  fittedAt: Date;
}

/** The newest version of every fit key. */
export async function loadCurrentFits(): Promise<CurrentFitRow[]> {
  const rows = await db.execute(sql`
    SELECT DISTINCT ON (fit_key)
      fit_key, version, source, strategy, symbol, timeframe, fit, fitted_at
    FROM calibration_fits
    ORDER BY fit_key, version DESC
  `);
  const list = (rows as unknown as { rows?: Record<string, unknown>[] }).rows ?? (rows as unknown as Record<string, unknown>[]);
  return list.map((r) => ({
    fitKey: String(r["fit_key"]),
    version: Number(r["version"]),
    source: String(r["source"]),
    strategy: String(r["strategy"]),
    symbol: String(r["symbol"]),
    timeframe: String(r["timeframe"]),
    fit: r["fit"] as CalibrationFit,
    fittedAt: new Date(String(r["fitted_at"])),
  }));
}

/** Reload the in-memory cache from the persisted current fits. */
export async function reloadCalibrationCache(): Promise<number> {
  const rows = await loadCurrentFits();
  replaceCalibrationCache(
    rows.map((r) => [r.fitKey, { fit: r.fit, version: r.version, source: r.source, fittedAt: r.fittedAt.toISOString() }]),
  );
  return rows.length;
}

/** Version history of one key, newest first (for audit). */
export async function fitHistory(fitKey: string, limit = 20) {
  return db
    .select({
      version: calibrationFitsTable.version,
      n: calibrationFitsTable.n,
      baseRate: calibrationFitsTable.baseRate,
      brier: calibrationFitsTable.brier,
      brierBaseline: calibrationFitsTable.brierBaseline,
      edgeDetected: calibrationFitsTable.edgeDetected,
      model: calibrationFitsTable.model,
      fittedAt: calibrationFitsTable.fittedAt,
    })
    .from(calibrationFitsTable)
    .where(and(eq(calibrationFitsTable.fitKey, fitKey)))
    .orderBy(desc(calibrationFitsTable.version))
    .limit(limit);
}
