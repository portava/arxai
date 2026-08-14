// Opportunity Radar routes — read-only ranking surfaces + watchlist prefs.
// NEVER places trades. NEVER bypasses Risk Governor. Per-user scoped.

import { Router } from "express";
import { z } from "zod/v4";
import { db } from "@workspace/db";
import {
  watchlistSymbolPreferencesTable,
} from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import { requireUser } from "../lib/auth/middleware.js";
import {
  evaluateOpportunitiesForUser, getRecentOpportunitiesForUser,
} from "../lib/opportunityRadar/radar.js";

const router = Router();

function envelope(payload: Record<string, unknown>) {
  return {
    system: "opportunityRadar",
    appMode: "PAPER_ONLY" as const,
    liveTradingStatus: "DISABLED" as const,
    canPlaceLiveTrade: false,
    disclaimer:
      "Opportunity Radar is decision support. It never places trades. Live actions still require explicit confirmation and Risk Governor approval.",
    ...payload,
  };
}

router.get("/opportunities/top", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const limit = Math.min(50, Math.max(1, Number(req.query.limit ?? 10)));
  try {
    const result = await evaluateOpportunitiesForUser(userId, { limit, persist: false });
    res.json(envelope({ ok: true, ...result }));
  } catch (e) {
    res.status(500).json(envelope({ ok: false, error: "radar_top_failed", reason: (e as Error).message.slice(0, 200) }));
  }
});

const ScanBody = z.object({
  symbols: z.array(z.string().min(1).max(24)).max(50).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

router.post("/opportunities/scan", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const p = ScanBody.safeParse(req.body ?? {});
  if (!p.success) { res.status(400).json(envelope({ ok: false, error: "invalid_body", details: p.error.issues })); return; }
  try {
    const result = await evaluateOpportunitiesForUser(userId, { symbols: p.data.symbols, limit: p.data.limit, persist: true });
    res.json(envelope({ ok: true, ...result }));
  } catch (e) {
    res.status(500).json(envelope({ ok: false, error: "radar_scan_failed", reason: (e as Error).message.slice(0, 200) }));
  }
});

router.get("/opportunities", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 25)));
  try {
    const result = await getRecentOpportunitiesForUser(userId, limit);
    res.json(envelope({ ok: true, ...result }));
  } catch (e) {
    res.status(500).json(envelope({ ok: false, error: "radar_history_failed", reason: (e as Error).message.slice(0, 200) }));
  }
});

router.get("/watchlist/intelligence", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  try {
    const prefs = await db.select().from(watchlistSymbolPreferencesTable)
      .where(eq(watchlistSymbolPreferencesTable.userId, userId));
    const evalResult = await evaluateOpportunitiesForUser(userId, { limit: 50, persist: false });
    const bySymbol = new Map(evalResult.opportunities.map((o) => [o.symbol, o]));
    const items = prefs.map((p) => {
      const o = bySymbol.get(p.symbol);
      return {
        symbol: p.symbol,
        brokerSymbol: p.brokerSymbol,
        preferredTimeframe: p.preferredTimeframe,
        strategyId: p.strategyId,
        alertThreshold: p.alertThreshold,
        pinned: p.pinned,
        muted: p.muted,
        currentOpportunity: o ? {
          label: o.label,
          directionBias: o.directionBias,
          opportunityScore: o.opportunityScore,
          riskScore: o.riskScore,
          suggestedAction: o.suggestedAction,
          dataQuality: o.dataQuality,
          lastScanTime: o.createdAt,
        } : null,
      };
    });
    res.json(envelope({ ok: true, count: items.length, items, liveDataConnected: evalResult.liveDataConnected }));
  } catch (e) {
    res.status(500).json(envelope({ ok: false, error: "intelligence_failed", reason: (e as Error).message.slice(0, 200) }));
  }
});

const PrefsBody = z.object({
  preferredTimeframe: z.enum(["M1", "M5", "M15", "M30", "H1", "H4", "D1"]).optional(),
  strategyId: z.number().int().positive().nullable().optional(),
  alertThreshold: z.number().min(0).max(100).optional(),
  pinned: z.boolean().optional(),
  muted: z.boolean().optional(),
  brokerSymbol: z.string().max(24).nullable().optional(),
});

router.patch("/watchlist/:symbol/preferences", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const symbol = String(req.params.symbol ?? "").trim().slice(0, 24);
  if (!symbol) { res.status(400).json(envelope({ ok: false, error: "invalid_symbol" })); return; }
  const p = PrefsBody.safeParse(req.body ?? {});
  if (!p.success) { res.status(400).json(envelope({ ok: false, error: "invalid_body", details: p.error.issues })); return; }
  try {
    const [existing] = await db.select().from(watchlistSymbolPreferencesTable)
      .where(and(eq(watchlistSymbolPreferencesTable.userId, userId), eq(watchlistSymbolPreferencesTable.symbol, symbol)))
      .limit(1);
    if (existing) {
      await db.update(watchlistSymbolPreferencesTable)
        .set({ ...p.data, updatedAt: new Date() })
        .where(eq(watchlistSymbolPreferencesTable.id, existing.id));
      res.json(envelope({ ok: true, symbol, updated: true }));
      return;
    }
    await db.insert(watchlistSymbolPreferencesTable).values({
      userId, symbol,
      preferredTimeframe: p.data.preferredTimeframe ?? "M15",
      strategyId: p.data.strategyId ?? null,
      alertThreshold: p.data.alertThreshold ?? 70,
      pinned: p.data.pinned ?? false,
      muted: p.data.muted ?? false,
      brokerSymbol: p.data.brokerSymbol ?? null,
    });
    res.json(envelope({ ok: true, symbol, created: true }));
  } catch (e) {
    res.status(500).json(envelope({ ok: false, error: "prefs_failed", reason: (e as Error).message.slice(0, 200) }));
  }
});

export default router;
