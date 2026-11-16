// Per-user Eleanor Voice preferences — backend = source of truth.
// GET  /api/me/voice-settings
// PUT  /api/me/voice-settings
//
// SAFETY:
//   - requireUser on every route
//   - Per-user isolation: only ever reads/writes the caller's row
//   - Never returns provider API keys, only the user's own preference flags
//   - Admin-only fields (openaiModel, voiceInstructions) are NOT exposed here

import { Router, type Request, type Response } from "express";
import { z } from "zod/v4";
import { eq, and, isNotNull } from "drizzle-orm";
import { db, userSettingsTable } from "@workspace/db";
import { requireUser } from "../lib/auth/middleware.js";
import { logger } from "../lib/logger.js";

const log = logger.child({ component: "meVoiceSettings" });
const router = Router();

const VOICE_DEFAULTS = {
  eleanorVoiceEnabled:    true,
  eleanorSpeakResponses:  true,
  eleanorAutoListen:      true,
  eleanorBrowserFallback: true,
  eleanorTtsProvider:     "auto" as const,
  eleanorTtsVoiceId:      null as string | null,
};

interface VoicePrefs {
  enabled: boolean;
  speakResponses: boolean;
  autoListen: boolean;
  browserFallback: boolean;
  provider: "auto" | "elevenlabs" | "openai" | "browser";
  voiceId: string | null;
}

function rowToPrefs(row: {
  eleanorVoiceEnabled: boolean | null;
  eleanorSpeakResponses: boolean | null;
  eleanorAutoListen: boolean | null;
  eleanorBrowserFallback: boolean | null;
  eleanorTtsProvider: string | null;
  eleanorTtsVoiceId: string | null;
}): VoicePrefs {
  const p = (row.eleanorTtsProvider ?? VOICE_DEFAULTS.eleanorTtsProvider) as VoicePrefs["provider"];
  return {
    enabled:         row.eleanorVoiceEnabled    ?? VOICE_DEFAULTS.eleanorVoiceEnabled,
    speakResponses:  row.eleanorSpeakResponses  ?? VOICE_DEFAULTS.eleanorSpeakResponses,
    autoListen:      row.eleanorAutoListen      ?? VOICE_DEFAULTS.eleanorAutoListen,
    browserFallback: row.eleanorBrowserFallback ?? VOICE_DEFAULTS.eleanorBrowserFallback,
    provider:        ["auto", "elevenlabs", "openai", "browser"].includes(p) ? p : "auto",
    voiceId:         row.eleanorTtsVoiceId ?? null,
  };
}

async function loadOrCreate(userId: number): Promise<VoicePrefs> {
  // Note: user_settings.user_id is not (yet) uniquely constrained at the
  // DB level. To stay deterministic under a concurrent first-mount race,
  // always read the lowest-id row for this user; only INSERT when none
  // exists, and re-read after insert to converge on the canonical row.
  const rows = await db
    .select()
    .from(userSettingsTable)
    .where(and(eq(userSettingsTable.userId, userId), isNotNull(userSettingsTable.userId)))
    .orderBy(userSettingsTable.id)
    .limit(1);
  let row = rows[0];
  if (!row) {
    try {
      await db.insert(userSettingsTable).values({ userId });
    } catch {
      // Another concurrent insert won the race — fall through to re-select.
    }
    const after = await db
      .select()
      .from(userSettingsTable)
      .where(and(eq(userSettingsTable.userId, userId), isNotNull(userSettingsTable.userId)))
      .orderBy(userSettingsTable.id)
      .limit(1);
    row = after[0]!;
  }
  return rowToPrefs(row);
}

router.get("/me/voice-settings", requireUser, async (req: Request, res: Response) => {
  const userId = req.authUser!.id;
  try {
    const prefs = await loadOrCreate(userId);
    return res.json({ ok: true, prefs });
  } catch (e) {
    log.error({ err: (e as Error).message, userId }, "voice_settings_get_failed");
    return res.status(500).json({ ok: false, error: "VOICE_SETTINGS_GET_FAILED" });
  }
});

const PutBody = z.object({
  enabled:         z.boolean().optional(),
  speakResponses:  z.boolean().optional(),
  autoListen:      z.boolean().optional(),
  browserFallback: z.boolean().optional(),
  provider:        z.enum(["auto", "elevenlabs", "openai", "browser"]).optional(),
  voiceId:         z.string().min(1).max(100).nullable().optional(),
});

router.put("/me/voice-settings", requireUser, async (req: Request, res: Response) => {
  const userId = req.authUser!.id;
  const parsed = PutBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: "BAD_BODY" });
  }
  const p = parsed.data;
  try {
    // Ensure row exists, then apply partial update.
    await loadOrCreate(userId);
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (p.enabled         !== undefined) patch["eleanorVoiceEnabled"]    = p.enabled;
    if (p.speakResponses  !== undefined) patch["eleanorSpeakResponses"]  = p.speakResponses;
    if (p.autoListen      !== undefined) patch["eleanorAutoListen"]      = p.autoListen;
    if (p.browserFallback !== undefined) patch["eleanorBrowserFallback"] = p.browserFallback;
    if (p.provider        !== undefined) patch["eleanorTtsProvider"]     = p.provider;
    if (p.voiceId         !== undefined) patch["eleanorTtsVoiceId"]      = p.voiceId;

    await db.update(userSettingsTable).set(patch).where(eq(userSettingsTable.userId, userId));
    const prefs = await loadOrCreate(userId);
    return res.json({ ok: true, prefs });
  } catch (e) {
    log.error({ err: (e as Error).message, userId }, "voice_settings_put_failed");
    return res.status(500).json({ ok: false, error: "VOICE_SETTINGS_PUT_FAILED" });
  }
});

export default router;
