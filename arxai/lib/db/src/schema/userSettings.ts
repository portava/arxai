import { pgTable, serial, text, integer, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Per-user UI / session preferences. Distinct from botSettings (bot runtime config).
export const userSettingsTable = pgTable("user_settings", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"), // nullable until auth is wired
  activeSymbol: text("active_symbol").default("EURUSD"),
  activeMarketType: text("active_market_type").default("forex"), // forex | indices | stocks | synthetic | crypto
  accountMode: text("account_mode").notNull().default("DEMO"),  // DEMO | LIVE
  theme: text("theme").notNull().default("dark"),

  // ── Eleanor Voice (per-user, backend = source of truth, LS = cache) ──────────
  // All voice toggles are nullable so "never set" is distinguishable from
  // "explicitly set to false". Defaults below match the legacy localStorage
  // defaults so behaviour is preserved on first read.
  eleanorVoiceEnabled:       boolean("eleanor_voice_enabled").default(true),
  eleanorSpeakResponses:     boolean("eleanor_speak_responses").default(true),
  eleanorAutoListen:         boolean("eleanor_auto_listen").default(true),
  eleanorBrowserFallback:    boolean("eleanor_browser_fallback").default(true),
  // "auto" | "elevenlabs" | "openai" | "browser"
  eleanorTtsProvider:        text("eleanor_tts_provider").default("auto"),
  eleanorTtsVoiceId:         text("eleanor_tts_voice_id"),

  // ── AI assistant display name (per-user personalization) ──────────────────
  // Nullable: NULL means "never customized" and the app falls back to the
  // app-level default (Eleanor). Personalization only — no AI/safety behavior.
  assistantDisplayName:   text("assistant_display_name"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertUserSettingsSchema = createInsertSchema(userSettingsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertUserSettings = z.infer<typeof insertUserSettingsSchema>;
export type UserSettings = typeof userSettingsTable.$inferSelect;
