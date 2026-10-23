import { pgTable, serial, integer, text, real, boolean, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Per-user MT5 bridge connection metadata. Distinct from the global
// `mt5_state` table (single live process state), this holds per-user
// connection records, including a hashed bridge token for EA auth lookups.
//
// Phase 3B (May 2026): added connectionName/server/leverage/currency,
// bridge token hashing fields (tokenLast4/createdAt/revokedAt),
// safety flags (readOnlyMode/allowOrderExecution/liveLocked), and
// status taxonomy (waiting|connected|stale|disconnected|revoked).
// `apiKeyHash` is the canonical hashed bridge token. Raw token is NEVER stored.
export const mt5ConnectionTable = pgTable("mt5_connection", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  connectionName: text("connection_name"),
  status: text("status").notNull().default("waiting"), // waiting|connected|stale|disconnected|revoked
  apiKeyHash: text("api_key_hash"),                    // hashed bridge token (never raw)
  tokenLast4: text("token_last4"),
  tokenCreatedAt: timestamp("token_created_at"),
  tokenRevokedAt: timestamp("token_revoked_at"),
  // Task #31 — operator-driven bridge token rotation. When an admin/OWNER
  // rotates a connection's token, the freshly issued token's SHA-256 hash
  // replaces `apiKeyHash` and the OLD hash is parked in `previousApiKeyHash`
  // with an expiry in `previousTokenExpiresAt`. `bridgeAuthPerUserOnly`
  // accepts the previous hash ONLY while now < previousTokenExpiresAt (a
  // bounded grace window so a running EA is not instantly locked out). After
  // expiry, or when no grace was requested, the previous hash is dead. The
  // raw rotated token is shown to the admin exactly once at rotation time
  // and is NEVER stored or re-served. Rotation is fully audited.
  previousApiKeyHash: text("previous_api_key_hash"),
  previousTokenExpiresAt: timestamp("previous_token_expires_at"),
  tokenRotatedAt: timestamp("token_rotated_at"),
  tokenRotatedByAdminId: integer("token_rotated_by_admin_id"),
  tokenRotationReason: text("token_rotation_reason"),
  lastHeartbeat: timestamp("last_heartbeat"),
  // When the EA last delivered a COMPLETE open-positions snapshot for this
  // bridge (POST /mt5/sync-live-positions or /mt5/positions-snapshot). Stamped
  // on EVERY snapshot ingest, including an empty list (broker flat). This is the
  // authoritative "a full broker sweep landed at T" signal used by the live
  // position READ layers: a stale/missing position row is only treated as
  // broker-confirmed-absent when this marker is recent (a reliable complete
  // sweep excluded it). Decoupled from row timestamps so an empty snapshot
  // still clears closed rows, while a delayed/absent snapshot keeps every open
  // position visible pending confirmation. NEVER drives auto-close (ALERT_ONLY).
  lastPositionsSnapshotAt: timestamp("last_positions_snapshot_at"),
  accountNumber: text("account_number"),
  brokerName: text("broker_name"),
  serverName: text("server_name"),
  accountCurrency: text("account_currency"),
  accountBalance: real("account_balance").default(0),
  accountEquity: real("account_equity").default(0),
  margin: real("margin").default(0),
  freeMargin: real("free_margin").default(0),
  // Task #335 — the moment the EA last delivered real balance/equity for this
  // bridge (stamped by heartbeat when it carries balance/equity, and by every
  // /mt5/sync-account ingest). Distinct from updatedAt (which bumps on ANY
  // patch, e.g. token rotation) so the live snapshot can honestly age the
  // account figures: the Account Snapshot card flags equity as stale when this
  // is more than 60s old. NULL until the EA has account-synced at least once.
  accountSyncedAt: timestamp("account_synced_at"),
  leverage: integer("leverage"),
  // Safety flags (Phase 3E) — locked defaults; updates require future approval gates.
  readOnlyMode: boolean("read_only_mode").notNull().default(true),
  allowOrderExecution: boolean("allow_order_execution").notNull().default(false),
  liveLocked: boolean("live_locked").notNull().default(true),
  mode: text("mode").notNull().default("MOCK"),        // MOCK | DEMO | LIVE_LOCKED | LIVE
  // Phase 3 (May 2026) — account class as reported by the broker. The
  // order guard chain (gate 5: account_type) requires this to be exactly
  // 'demo' to accept a DEMO order or exactly 'live'/'real' to accept a
  // LIVE order. Default 'unknown' is fail-closed — guards will reject
  // any real order until the EA populates this on heartbeat from
  // AccountInfoInteger(ACCOUNT_TRADE_MODE).
  accountType: text("account_type").notNull().default("unknown"), // unknown | demo | live | real
  // Phase TU (May 2026) — bridge capability disclosure reported by the EA on
  // heartbeat. Optional / nullable: if missing or all-false, the backend
  // treats the bridge as "legacy market-only" and refuses pending-order
  // submission with BRIDGE_UNSUPPORTED. NEVER used to *enable* execution —
  // only to honestly *disable* it earlier in the chain.
  capabilities: jsonb("capabilities"),
  capabilitiesReportedAt: timestamp("capabilities_reported_at"),
  eaVersion: text("ea_version"),
  // Task #30 — clock-drift detection. The EA heartbeat reports its own GMT
  // clock plus local + broker server time (display only). ARX records its own
  // receive time, computes drift, and flags stale / future timestamps. When
  // drift is WARN/SEVERE, latency stats are not trusted and a SEVERE drift can
  // block the Live Test Cycle. Display-only fields are stored as text exactly
  // as reported (no parsing assumptions).
  eaLocalTime: text("ea_local_time"),
  brokerTime: text("broker_time"),
  heartbeatReceivedAt: timestamp("heartbeat_received_at"),
  clockDriftSeconds: real("clock_drift_seconds"),
  clockDriftSeverity: text("clock_drift_severity"), // OK | WARN | SEVERE
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  userIdx: index("mt5_connection_user_id_idx").on(t.userId),
  tokenHashIdx: index("mt5_connection_api_key_hash_idx").on(t.apiKeyHash),
}));

export const insertMt5ConnectionSchema = createInsertSchema(mt5ConnectionTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertMt5Connection = z.infer<typeof insertMt5ConnectionSchema>;
export type Mt5Connection = typeof mt5ConnectionTable.$inferSelect;
