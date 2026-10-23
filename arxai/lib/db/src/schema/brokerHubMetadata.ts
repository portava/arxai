import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";

// Phase 0B broker-hub metadata is deliberately descriptive only. These tables
// do not replace mt5_connection, contain credentials, or authorize any action.
// A later approved credential slice may introduce an opaque reference through a
// dedicated vault boundary; no credential reference exists in this schema.
export const brokerHubConnectionsTable = pgTable(
  "broker_hub_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    venue: text("venue").notNull(),
    environment: text("environment").notNull().default("UNKNOWN"),
    status: text("status").notNull().default("NOT_IMPLEMENTED"),
    adapterNativeStatus: text("adapter_native_status"),
    nativeConnectionRef: text("native_connection_ref"),
    disabledReason: text("disabled_reason").notNull().default("ONBOARDING_REQUIRED"),
    tradingEnabled: boolean("trading_enabled").notNull().default(false),
    automationEnabled: boolean("automation_enabled").notNull().default(false),
    canPlaceLiveTrade: boolean("can_place_live_trade").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    ownerIdx: index("broker_hub_connections_owner_idx").on(table.userId, table.id),
    ownerIdentityUq: unique("broker_hub_connections_id_owner_uq").on(
      table.id,
      table.userId,
    ),
    ownerNativeUq: uniqueIndex("broker_hub_connections_owner_venue_native_uq").on(
      table.userId,
      table.venue,
      table.nativeConnectionRef,
    ),
    tradingDisabled: check(
      "broker_hub_connections_trading_disabled_ck",
      sql`${table.tradingEnabled} = false`,
    ),
    automationDisabled: check(
      "broker_hub_connections_automation_disabled_ck",
      sql`${table.automationEnabled} = false`,
    ),
    livePlacementDisabled: check(
      "broker_hub_connections_live_placement_disabled_ck",
      sql`${table.canPlaceLiveTrade} = false`,
    ),
  }),
);

export const brokerHubAccountsTable = pgTable(
  "broker_hub_accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id").notNull(),
    nativeAccountRef: text("native_account_ref"),
    adapterNativeStatus: text("adapter_native_status"),
    status: text("status").notNull().default("NOT_IMPLEMENTED"),
    accountRefMasked: text("account_ref_masked"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    ownerConnectionFk: foreignKey({
      name: "broker_hub_accounts_owner_connection_fk",
      columns: [table.connectionId, table.userId],
      foreignColumns: [brokerHubConnectionsTable.id, brokerHubConnectionsTable.userId],
    }).onDelete("cascade"),
    ownerConnectionIdx: index("broker_hub_accounts_owner_connection_idx").on(
      table.userId,
      table.connectionId,
    ),
    ownedIdentityUq: unique("broker_hub_accounts_id_connection_owner_uq").on(
      table.id,
      table.connectionId,
      table.userId,
    ),
    connectionNativeUq: uniqueIndex("broker_hub_accounts_connection_native_uq").on(
      table.connectionId,
      table.nativeAccountRef,
    ),
  }),
);

export const brokerHubInstrumentsTable = pgTable(
  "broker_hub_instruments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id").notNull(),
    accountId: uuid("account_id").notNull(),
    nativeInstrumentRef: text("native_instrument_ref").notNull(),
    exactBrokerSymbol: text("exact_broker_symbol").notNull(),
    displaySymbol: text("display_symbol"),
    adapterNativeStatus: text("adapter_native_status"),
    status: text("status").notNull().default("DISCOVERY_REQUIRED"),
    discoveredAt: timestamp("discovered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    ownerAccountFk: foreignKey({
      name: "broker_hub_instruments_owner_account_fk",
      columns: [table.accountId, table.connectionId, table.userId],
      foreignColumns: [
        brokerHubAccountsTable.id,
        brokerHubAccountsTable.connectionId,
        brokerHubAccountsTable.userId,
      ],
    }).onDelete("cascade"),
    ownerAccountIdx: index("broker_hub_instruments_owner_account_idx").on(
      table.userId,
      table.accountId,
    ),
    ownedIdentityUq: unique("broker_hub_instruments_id_account_connection_owner_uq").on(
      table.id,
      table.accountId,
      table.connectionId,
      table.userId,
    ),
    accountNativeUq: uniqueIndex("broker_hub_instruments_account_native_uq").on(
      table.accountId,
      table.nativeInstrumentRef,
    ),
    accountSymbolUq: uniqueIndex("broker_hub_instruments_account_symbol_uq").on(
      table.accountId,
      table.exactBrokerSymbol,
    ),
  }),
);

export const brokerHubDiscoveryEvidenceTable = pgTable(
  "broker_hub_discovery_evidence",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id").notNull(),
    accountId: uuid("account_id"),
    instrumentId: uuid("instrument_id"),
    nativeDiscoveryRef: text("native_discovery_ref").notNull(),
    adapterNativeStatus: text("adapter_native_status"),
    status: text("status").notNull().default("DISCOVERY_REQUIRED"),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    source: text("source").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    ownerConnectionFk: foreignKey({
      name: "broker_hub_discovery_owner_connection_fk",
      columns: [table.connectionId, table.userId],
      foreignColumns: [brokerHubConnectionsTable.id, brokerHubConnectionsTable.userId],
    }).onDelete("cascade"),
    ownerAccountFk: foreignKey({
      name: "broker_hub_discovery_owner_account_fk",
      columns: [table.accountId, table.connectionId, table.userId],
      foreignColumns: [
        brokerHubAccountsTable.id,
        brokerHubAccountsTable.connectionId,
        brokerHubAccountsTable.userId,
      ],
    }).onDelete("cascade"),
    ownerInstrumentFk: foreignKey({
      name: "broker_hub_discovery_owner_instrument_fk",
      columns: [
        table.instrumentId,
        table.accountId,
        table.connectionId,
        table.userId,
      ],
      foreignColumns: [
        brokerHubInstrumentsTable.id,
        brokerHubInstrumentsTable.accountId,
        brokerHubInstrumentsTable.connectionId,
        brokerHubInstrumentsTable.userId,
      ],
    }).onDelete("cascade"),
    instrumentRequiresAccount: check(
      "broker_hub_discovery_instrument_requires_account_ck",
      sql`${table.instrumentId} IS NULL OR ${table.accountId} IS NOT NULL`,
    ),
    ownerConnectionIdx: index("broker_hub_discovery_owner_connection_idx").on(
      table.userId,
      table.connectionId,
    ),
    connectionNativeUq: uniqueIndex("broker_hub_discovery_connection_native_uq").on(
      table.connectionId,
      table.nativeDiscoveryRef,
    ),
  }),
);

export type BrokerHubConnection = typeof brokerHubConnectionsTable.$inferSelect;
export type BrokerHubAccount = typeof brokerHubAccountsTable.$inferSelect;
export type BrokerHubInstrument = typeof brokerHubInstrumentsTable.$inferSelect;
export type BrokerHubDiscoveryEvidence = typeof brokerHubDiscoveryEvidenceTable.$inferSelect;