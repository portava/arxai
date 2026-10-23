import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// ── Market-data entitlement records (R4 slice 7 — audit-marketdata §4.4) ────
//
// Spec §10.3: a per-(connection|provider, instrument) RECORD of the feed
// quality actually available — realtime / delayed / snapshot / unavailable —
// so decision surfaces and the feed-status endpoints can state entitlement as
// a recorded fact with a verification instant, instead of leaving the
// provenance envelope's `delayed` flag permanently `null` ("entitlement
// unknown") and freshness forever being inferred from trailing intervals.
//
// SCOPE THIS WAVE: schema + insert/select types ONLY. No writers exist yet —
// they arrive with the R6 entitlement hub (verification probes at bridge
// connect / provider warm-up). Until a row exists for a (scope, symbol), the
// honest answer remains "entitlement unknown" (`delayed: null` in
// SeriesProvenance) — consumers MUST NOT treat an absent row as "realtime".
//
// KEYING: one row per (provider, connectionScope, canonicalSymbol).
//   - `provider`           — router provider id ("mt5_broker" | "deriv" |
//     "assistant_real:<sub>", e.g. "assistant_real:twelve_data"), matching
//     `SeriesProvenance.providerId`(+subProviderId) so an envelope can be
//     joined to its entitlement record without a translation table.
//   - `bridgeConnectionId` — mt5_connection.id when the entitlement is a
//     property of one bridge/account (MT5: quote entitlements differ per
//     broker account). NULL for provider-level feeds with no per-user
//     connection (the app-level Deriv WS, third-party adapters).
//   - `connectionScope`    — NOT NULL text derived from bridgeConnectionId
//     ("bridge:<id>" | "provider_level"), present ONLY because Postgres
//     unique indexes treat NULLs as distinct: a nullable bridgeConnectionId
//     in the unique key would allow unlimited duplicate provider-level rows
//     for the same symbol. Writers MUST set it via `entitlementScopeKey()`;
//     it is a keying artifact, never a display value.
//   - `canonicalSymbol`    — the resolver's canonicalKey
//     (api/lib/data/symbolResolution.ts): the @workspace/markets universe id
//     (slug, e.g. "volatility_75_index", "eurusd") for approved markets, or
//     the normalized uppercase token for symbols outside the universe. NEVER
//     a broker-native string — broker symbols live on broker_candles rows.
//
// HONESTY: `dataQuality` records only what a verification actually observed;
// "unavailable" is a valid recorded outcome, and `lastVerifiedAt` is the
// instant of THAT verification (never bumped without re-verifying). No
// default quality exists — an unverified feed simply has no row.
//
// MIGRATION NOTE: table lands via `drizzle-kit push` on Replit (owner-run;
// this workspace never runs DB commands — the Replit env points at PROD). It
// must be exported from lib/db/src/schema/index.ts for drizzle-kit to see it
// — that registration is coordinator-owned this wave.
//
// SAFETY SCOPE: MARKET-DATA / TELEMETRY ONLY. Never touches execution, the
// live pipeline, balances, or fills.

/** The four recordable feed-quality levels (spec §10.3). Stored as plain
 *  text — no DB enum/migration coupling; writers validate against this. */
export const MARKET_DATA_QUALITY_LEVELS = [
  "realtime",
  "delayed",
  "snapshot",
  "unavailable",
] as const;
export type MarketDataQuality = (typeof MARKET_DATA_QUALITY_LEVELS)[number];

/** `connectionScope` value for entitlements not bound to a bridge. */
export const PROVIDER_LEVEL_SCOPE = "provider_level";

/** Derive the NOT-NULL unique-key scope token from an optional bridge id.
 *  Pure; the single allowed way to populate `connectionScope`. */
export function entitlementScopeKey(
  bridgeConnectionId: number | null | undefined,
): string {
  return bridgeConnectionId != null
    ? `bridge:${bridgeConnectionId}`
    : PROVIDER_LEVEL_SCOPE;
}

export const marketDataEntitlementsTable = pgTable(
  "market_data_entitlements",
  {
    id: serial("id").primaryKey(),
    // Router provider id — matches SeriesProvenance.providerId(+subProviderId).
    provider: text("provider").notNull(),
    // mt5_connection.id when connection-scoped; NULL for provider-level feeds.
    bridgeConnectionId: integer("bridge_connection_id"),
    // Derived NOT-NULL scope token ("bridge:<id>" | "provider_level") — see
    // header. Writers must use entitlementScopeKey(); part of the unique key.
    connectionScope: text("connection_scope").notNull(),
    // Resolver canonicalKey (universe id slug, or normalized token) — never a
    // broker-native symbol string.
    canonicalSymbol: text("canonical_symbol").notNull(),
    // One of MARKET_DATA_QUALITY_LEVELS. Recorded observation, no default.
    dataQuality: text("data_quality").notNull(),
    // Instant the recorded quality was actually VERIFIED (probe time) — never
    // bumped without a re-verification.
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // One entitlement record per (provider, scope, instrument). Upserts from
    // the future R6 writers target this constraint.
    uniq: uniqueIndex("market_data_entitlements_scope_uq").on(
      t.provider,
      t.connectionScope,
      t.canonicalSymbol,
    ),
    // Feed-status endpoints read per symbol across providers/scopes.
    symbolIdx: index("market_data_entitlements_symbol_idx").on(
      t.canonicalSymbol,
    ),
    // Bridge-connect verification sweep reads all rows for one bridge.
    bridgeIdx: index("market_data_entitlements_bridge_idx").on(
      t.bridgeConnectionId,
    ),
  }),
);

export type MarketDataEntitlement = typeof marketDataEntitlementsTable.$inferSelect;
export type NewMarketDataEntitlement = typeof marketDataEntitlementsTable.$inferInsert;
