// TradingView Alerts — incoming webhook alerts from TradingView Pine Script.
//
// SAFETY:
//   - Alerts are NEVER auto-executed. They are scored and presented to the
//     user/Ruby for review only.
//   - No broker calls, no MT5 commands, no canPlaceTrades modifications.
//   - Each alert is scored against the scanner, user history, and market
//     structure before Ruby considers it.
//   - Source trust = MEDIUM (user-configured, unverified external signal).

import {
  pgTable, serial, integer, text, real, boolean,
  timestamp, jsonb, index,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const tradingviewAlertsTable = pgTable("tradingview_alerts", {
  id:          serial("id").primaryKey(),
  alertId:     text("alert_id").notNull(),           // uuid generated on receipt

  // ── User association ────────────────────────────────────────────────────
  // Linked to user via webhook token (TV_WEBHOOK_TOKEN_<userId>)
  userId:      integer("user_id").references(() => usersTable.id),
  webhookKey:  text("webhook_key"),                  // masked key used to identify user

  // ── Raw alert payload ───────────────────────────────────────────────────
  rawPayload:  jsonb("raw_payload").notNull().default({}),

  // ── Parsed fields ────────────────────────────────────────────────────────
  symbol:      text("symbol"),
  action:      text("action"),                       // BUY | SELL | CLOSE | WAIT | INFO
  price:       real("price"),
  strategyName: text("strategy_name"),               // Pine Script strategy/indicator name
  timeframe:   text("timeframe"),
  message:     text("message"),                      // raw alert message

  // ── ARX scoring (filled async after receipt) ───────────────────────────
  scored:       boolean("scored").notNull().default(false),
  scannerScore: real("scanner_score"),               // 0-100, from ARX scanner
  userHistoryScore: real("user_history_score"),      // 0-100, from user's imported history
  newsRiskLevel: text("news_risk_level"),             // none|low|medium|high|critical
  spreadWarning: boolean("spread_warning").notNull().default(false),
  overallScore:  real("overall_score"),              // composite 0-100
  scoreLabel:    text("score_label"),                // STRONG|MODERATE|WEAK|AVOID|UNSCORED
  scoreReason:   text("score_reason"),               // plain-language explanation
  scoredAt:      timestamp("scored_at", { withTimezone: true }),

  // ── Status ───────────────────────────────────────────────────────────────
  // received = just arrived, scored = ARX has reviewed it,
  // notified = user was notified, dismissed = user dismissed it,
  // acted = user placed a trade after seeing this alert
  status:      text("status").notNull().default("received"),
  notifiedAt:  timestamp("notified_at", { withTimezone: true }),

  receivedAt:  timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt:   timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  alertIdIdx:  index("tva_alert_id_idx").on(t.alertId),
  userIdx:     index("tva_user_idx").on(t.userId),
  symbolIdx:   index("tva_symbol_idx").on(t.symbol),
  receivedIdx: index("tva_received_at_idx").on(t.receivedAt),
}));

export type TradingviewAlertRow = typeof tradingviewAlertsTable.$inferSelect;

// ── Webhook token registry ────────────────────────────────────────────────────
// Each user generates a secret token. TradingView alerts include it in the URL
// or payload so ARX can map the alert to the correct user.
// Token is hashed before storage — never stored in plaintext.
export const webhookTokensTable = pgTable("webhook_tokens", {
  id:           serial("id").primaryKey(),
  userId:       integer("user_id").notNull().references(() => usersTable.id),
  tokenHash:    text("token_hash").notNull(),        // SHA-256 of the raw token
  tokenMasked:  text("token_masked").notNull(),      // first 4 + last 4 chars for display
  label:        text("label").notNull().default("TradingView"),
  isActive:     boolean("is_active").notNull().default(true),
  lastUsedAt:   timestamp("last_used_at", { withTimezone: true }),
  createdAt:    timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  hashIdx: index("wt_token_hash_idx").on(t.tokenHash),
  userIdx: index("wt_user_idx").on(t.userId),
}));

export type WebhookTokenRow = typeof webhookTokensTable.$inferSelect;
