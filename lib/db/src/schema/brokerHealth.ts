import { pgTable, serial, integer, text, real, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";

// Build G — Broker/MT5 Connection Health Monitor.
// Two surfaces:
//   1. broker_health_logs  — append-only audit trail (one row per health snapshot)
//   2. broker_health_state — singleton row holding operator-controlled toggles
//                            (executionEnabled, maintenanceMode, lastErrorCode)
//
// Live process telemetry (heartbeat, balance, equity, positions, lastSyncAt)
// stays in mt5_state. This file does not duplicate those columns.

export const brokerHealthLogsTable = pgTable("broker_health_logs", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  brokerName: text("broker_name"),
  status: text("status").notNull(),                          // BrokerHealthStatus enum
  latencyMs: integer("latency_ms"),
  priceFeedDelayMs: integer("price_feed_delay_ms"),
  lastHeartbeatAt: timestamp("last_heartbeat_at"),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  reconnectAttempts: integer("reconnect_attempts").notNull().default(0),
  executionEnabled: boolean("execution_enabled").notNull().default(false),
  reasons: jsonb("reasons").notNull().default([]),           // string[]
  warnings: jsonb("warnings").notNull().default([]),         // string[]
  blockers: jsonb("blockers").notNull().default([]),         // string[]
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const brokerHealthStateTable = pgTable("broker_health_state", {
  id: serial("id").primaryKey(),
  // Operator-controlled toggles. Default-closed: execution disabled, no maintenance.
  executionEnabled: boolean("execution_enabled").notNull().default(false),
  maintenanceMode: boolean("maintenance_mode").notNull().default(false),
  // Last known error from the bridge / EA. Cleared on successful health check.
  lastErrorCode: text("last_error_code"),
  lastErrorMessage: text("last_error_message"),
  lastErrorAt: timestamp("last_error_at"),
  // Reconnect bookkeeping (resets to 0 on CONNECTED snapshot).
  reconnectAttempts: integer("reconnect_attempts").notNull().default(0),
  lastReconnectAt: timestamp("last_reconnect_at"),
  // Cached most-recent evaluator result for fast reads.
  lastStatus: text("last_status").notNull().default("DISCONNECTED"),
  lastEvaluatedAt: timestamp("last_evaluated_at"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type BrokerHealthLog = typeof brokerHealthLogsTable.$inferSelect;
export type BrokerHealthState = typeof brokerHealthStateTable.$inferSelect;
