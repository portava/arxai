import { pgTable, serial, text, boolean, jsonb, timestamp, integer } from "drizzle-orm/pg-core";

export const playbookAdminSettingsTable = pgTable("playbook_admin_settings", {
  id: serial("id").primaryKey(),
  playbookEnforcementEnabled: boolean("playbook_enforcement_enabled").notNull().default(true),
  requireSetupBeforeLive: boolean("require_setup_before_live").notNull().default(false),
  disabledTemplates: jsonb("disabled_templates").$type<string[]>().notNull().default([]),
  setupRiskWarnings: jsonb("setup_risk_warnings").$type<Array<{ setupType: string; warning: string; severity: string }>>().notNull().default([]),
  updatedBy: integer("updated_by"),
  updatedReason: text("updated_reason"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type PlaybookAdminSettings = typeof playbookAdminSettingsTable.$inferSelect;
export type NewPlaybookAdminSettings = typeof playbookAdminSettingsTable.$inferInsert;
