// Per-user Ruby Voice preferences — backend = source of truth.
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
  rubyVoiceEnabled:    true,
  rubySpeakResponses:  true,
  rubyAutoListen:      true,
  rubyBrowserFallback: true,
  rubyTtsProvider:     "auto" as const,
  rubyTtsVoiceId:      null as string | null,
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
  rubyVoiceEnabled: boolean | null;
  rubySpeakResponses: boolean | null;
  rubyAutoListen: boolean | null;
  rubyBrowserFallback: boolean | null;
  rubyTtsProvider: string | null;
  rubyTtsVoiceId: string | null;
}): VoicePrefs {
  const p = (row.rubyTtsProvider ?? VOICE_DEFAULTS.rubyTtsProvider) as VoicePrefs["provider"];
  return {
    enabled:         row.rubyVoiceEnabled    ?? VOICE_DEFAULTS.rubyVoiceEnabled,
    speakResponses:  row.rubySpeakResponses  ?? VOICE_DEFAULTS.rubySpeakResponses,
    autoListen:      row.rubyAutoListen      ?? VOICE_DEFAULTS.rubyAutoListen,
    browserFallback: row.rubyBrowserFallback ?? VOICE_DEFAULTS.rubyBrowserFallback,
    provider:        ["auto", "elevenlabs", "openai", "browser"].includes(p) ? p : "auto",
    voiceId:         row.rubyTtsVoiceId ?? null,
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
    if (p.enabled         !== undefined) patch["rubyVoiceEnabled"]    = p.enabled;
    if (p.speakResponses  !== undefined) patch["rubySpeakResponses"]  = p.speakResponses;
    if (p.autoListen      !== undefined) patch["rubyAutoListen"]      = p.autoListen;
    if (p.browserFallback !== undefined) patch["rubyBrowserFallback"] = p.browserFallback;
    if (p.provider        !== undefined) patch["rubyTtsProvider"]     = p.provider;
    if (p.voiceId         !== undefined) patch["rubyTtsVoiceId"]      = p.voiceId;

    await db.update(userSettingsTable).set(patch).where(eq(userSettingsTable.userId, userId));
    const prefs = await loadOrCreate(userId);
    return res.json({ ok: true, prefs });
  } catch (e) {
    log.error({ err: (e as Error).message, userId }, "voice_settings_put_failed");
    return res.status(500).json({ ok: false, error: "VOICE_SETTINGS_PUT_FAILED" });
  }
});

export default router;
