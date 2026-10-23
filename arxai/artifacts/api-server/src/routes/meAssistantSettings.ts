// Per-user AI assistant personalization — backend = source of truth.
// GET   /api/me/assistant-settings
// PATCH /api/me/assistant-settings
//
// Personalization/branding ONLY. This route stores a per-user display name for
// the AI assistant. It has NO effect on AI logic, safety, execution, MT5, the
// broker, or any permission. It never touches internal identifiers.
//
// SAFETY:
//   - requireUser on every route.
//   - Per-user isolation: only ever reads/writes the caller's own row, scoped
//     by req.authUser.id. No row from user A is ever returned to user B.
//   - Name is validated server-side (authoritative). null resets to default.

import { Router, type Request, type Response } from "express";
import { eq, and, isNotNull } from "drizzle-orm";
import { db, userSettingsTable } from "@workspace/db";
import {
  DEFAULT_ASSISTANT_NAME,
  resolveAssistantName,
  validateAssistantName,
} from "@workspace/domain/assistant-name";
import { UpdateMeAssistantSettingsBody } from "@workspace/api-zod";
import { requireUser } from "../lib/auth/middleware.js";
import { logger } from "../lib/logger.js";

const log = logger.child({ component: "meAssistantSettings" });
const router = Router();

interface AssistantSettings {
  displayName: string;
  isDefault: boolean;
}

function rowToSettings(raw: string | null | undefined): AssistantSettings {
  const displayName = resolveAssistantName(raw);
  return { displayName, isDefault: displayName === DEFAULT_ASSISTANT_NAME && !raw };
}

// Mirrors the deterministic lowest-id loadOrCreate used by other /me settings
// routes (user_settings.user_id is not uniquely constrained at the DB level).
async function loadOrCreateRaw(userId: number): Promise<string | null> {
  const rows = await db
    .select({ id: userSettingsTable.id, name: userSettingsTable.assistantDisplayName })
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
      .select({ id: userSettingsTable.id, name: userSettingsTable.assistantDisplayName })
      .from(userSettingsTable)
      .where(and(eq(userSettingsTable.userId, userId), isNotNull(userSettingsTable.userId)))
      .orderBy(userSettingsTable.id)
      .limit(1);
    row = after[0]!;
  }
  return row.name ?? null;
}

router.get("/me/assistant-settings", requireUser, async (req: Request, res: Response) => {
  const userId = req.authUser!.id;
  try {
    const raw = await loadOrCreateRaw(userId);
    return res.json(rowToSettings(raw));
  } catch (e) {
    log.error({ err: (e as Error).message, userId }, "assistant_settings_get_failed");
    return res.status(500).json({ ok: false, error: "ASSISTANT_SETTINGS_GET_FAILED" });
  }
});

router.patch("/me/assistant-settings", requireUser, async (req: Request, res: Response) => {
  const userId = req.authUser!.id;
  const parsed = UpdateMeAssistantSettingsBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: "BAD_BODY", message: "Invalid request body." });
  }
  const incoming = parsed.data.displayName;

  // null / undefined => reset to the app default.
  let nextValue: string | null;
  if (incoming === null || incoming === undefined) {
    nextValue = null;
  } else {
    const verdict = validateAssistantName(incoming);
    if (!verdict.ok) {
      return res.status(400).json({ ok: false, error: verdict.error, message: verdict.message });
    }
    nextValue = verdict.value!;
  }

  try {
    await loadOrCreateRaw(userId); // ensure a row exists
    await db
      .update(userSettingsTable)
      .set({ assistantDisplayName: nextValue, updatedAt: new Date() })
      .where(eq(userSettingsTable.userId, userId));
    return res.json(rowToSettings(nextValue));
  } catch (e) {
    log.error({ err: (e as Error).message, userId }, "assistant_settings_patch_failed");
    return res.status(500).json({ ok: false, error: "ASSISTANT_SETTINGS_PATCH_FAILED" });
  }
});

export default router;
