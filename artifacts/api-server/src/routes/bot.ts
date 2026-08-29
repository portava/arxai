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

// POST /bot/emergency-stop — halts NEW order flow. It does not, and cannot,
// reach the broker.
//
// WHAT IT DOES:
//   1. Engages the platform safety-core kill switch (global by design — one
//      user pulling it must protect every other user). Since the rank-1 fix,
//      liveCommandPipeline and guidedDispatchEntry BOTH read that switch
//      fail-closed, so this genuinely blocks live dispatch on every venue.
//   2. Sets THIS user's bot to OFF / not running / not paused.
//
// WHAT IT DOES NOT DO — and why the previous version was a falsification:
//   It used to loop this user's OPEN rows in `trades` and write
//   {status:'CANCELLED', closedAt:now, pnl:0}. No broker command was issued
//   anywhere in the handler. `trades` is the authoritative trade lifecycle
//   record and its rows carry mode 'LIVE' as well as 'DEMO' (routes/trades.ts
//   stamps it at insert). So the biggest red button in Risk Settings rewrote
//   executed trade history as cancelled-with-zero-P&L while the real broker
//   positions stayed open — irreversibly destroying every P&L figure derived
//   from those rows, and telling the user their trades were closed when
//   nothing had been closed.
//
//   A stop that cannot reach the broker must SAY SO, not rewrite history.
//   Open positions are counted and reported; not one row is mutated.
//   Closing a live position is a real broker command and belongs to the live
//   close path (arx_live_commands / CLOSE_LIVE_POSITION), never to a status
//   overwrite here.
router.post("/bot/emergency-stop", requireUser, async (req, res) => {
  try {
    const userId = req.authUser!.id;
    const settings = await getOrCreateBotSettings(userId);
    await engageKillSwitch({ reason: `Emergency stop triggered by user_id=${userId}`, triggeredBy: "user" });
    await db
      .update(botSettingsTable)
      .set({ mode: "OFF", isRunning: false, isPaused: false, updatedAt: new Date() })
      .where(and(eq(botSettingsTable.id, settings.id), eq(botSettingsTable.userId, userId)));
    // READ ONLY — reported so the user learns what is still open, never mutated.
    const openTrades = await db
      .select({ id: tradesTable.id, mode: tradesTable.mode })
      .from(tradesTable)
      .where(and(eq(tradesTable.status, "OPEN"), eq(tradesTable.userId, userId)));
    const openLive = openTrades.filter((t) => t.mode === "LIVE").length;
    const stillOpen = openTrades.length;
    const message = stillOpen === 0
      ? "Emergency stop executed. Kill switch ENGAGED (blocks new live dispatch) and your bot is OFF. You have no open trade records."
      : `Emergency stop executed. Kill switch ENGAGED (blocks new live dispatch) and your bot is OFF. ${stillOpen} open trade record${stillOpen === 1 ? "" : "s"}${openLive > 0 ? ` (${openLive} LIVE)` : ""} were NOT closed — this stop halts new orders only and does not send a close command to your broker. Close open positions from your broker or the live close screen.`;
    const data = EmergencyStopResponse.parse({
      success: true,
      message,
      // Honest zero: this endpoint closes nothing. It used to report the number
      // of rows it had overwritten as "closed", which was never a close.
      closedTrades: 0,
    });
    res.json(data);
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Emergency stop failed" });
  }
});

export default router;
