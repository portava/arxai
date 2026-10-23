// Risk Templates — admin-defined reusable settings bundles that can be
// pushed to one, many, or all users via the Admin User Control Center.
//
// SAFETY: a template can carry caps and toggles but CANNOT carry
// `liveTradingApproved=true` or `sharedBridgeApproved=true`. Those two
// fields are explicitly omitted from the payload shape and the push
// endpoint refuses any attempt to set them via a template — they must
// be granted by an admin per-user with a typed confirmation phrase.
import {
  pgTable, serial, integer, text, timestamp, jsonb, boolean,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export interface RiskTemplatePayload {
  // Numeric caps
  maxLotSize?: number | null;
  maxDailyLossUsd?: number | null;
  maxOpenTrades?: number | null;
  maxExposurePerSymbolLots?: number | null;
  minRewardRiskRatio?: number | null;
  // Symbol controls
  allowedSymbols?: string[];
  blockedSymbols?: string[];
  // Behaviour toggles (lower-risk, single-confirm pushable)
  stopLossRequired?: boolean;
  takeProfitRequired?: boolean;
  oneClickTradingEnabled?: boolean;
  aiTradingEnabled?: boolean;
  aiAutoCloseEnabled?: boolean;
  rubyVoiceEnabled?: boolean;
  newsIntelligenceEnabled?: boolean;
  historicalBacktestEnabled?: boolean;
  scannerLiveEnabled?: boolean;
  adminMemo?: string;
}

export const riskTemplatesTable = pgTable(
  "risk_templates",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    payload: jsonb("payload").$type<RiskTemplatePayload>().notNull().default({}),
    isArchived: boolean("is_archived").notNull().default(false),
    createdBy: integer("created_by").notNull().references(() => usersTable.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    nameUq: uniqueIndex("risk_templates_name_uq").on(t.name),
  }),
);

export type RiskTemplate = typeof riskTemplatesTable.$inferSelect;
