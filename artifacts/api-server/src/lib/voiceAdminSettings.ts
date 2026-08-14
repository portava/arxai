// Cached accessor for the singleton arx_voice_admin_settings row.
// - Row id is pinned to 1.
// - Created on first read with safe defaults if missing.
// - In-memory cache invalidated on every update via updateVoiceAdminSettings().
// - Only ADMIN/OWNER may call updateVoiceAdminSettings (enforced at route layer).

import { db, arxVoiceAdminSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { DEFAULT_ASSISTANT_NAME } from "@workspace/domain/assistant-name";

export const OPENAI_TTS_MODELS = [
  { id: "tts-1",            label: "tts-1 (fast, lower quality)",     supportsInstructions: false },
  { id: "tts-1-hd",         label: "tts-1-hd (HD, no style tags)",    supportsInstructions: false },
  { id: "gpt-4o-mini-tts",  label: "gpt-4o-mini-tts (style-aware)",   supportsInstructions: true  },
] as const;
export type OpenAiTtsModelId = (typeof OPENAI_TTS_MODELS)[number]["id"];

export function modelSupportsInstructions(modelId: string): boolean {
  return OPENAI_TTS_MODELS.find((m) => m.id === modelId)?.supportsInstructions ?? false;
}

export function isKnownOpenAiTtsModel(modelId: string): modelId is OpenAiTtsModelId {
  return OPENAI_TTS_MODELS.some((m) => m.id === modelId);
}

export interface VoiceAdminSettings {
  openaiModel: string;
  voiceInstructions: string;
  updatedAt: Date;
  updatedByUserId: number | null;
}

const DEFAULTS: { openaiModel: string; voiceInstructions: string } = {
  openaiModel: "tts-1-hd",
  voiceInstructions:
    `Sound calm, confident, warm, and concise. Speak like ${DEFAULT_ASSISTANT_NAME}, the ARX AI trading assistant. Keep responses natural and supportive.`,
};

let cache: VoiceAdminSettings | null = null;

export async function getVoiceAdminSettings(): Promise<VoiceAdminSettings> {
  if (cache) return cache;
  const rows = await db.select().from(arxVoiceAdminSettingsTable).where(eq(arxVoiceAdminSettingsTable.id, 1)).limit(1);
  let row = rows[0];
  if (!row) {
    const inserted = await db
      .insert(arxVoiceAdminSettingsTable)
      .values({ id: 1, openaiModel: DEFAULTS.openaiModel, voiceInstructions: DEFAULTS.voiceInstructions })
      .returning();
    row = inserted[0]!;
  }
  cache = {
    openaiModel: row.openaiModel,
    voiceInstructions: row.voiceInstructions,
    updatedAt: row.updatedAt,
    updatedByUserId: row.updatedByUserId ?? null,
  };
  return cache;
}

export async function updateVoiceAdminSettings(
  patch: { openaiModel?: string; voiceInstructions?: string },
  updatedByUserId: number,
): Promise<VoiceAdminSettings> {
  const current = await getVoiceAdminSettings();
  const next = {
    openaiModel: patch.openaiModel ?? current.openaiModel,
    voiceInstructions: patch.voiceInstructions ?? current.voiceInstructions,
  };
  if (!isKnownOpenAiTtsModel(next.openaiModel)) {
    throw new Error("UNKNOWN_OPENAI_TTS_MODEL");
  }
  if (next.voiceInstructions.length > 2000) {
    throw new Error("VOICE_INSTRUCTIONS_TOO_LONG");
  }
  await db
    .update(arxVoiceAdminSettingsTable)
    .set({
      openaiModel: next.openaiModel,
      voiceInstructions: next.voiceInstructions,
      updatedAt: new Date(),
      updatedByUserId,
    })
    .where(eq(arxVoiceAdminSettingsTable.id, 1));
  cache = null;
  return getVoiceAdminSettings();
}
