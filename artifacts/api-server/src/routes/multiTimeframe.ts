// (M) Build M — Multi-Timeframe Analysis routes.
//
// POST /api/multi-timeframe/generate — fetch candles per timeframe, run the
//   pure domain engine, persist a report row.
// GET  /api/multi-timeframe/latest?symbol=... — most recent report for symbol.
// GET  /api/multi-timeframe/history?symbol=...&limit=N — time-series.
//
// Defaults to (M5, H1, H4) but accepts custom triplet. Composes:
//   - dataManager.getMarketDataWithProvenance (existing candle source; bar
//     times and the serving provider are kept so the report can say whether
//     each timeframe is current and where it came from)
//   - @workspace/domain/multi-timeframe (pure detector + classifier)
//   - vault audit (BEHAVIOR truth domain) for traceability
//
// Safety: never blocks. The trade-plan checklist consumes the report as a
// non-blocking warning when alignment is weak (see tradePlans.ts).

import { Router } from "express";
import { db, multiTimeframeReportsTable, vaultEventsTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { z } from "zod/v4";
import {
  buildReport, ALIGNMENT_LABELS, type AlignmentLabel, type Bias,
} from "@workspace/domain/multi-timeframe";
import { getMarketDataWithProvenance } from "../lib/data/dataManager.js";
import type { SeriesProvenance } from "../lib/data/types.js";

const router = Router();

const DEFAULT_TF_TRIPLET = { lower: "M5", middle: "H1", higher: "H4" } as const;
// Map domain TF labels to dataManager string format. dataManager accepts "1m",
// "5m", "1h", etc.
const TF_TO_PROVIDER: Record<string, string> = {
  M1: "1m", M5: "5m", M15: "15m", M30: "30m", H1: "1h", H4: "4h", D1: "1d", W1: "1w",
};

const GenerateBody = z.object({
  symbol: z.string().min(1),
  lowerTimeframe:  z.string().optional(),
  middleTimeframe: z.string().optional(),
  higherTimeframe: z.string().optional(),
  candlesPerTimeframe: z.number().int().min(20).max(500).optional(),
});

async function vaultBehavior(kind: string, payload: Record<string, unknown>) {
  await db.insert(vaultEventsTable).values({
    kind, severity: "INFO", source: "SYSTEM", truthDomain: "BEHAVIOR",
    summary: kind, payload, reasons: [], blockers: [],
    generatedAtIso: new Date().toISOString(),
  });
}

/** Provider label carried onto a timeframe snapshot ("mt5_broker", "assistant_real:twelve_data"). */
export function provenanceLabel(p: SeriesProvenance | null): string | null {
  if (!p) return null;
  return p.subProviderId ? `${p.providerId}:${p.subProviderId}` : p.providerId;
}

function serialize(r: typeof multiTimeframeReportsTable.$inferSelect) {
  return { ...r, createdAt: r.createdAt.toISOString() };
}

router.post("/multi-timeframe/generate", async (req, res): Promise<void> => {
  try {
    const body = GenerateBody.parse(req.body);
    const lowerTf  = body.lowerTimeframe  ?? DEFAULT_TF_TRIPLET.lower;
    const middleTf = body.middleTimeframe ?? DEFAULT_TF_TRIPLET.middle;
    const higherTf = body.higherTimeframe ?? DEFAULT_TF_TRIPLET.higher;
    const limit    = body.candlesPerTimeframe ?? 120;

    const [lowerSeries, middleSeries, higherSeries] = await Promise.all([
      getMarketDataWithProvenance(body.symbol, TF_TO_PROVIDER[lowerTf]  ?? lowerTf,  limit),
      getMarketDataWithProvenance(body.symbol, TF_TO_PROVIDER[middleTf] ?? middleTf, limit),
      getMarketDataWithProvenance(body.symbol, TF_TO_PROVIDER[higherTf] ?? higherTf, limit),
    ]);

    // Bar times and the serving provider travel with the bars: a report built
    // from stale (weekend / stalled-feed) or untimestamped bars is
    // DATA_NOT_CURRENT with no bias, never a confident current alignment.
    const built = buildReport({
      symbol: body.symbol,
      lowerTimeframe: lowerTf, middleTimeframe: middleTf, higherTimeframe: higherTf,
      lowerCandles: lowerSeries.candles,
      middleCandles: middleSeries.candles,
      higherCandles: higherSeries.candles,
      nowMs: Date.now(),
      sources: {
        lower: provenanceLabel(lowerSeries.provenance),
        middle: provenanceLabel(middleSeries.provenance),
        higher: provenanceLabel(higherSeries.provenance),
      },
    });

    const inserted = await db.insert(multiTimeframeReportsTable).values({
      symbol: body.symbol,
      lowerTimeframe: lowerTf, middleTimeframe: middleTf, higherTimeframe: higherTf,
      lowerTrend:  built.lower.snapshot,
      middleTrend: built.middle.snapshot,
      higherTrend: built.higher.snapshot,
      alignmentScore:  built.result.alignmentScore,
      alignmentLabel:  built.result.alignmentLabel,
      conflictWarning: built.result.conflictWarning,
      bestBias: built.result.bestBias,
      aiSummary: built.aiSummary,
      candlesPerTimeframe: limit,
    }).returning();

    await vaultBehavior("MTF_REPORT_GENERATED", {
      id: inserted[0]!.id, symbol: body.symbol,
      label: built.result.alignmentLabel, score: built.result.alignmentScore,
      bias: built.result.bestBias,
    });
    res.json(serialize(inserted[0]!));
  } catch (err) {
    req.log.error({ err: String(err) }, "POST /multi-timeframe/generate failed");
    res.status(400).json({ error: "Failed to generate multi-timeframe report" });
  }
});

router.get("/multi-timeframe/latest", async (req, res): Promise<void> => {
  try {
    const symbol = z.string().min(1).parse(req.query.symbol);
    const rows = await db.select().from(multiTimeframeReportsTable)
      .where(eq(multiTimeframeReportsTable.symbol, symbol))
      .orderBy(desc(multiTimeframeReportsTable.createdAt))
      .limit(1);
    if (!rows[0]) { res.status(404).json({ error: "No report for symbol" }); return; }
    res.json(serialize(rows[0]));
  } catch (err) {
    req.log.error({ err: String(err) }, "GET /multi-timeframe/latest failed");
    res.status(400).json({ error: "Invalid request" });
  }
});

const HistoryQuery = z.object({
  symbol: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

router.get("/multi-timeframe/history", async (req, res): Promise<void> => {
  try {
    const q = HistoryQuery.parse(req.query);
    const where = q.symbol ? eq(multiTimeframeReportsTable.symbol, q.symbol) : undefined;
    const rows = await db.select().from(multiTimeframeReportsTable)
      .where(where as never)
      .orderBy(desc(multiTimeframeReportsTable.createdAt))
      .limit(q.limit);
    res.json({ reports: rows.map(serialize) });
  } catch (err) {
    req.log.error({ err: String(err) }, "GET /multi-timeframe/history failed");
    res.status(400).json({ error: "Invalid request" });
  }
});

void ALIGNMENT_LABELS;
void (null as unknown as AlignmentLabel);
void (null as unknown as Bias);

export default router;
