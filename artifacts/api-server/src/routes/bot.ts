import { Router } from "express";
import { db } from "@workspace/db";
import { botSettingsTable, tradesTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import {
  GetBotStatusResponse,
  UpdateBotStatusBody,
  GetBotSettingsResponse,
  UpdateBotSettingsBody,
  EmergencyStopResponse,
} from "@workspace/api-zod";
import { engageKillSwitch } from "../lib/safetyCore.js";
import { requireUser } from "../lib/auth/middleware.js";

const router = Router();

// Phase-2: per-user bot settings via the userId uniqueIndex.
async function getOrCreateBotSettings(userId: number) {
  const rows = await db.select().from(botSettingsTable)
    .where(eq(botSettingsTable.userId, userId)).limit(1);
  if (rows[0]) return rows[0];
  const inserted = await db.insert(botSettingsTable).values({ userId }).returning();
  return inserted[0];
}

router.get("/bot/status", requireUser, async (req, res) => {
  try {
    const settings = await getOrCreateBotSettings(req.authUser!.id);
    const data = GetBotStatusResponse.parse({
      mode: settings.mode,
      symbol: settings.symbol,
      strategy: settings.strategy,
      riskMode: settings.riskMode,
      isRunning: settings.isRunning,
      isPaused: settings.isPaused,
      lastScanAt: settings.lastScanAt?.toISOString() ?? null,
    });
    res.json(data);
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Failed to get bot status" });
  }
});

router.patch("/bot/status", requireUser, async (req, res) => {
  try {
    const body = UpdateBotStatusBody.parse(req.body);
    const settings = await getOrCreateBotSettings(req.authUser!.id);
    const updated = await db
      .update(botSettingsTable)
      .set({ ...body, updatedAt: new Date() })
      .where(and(eq(botSettingsTable.id, settings.id), eq(botSettingsTable.userId, req.authUser!.id)))
      .returning();
    const s = updated[0];
    const data = GetBotStatusResponse.parse({
      mode: s.mode, symbol: s.symbol, strategy: s.strategy, riskMode: s.riskMode,
      isRunning: s.isRunning, isPaused: s.isPaused,
      lastScanAt: s.lastScanAt?.toISOString() ?? null,
    });
    res.json(data);
  } catch (err) {
    req.log.error(err);
    res.status(400).json({ error: "Invalid request" });
  }
});

router.get("/bot/settings", requireUser, async (req, res) => {
  try {
    const settings = await getOrCreateBotSettings(req.authUser!.id);
    const data = GetBotSettingsResponse.parse({
      id: settings.id, symbol: settings.symbol, strategy: settings.strategy,
      riskMode: settings.riskMode, mode: settings.mode,
      autoTrade: settings.autoTrade, scanIntervalSeconds: settings.scanIntervalSeconds,
      enabledStrategies: settings.enabledStrategies, newsFilter: settings.newsFilter,
      sessionFilter: settings.sessionFilter,
    });
    res.json(data);
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Failed to get bot settings" });
  }
});

router.patch("/bot/settings", requireUser, async (req, res) => {
  try {
    const body = UpdateBotSettingsBody.parse(req.body);
    const settings = await getOrCreateBotSettings(req.authUser!.id);
    const updated = await db
      .update(botSettingsTable)
      .set({ ...body, updatedAt: new Date() })
      .where(and(eq(botSettingsTable.id, settings.id), eq(botSettingsTable.userId, req.authUser!.id)))
      .returning();
    const s = updated[0];
    const data = GetBotSettingsResponse.parse({
      id: s.id, symbol: s.symbol, strategy: s.strategy, riskMode: s.riskMode,
      mode: s.mode, autoTrade: s.autoTrade, scanIntervalSeconds: s.scanIntervalSeconds,
      enabledStrategies: s.enabledStrategies, newsFilter: s.newsFilter,
      sessionFilter: s.sessionFilter,
    });
    res.json(data);
  } catch (err) {
    req.log.error(err);
    res.status(400).json({ error: "Invalid request" });
  }
});

// POST /bot/emergency-stop — Phase-2: stops THIS user's bot and cancels THIS
// user's open trades. The kill switch is a system-wide safety lever and stays
// global by design (one user pulling it must protect every other user).
router.post("/bot/emergency-stop", requireUser, async (req, res) => {
  try {
    const userId = req.authUser!.id;
    const settings = await getOrCreateBotSettings(userId);
    await engageKillSwitch({ reason: `Emergency stop triggered by user_id=${userId}`, triggeredBy: "user" });
    await db
      .update(botSettingsTable)
      .set({ mode: "OFF", isRunning: false, isPaused: false, updatedAt: new Date() })
      .where(and(eq(botSettingsTable.id, settings.id), eq(botSettingsTable.userId, userId)));
    const openTrades = await db
      .select()
      .from(tradesTable)
      .where(and(eq(tradesTable.status, "OPEN"), eq(tradesTable.userId, userId)));
    for (const trade of openTrades) {
      await db
        .update(tradesTable)
        .set({ status: "CANCELLED", closedAt: new Date(), pnl: 0 })
        .where(and(eq(tradesTable.id, trade.id), eq(tradesTable.userId, userId)));
    }
    const data = EmergencyStopResponse.parse({
      success: true,
      message: "Emergency stop executed. Your trades cancelled. Bot is OFF.",
      closedTrades: openTrades.length,
    });
    res.json(data);
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Emergency stop failed" });
  }
});

export default router;
