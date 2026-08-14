// Mood Check-In — lightweight pre-trade emotional state log.
//
// A quick optional check-in before live/demo trades. Separate from
// journal entries (which are post-trade) and pre_trade_checks (which
// are playbook rule evaluations).
//
// Purpose:
//   - Capture emotional state BEFORE a trade is placed
//   - Feed into Ruby's risk assessment and DNA profile
//   - Correlate mood with trade outcomes over time
//   - Trigger protective warnings when dangerous states are detected
//
// SAFETY:
//   - Never blocks trade execution on its own — advisory only
//   - No live trading gates modified here
//   - Check-in is optional — users can skip without consequence

import {
  pgTable, serial, integer, text, boolean,
  timestamp, real, index,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const MOOD_STATES = [
  "CALM",        // ideal state — clear, focused, no pressure
  "FOCUSED",     // locked in, positive energy
  "CONFIDENT",   // high conviction — watch for overconfidence
  "UNCERTAIN",   // unsure — may need to wait
  "FRUSTRATED",  // recent loss or missed move — elevated risk
  "RUSHED",      // time pressure — dangerous
  "TIRED",       // fatigue — reduced judgment
  "REVENGE",     // actively trying to recover losses — high risk
  "FOMO",        // fear of missing out — chasing
  "OBSERVING",   // just watching, not planning to trade
] as const;

export type MoodState = typeof MOOD_STATES[number];

// High-risk moods that trigger protective warnings
export const HIGH_RISK_MOODS: MoodState[] = ["REVENGE", "FRUSTRATED", "FOMO", "RUSHED"];
export const CAUTION_MOODS:   MoodState[] = ["UNCERTAIN", "TIRED"];
export const SAFE_MOODS:      MoodState[] = ["CALM", "FOCUSED", "CONFIDENT", "OBSERVING"];

export const moodCheckInsTable = pgTable("mood_check_ins", {
  id:         serial("id").primaryKey(),
  userId:     integer("user_id").notNull().references(() => usersTable.id),

  // ── Mood state ────────────────────────────────────────────────────────
  mood:       text("mood").notNull(),           // one of MOOD_STATES
  note:       text("note"),                     // optional free-text (max 500 chars)

  // ── Context at time of check-in ───────────────────────────────────────
  // What triggered the check-in
  trigger:    text("trigger").notNull().default("manual"),
  // manual | pre_trade | after_loss | session_start | daily_limit_warning

  symbol:     text("symbol"),                   // if triggered before a specific trade
  sessionLabel: text("session_label"),          // asian|london|overlap|newyork

  // ── Risk assessment (computed on save) ───────────────────────────────
  riskLevel:  text("risk_level").notNull().default("low"),
  // low | caution | high
  warning:    text("warning"),                  // friendly warning message if high risk
  isHighRisk: boolean("is_high_risk").notNull().default(false),

  // ── Outcome correlation (filled later when a trade closes) ────────────
  linkedTradeId:   integer("linked_trade_id"),  // paper_trades.id
  tradeOutcome:    text("trade_outcome"),        // win|loss|breakeven|none
  outcomeLinkedAt: timestamp("outcome_linked_at", { withTimezone: true }),

  // ── Session performance correlation ──────────────────────────────────
  // Filled by background job to track mood→performance patterns
  sessionWins:   integer("session_wins"),
  sessionLosses: integer("session_losses"),
  sessionPnl:    real("session_pnl"),

  checkedInAt: timestamp("checked_in_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt:   timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userIdx:    index("mci_user_idx").on(t.userId),
  moodIdx:    index("mci_mood_idx").on(t.mood),
  checkedIdx: index("mci_checked_at_idx").on(t.checkedInAt),
}));

export type MoodCheckInRow = typeof moodCheckInsTable.$inferSelect;
