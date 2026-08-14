import { Router } from "express";
import { db } from "@workspace/db";
import { strategiesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { GetStrategiesResponse, UpdateStrategyBody } from "@workspace/api-zod";
import { z } from "zod/v4";

const router = Router();

// ─── Full default parameters per strategy ─────────────────────────────────────

const DEFAULT_PARAMS = {
  "Trend Continuation": {
    fastEma: 20, mediumEma: 50, slowEma: 200,
    rsiMin: 50, rsiMax: 70,
    atrFilter: true, pullbackRequired: false,
    minimumConfidence: 65,
  },
  "Break of Structure": {
    swingLookback: 20, candleCloseConfirmation: true,
    retestRequired: false, wickTolerance: 0.3,
    minimumConfidence: 65,
  },
  "Liquidity Sweep Reversal": {
    lookbackCandles: 15, wickRejectionRequired: true,
    rsiExhaustionThreshold: 65, candleCloseBackInsideRange: true,
    minimumConfidence: 68,
  },
  "Volatility Expansion": {
    atrPeriod: 14, atrMultiplier: 1.4,
    candleBodyMinimumPct: 60, trendFilterRequired: true,
    minimumConfidence: 65,
  },
  "Mean Reversion": {
    rangeDetectionRequired: true, rsiOverbought: 70, rsiOversold: 30,
    bollingerBandTouchRequired: false, takeProfitAtMidline: true,
    minimumConfidence: 60,
  },
  "Session Breakout": {
    session: "London", openingRangeMinutes: 30,
    breakoutConfirmation: true, retestRequired: false,
    maxFakeoutCount: 2, minimumConfidence: 65,
  },
  "No Trade Filter": {
    minConfidence: 65, maxAtrMultiple: 3,
    rsiOverbought: 80, rsiOversold: 20,
  },
} as const;

// ─── Per-market preset: enabled flags ─────────────────────────────────────────

const MARKET_PRESETS: Record<string, Record<string, boolean>> = {
  forex: {
    "Trend Continuation": true, "Break of Structure": true,
    "Liquidity Sweep Reversal": true, "Volatility Expansion": true,
    "Mean Reversion": false, "Session Breakout": true, "No Trade Filter": true,
  },
  indices: {
    "Trend Continuation": true, "Break of Structure": true,
    "Liquidity Sweep Reversal": true, "Volatility Expansion": true,
    "Mean Reversion": false, "Session Breakout": true, "No Trade Filter": true,
  },
  stocks: {
    "Trend Continuation": true, "Break of Structure": true,
    "Liquidity Sweep Reversal": false, "Volatility Expansion": true,
    "Mean Reversion": false, "Session Breakout": false, "No Trade Filter": true,
  },
  synthetic: {
    "Trend Continuation": true, "Break of Structure": true,
    "Liquidity Sweep Reversal": true, "Volatility Expansion": true,
    "Mean Reversion": false, "Session Breakout": false, "No Trade Filter": true,
  },
};

// ─── Seed data (all 7 strategies) ────────────────────────────────────────────

const DEFAULT_STRATEGIES = [
  {
    name: "Trend Continuation",
    description: "Uses EMA 20/50/200 alignment with RSI confirmation. Trades in the direction of the macro trend when all EMAs are stacked and RSI is in the momentum zone.",
    enabled: true, winRate: 58.3, totalSignals: 142,
    parameters: DEFAULT_PARAMS["Trend Continuation"],
  },
  {
    name: "Break of Structure",
    description: "Detects swing highs/lows and trades after a confirmed structural break with optional pullback/retest. High accuracy in trending markets.",
    enabled: true, winRate: 62.1, totalSignals: 89,
    parameters: DEFAULT_PARAMS["Break of Structure"],
  },
  {
    name: "Liquidity Sweep Reversal",
    description: "Identifies price sweeping above/below recent highs/lows with wick rejection and RSI exhaustion. Counter-trend reversal from liquidity pools.",
    enabled: true, winRate: 55.7, totalSignals: 67,
    parameters: DEFAULT_PARAMS["Liquidity Sweep Reversal"],
  },
  {
    name: "Volatility Expansion",
    description: "Trades when ATR expands significantly beyond the period average and a large-body candle forms in the trend direction. Catches momentum breakouts.",
    enabled: true, winRate: 51.2, totalSignals: 45,
    parameters: DEFAULT_PARAMS["Volatility Expansion"],
  },
  {
    name: "Mean Reversion",
    description: "Fades price extremes in ranging markets. Uses RSI overbought/oversold with optional Bollinger Band touch to time entries back toward the midline.",
    enabled: false, winRate: 48.9, totalSignals: 31,
    parameters: DEFAULT_PARAMS["Mean Reversion"],
  },
  {
    name: "Session Breakout",
    description: "Captures the initial directional move at the open of a major session (London, New York, Asia) by trading a breakout of the prior opening range.",
    enabled: true, winRate: 53.4, totalSignals: 28,
    parameters: DEFAULT_PARAMS["Session Breakout"],
  },
  {
    name: "No Trade Filter",
    description: "Blocks trades during sideways chop, extreme RSI, low confidence, or abnormal ATR. Applied automatically to all signals as a safety gate.",
    enabled: true, winRate: 0, totalSignals: 0,
    parameters: DEFAULT_PARAMS["No Trade Filter"],
  },
];

// ─── Seed helper ─────────────────────────────────────────────────────────────

async function ensureStrategiesExist() {
  const existing = await db.select().from(strategiesTable);
  const existingNames = new Set(existing.map((s) => s.name));
  for (const s of DEFAULT_STRATEGIES) {
    if (!existingNames.has(s.name)) {
      await db.insert(strategiesTable).values(s);
    }
  }
  return await db.select().from(strategiesTable);
}

// ─── GET /strategies ──────────────────────────────────────────────────────────

router.get("/strategies", async (req, res) => {
  try {
    const strategies = await ensureStrategiesExist();
    const data = GetStrategiesResponse.parse(strategies.map((s) => ({
      ...s,
      parameters: s.parameters as Record<string, unknown>,
    })));
    return res.json(data);
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to get strategies" });
  }
});

// ─── PATCH /strategies ────────────────────────────────────────────────────────

router.patch("/strategies", async (req, res) => {
  try {
    const body = UpdateStrategyBody.parse(req.body);
    const updated = await db
      .update(strategiesTable)
      .set({ enabled: body.enabled, parameters: body.parameters, updatedAt: new Date() })
      .where(eq(strategiesTable.id, body.id))
      .returning();
    if (!updated[0]) { return res.status(404).json({ error: "Strategy not found" }); }
    const data = GetStrategiesResponse.parse([{
      ...updated[0],
      parameters: updated[0].parameters as Record<string, unknown>,
    }]);
    return res.json(data[0]);
  } catch (err) {
    req.log.error(err);
    return res.status(400).json({ error: "Failed to update strategy" });
  }
});

// ─── POST /strategies/reset ───────────────────────────────────────────────────

const ResetBody = z.object({ marketType: z.enum(["forex", "indices", "stocks", "synthetic"]) });

router.post("/strategies/reset", async (req, res) => {
  try {
    const { marketType } = ResetBody.parse(req.body);
    const preset = MARKET_PRESETS[marketType];
    await ensureStrategiesExist();
    const all = await db.select().from(strategiesTable);
    const updated: typeof all = [];
    for (const row of all) {
      const defaultEnabled = preset[row.name] ?? row.enabled;
      const defaultParams = DEFAULT_PARAMS[row.name as keyof typeof DEFAULT_PARAMS] ?? row.parameters;
      const [u] = await db
        .update(strategiesTable)
        .set({ enabled: defaultEnabled, parameters: defaultParams, updatedAt: new Date() })
        .where(eq(strategiesTable.id, row.id))
        .returning();
      if (u) updated.push(u);
    }
    const data = GetStrategiesResponse.parse(updated.map((s) => ({
      ...s,
      parameters: s.parameters as Record<string, unknown>,
    })));
    return res.json(data);
  } catch (err) {
    req.log.error(err);
    return res.status(400).json({ error: "Failed to reset strategies" });
  }
});

export default router;
