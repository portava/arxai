import { pgTable, serial, text, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Singleton (id=1) row of admin-controlled Ruby voice configuration.
// - openaiModel:        which OpenAI TTS model to use for /audio/speech.
//                       "tts-1-hd" (legacy, no instructions support)
//                       "gpt-4o-mini-tts" (newer, supports `instructions`)
// - voiceInstructions:  free-form tone/style string for gpt-4o-mini-tts.
//                       Ignored silently when the active model does not
//                       support instructions.
//
// Never returned to non-admin users. Updated only by ADMIN/OWNER.
export const arxVoiceAdminSettingsTable = pgTable("arx_voice_admin_settings", {
  id: serial("id").primaryKey(),
  openaiModel: text("openai_model").notNull().default("tts-1-hd"),
  voiceInstructions: text("voice_instructions").notNull().default(
    "Sound calm, confident, warm, and concise. Speak like Ruby, the ARX AI trading assistant. Keep responses natural and supportive.",
  ),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  updatedByUserId: integer("updated_by_user_id"),
});

export const insertArxVoiceAdminSettingsSchema = createInsertSchema(arxVoiceAdminSettingsTable).omit({
  id: true,
  updatedAt: true,
});
export type InsertArxVoiceAdminSettings = z.infer<typeof insertArxVoiceAdminSettingsSchema>;
export type ArxVoiceAdminSettings = typeof arxVoiceAdminSettingsTable.$inferSelect;
