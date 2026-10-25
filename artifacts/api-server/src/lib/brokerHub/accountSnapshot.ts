// ── Broker Hub — authoritative account snapshot (owner decision 16) ────────
//
// Pure. One authoritative balance/equity snapshot per MT5 connection, owned by
// Broker Hub. It carries:
//   - the figures (balance, equity, margin, free margin, currency);
//   - the account identity (connection id, owning user, login, server, broker);
//   - provenance (which feed it came from, and whether that feed is the
//     authoritative one);
//   - the observation time (when the EA last delivered the figures).
//
// Feeds:
//   mt5_connection — per connection, written by the EA authenticated with that
//                    connection's own bridge token. AUTHORITATIVE.
//   mt5_state      — legacy EA account feed (per user, or the platform row with
//                    user_id NULL). Kept as a compatibility projection only. It
//                    has no connection id, so it is never authoritative.
//
// Rules this module enforces:
//   - Figures are reported only when the EA actually delivered them (the
//     connection's `accountSyncedAt` is set). The DB defaults balance/equity to
//     0, so a never-synced connection is `unknown`, never a fabricated 0.
//   - Platform-account figures (mt5_state with no owner) are never substituted
//     for a trader's account.
//   - A source is chosen only with identity evidence (same owner, same login,
//     same server). Without it the answer is `unknown`.
//   - `reconcileAccountSnapshots` diffs the authoritative snapshot against the
//     legacy projection. It reports; it never chooses or writes.

export type AccountSnapshotFeed = "mt5_connection" | "mt5_state";

export type AccountSnapshotUnknownReason =
  | "NO_CONNECTION"
  | "NOT_OWNER"
  | "NEVER_SYNCED"
  | "INVALID_OBSERVATION_TIME"
  | "NO_LEGACY_ROW"
  | "PLATFORM_FEED_NOT_A_TRADER_ACCOUNT"
  | "NO_IDENTITY_EVIDENCE";

export interface AccountIdentity {
  /** The MT5 connection this snapshot belongs to; null for the legacy feed (it has none). */
  readonly connectionId: number | null;
  /** The owning user; null for the platform (install-wide) feed. */
  readonly userId: number | null;
  /** Broker account login (account number), as reported by the EA. */
  readonly login: string | null;
  readonly server: string | null;
  readonly broker: string | null;
}

export interface AccountSnapshotProvenance {
  readonly feed: AccountSnapshotFeed;
  /** True only for the per-connection feed. */
  readonly authoritative: boolean;
}

export interface AccountSnapshot {
  readonly status: "observed" | "unknown";
  readonly unknownReason: AccountSnapshotUnknownReason | null;
  readonly identity: AccountIdentity;
  readonly provenance: AccountSnapshotProvenance;
  /** When the EA delivered these figures (ISO), or null when unknown. */
  readonly observedAt: string | null;
  readonly observedAtMs: number | null;
  readonly currency: string | null;
  readonly balance: number | null;
  readonly equity: number | null;
  readonly margin: number | null;
  readonly freeMargin: number | null;
}

/** The mt5_connection facts the snapshot needs (a stored row satisfies it). */
export interface ConnectionAccountFacts {
  readonly id: number;
  readonly userId: number | null;
  readonly accountNumber: string | null;
  readonly brokerName: string | null;
  readonly serverName: string | null;
  readonly accountCurrency: string | null;
  readonly accountBalance: number | null;
  readonly accountEquity: number | null;
  readonly margin: number | null;
  readonly freeMargin: number | null;
  readonly accountSyncedAt: Date | null;
}

/** The mt5_state facts the legacy projection needs (a stored row satisfies it). */
export interface LegacyStateAccountFacts {
  readonly userId: number | null;
  readonly account: string | null;
  readonly broker: string | null;
  readonly server: string | null;
  readonly currency: string | null;
  readonly balance: number | null;
  readonly equity: number | null;
  readonly margin: number | null;
  readonly freeMargin: number | null;
  readonly lastSyncAt: Date | null;
}

const NO_IDENTITY: AccountIdentity = { connectionId: null, userId: null, login: null, server: null, broker: null };

function finiteOrNull(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function textOrNull(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
}

function validTimeMs(d: Date | null | undefined): number | null {
  if (!(d instanceof Date)) return null;
  const ms = d.getTime();
  return Number.isFinite(ms) ? ms : null;
}

function unknownSnapshot(
  reason: AccountSnapshotUnknownReason,
  identity: AccountIdentity,
  feed: AccountSnapshotFeed,
): AccountSnapshot {
  return {
    status: "unknown",
    unknownReason: reason,
    identity,
    provenance: { feed, authoritative: feed === "mt5_connection" },
    observedAt: null,
    observedAtMs: null,
    currency: null,
    balance: null,
    equity: null,
    margin: null,
    freeMargin: null,
  };
}

/**
 * The authoritative snapshot for one MT5 connection. `unknown` when there is
 * no connection or the EA has never delivered account figures for it.
 */
export function connectionAccountSnapshot(conn: ConnectionAccountFacts | null | undefined): AccountSnapshot {
  if (!conn) return unknownSnapshot("NO_CONNECTION", NO_IDENTITY, "mt5_connection");
  const identity: AccountIdentity = {
    connectionId: conn.id,
    userId: conn.userId,
    login: textOrNull(conn.accountNumber),
    server: textOrNull(conn.serverName),
    broker: textOrNull(conn.brokerName),
  };
  if (conn.accountSyncedAt == null) return unknownSnapshot("NEVER_SYNCED", identity, "mt5_connection");
  const observedAtMs = validTimeMs(conn.accountSyncedAt);
  if (observedAtMs == null) return unknownSnapshot("INVALID_OBSERVATION_TIME", identity, "mt5_connection");
  return {
    status: "observed",
    unknownReason: null,
    identity,
    provenance: { feed: "mt5_connection", authoritative: true },
    observedAt: new Date(observedAtMs).toISOString(),
    observedAtMs,
    currency: textOrNull(conn.accountCurrency),
    balance: finiteOrNull(conn.accountBalance),
    equity: finiteOrNull(conn.accountEquity),
    margin: finiteOrNull(conn.margin),
    freeMargin: finiteOrNull(conn.freeMargin),
  };
}

/** The legacy mt5_state row as a (non-authoritative) compatibility projection. */
export function legacyStateAccountSnapshot(row: LegacyStateAccountFacts | null | undefined): AccountSnapshot {
  if (!row) return unknownSnapshot("NO_LEGACY_ROW", NO_IDENTITY, "mt5_state");
  const identity: AccountIdentity = {
    connectionId: null,
    userId: row.userId,
    login: textOrNull(row.account),
    server: textOrNull(row.server),
    broker: textOrNull(row.broker),
  };
  if (row.lastSyncAt == null) return unknownSnapshot("NEVER_SYNCED", identity, "mt5_state");
  const observedAtMs = validTimeMs(row.lastSyncAt);
  if (observedAtMs == null) return unknownSnapshot("INVALID_OBSERVATION_TIME", identity, "mt5_state");
  return {
    status: "observed",
    unknownReason: null,
    identity,
    provenance: { feed: "mt5_state", authoritative: false },
    observedAt: new Date(observedAtMs).toISOString(),
    observedAtMs,
    currency: textOrNull(row.currency),
    balance: finiteOrNull(row.balance),
    equity: finiteOrNull(row.equity),
    margin: finiteOrNull(row.margin),
    freeMargin: finiteOrNull(row.freeMargin),
  };
}

/**
 * The account figures a live snapshot builder consumes: the observed figures,
 * or all-null when unknown (never a default 0).
 */
export function accountFiguresOf(s: AccountSnapshot): {
  balance: number | null;
  equity: number | null;
  margin: number | null;
  freeMargin: number | null;
  syncedAtMs: number | null;
} {
  if (s.status !== "observed") return { balance: null, equity: null, margin: null, freeMargin: null, syncedAtMs: null };
  return { balance: s.balance, equity: s.equity, margin: s.margin, freeMargin: s.freeMargin, syncedAtMs: s.observedAtMs };
}

// ── Identity evidence ───────────────────────────────────────────────────────

export type AccountIdentityMatch =
  | "match"
  | "different_tenant"
  | "platform_feed"
  | "different_account"
  | "no_evidence";

function normLogin(v: string | null): string | null {
  return v == null ? null : v.replace(/\s+/g, "");
}

function normServer(v: string | null): string | null {
  return v == null ? null : v.replace(/\s+/g, "").toLowerCase();
}

/**
 * Do two snapshots describe the same broker account of the same tenant?
 * Requires the same non-null owner, and the same login AND server. Anything
 * less is not evidence.
 */
export function compareAccountIdentity(a: AccountIdentity, b: AccountIdentity): AccountIdentityMatch {
  if (a.userId == null || b.userId == null) return "platform_feed";
  if (a.userId !== b.userId) return "different_tenant";
  const la = normLogin(a.login);
  const lb = normLogin(b.login);
  const sa = normServer(a.server);
  const sb = normServer(b.server);
  if (la == null || lb == null || sa == null || sb == null) return "no_evidence";
  if (la !== lb || sa !== sb) return "different_account";
  return "match";
}

// ── Reconciliation (report only) ────────────────────────────────────────────

export const ACCOUNT_RECONCILE_TOLERANCE = 0.01;

export type AccountReconcileField = "balance" | "equity" | "margin" | "freeMargin" | "currency";

export interface AccountReconcileDiff {
  readonly field: AccountReconcileField;
  readonly authoritative: number | string | null;
  readonly legacy: number | string | null;
  /** legacy − authoritative for numeric fields; null otherwise. */
  readonly delta: number | null;
  readonly agrees: boolean;
}

export interface AccountReconciliation {
  /**
   * consistent     — same account, every comparable field agrees;
   * diverged       — same account, at least one field differs;
   * not_comparable — no identity evidence, different tenant/account, the
   *                  platform feed, or either side unknown.
   */
  readonly verdict: "consistent" | "diverged" | "not_comparable";
  readonly identity: AccountIdentityMatch | "unknown_side";
  readonly reasons: readonly string[];
  readonly diffs: readonly AccountReconcileDiff[];
  /** legacy.observedAtMs − authoritative.observedAtMs, when both are known. */
  readonly observedAtSkewMs: number | null;
  readonly authoritative: AccountSnapshot;
  readonly legacy: AccountSnapshot;
}

function numDiff(field: AccountReconcileField, a: number | null, l: number | null, tol: number): AccountReconcileDiff {
  if (a == null || l == null) return { field, authoritative: a, legacy: l, delta: null, agrees: a == null && l == null };
  const delta = Math.round((l - a) * 1e6) / 1e6;
  return { field, authoritative: a, legacy: l, delta, agrees: Math.abs(delta) <= tol };
}

/**
 * Diff the authoritative per-connection snapshot against the legacy mt5_state
 * projection. Reports only. A platform row, another tenant's row, another
 * account's row, or a row without identity evidence is `not_comparable` and
 * its figures are not compared.
 */
export function reconcileAccountSnapshots(
  authoritative: AccountSnapshot,
  legacy: AccountSnapshot,
  opts: { tolerance?: number } = {},
): AccountReconciliation {
  const tol = opts.tolerance ?? ACCOUNT_RECONCILE_TOLERANCE;
  const base = { diffs: [] as AccountReconcileDiff[], observedAtSkewMs: null, authoritative, legacy };
  if (authoritative.status !== "observed" || legacy.status !== "observed") {
    const reasons: string[] = [];
    if (authoritative.status !== "observed") reasons.push(`authoritative snapshot unknown (${authoritative.unknownReason})`);
    if (legacy.status !== "observed") reasons.push(`legacy projection unknown (${legacy.unknownReason})`);
    return { ...base, verdict: "not_comparable", identity: "unknown_side", reasons };
  }
  const identity = compareAccountIdentity(authoritative.identity, legacy.identity);
  if (identity !== "match") {
    const why: Record<Exclude<AccountIdentityMatch, "match">, string> = {
      platform_feed: "legacy row is the platform (ownerless) feed; never compared with a trader's account",
      different_tenant: "legacy row belongs to another user",
      different_account: "legacy row reports a different login or server",
      no_evidence: "login or server missing on one side; no identity evidence",
    };
    return { ...base, verdict: "not_comparable", identity, reasons: [why[identity]] };
  }
  const diffs: AccountReconcileDiff[] = [
    numDiff("balance", authoritative.balance, legacy.balance, tol),
    numDiff("equity", authoritative.equity, legacy.equity, tol),
    numDiff("margin", authoritative.margin, legacy.margin, tol),
    numDiff("freeMargin", authoritative.freeMargin, legacy.freeMargin, tol),
  ];
  const ca = authoritative.currency?.toUpperCase() ?? null;
  const cl = legacy.currency?.toUpperCase() ?? null;
  diffs.push({ field: "currency", authoritative: ca, legacy: cl, delta: null, agrees: ca === cl || ca == null || cl == null });
  const disagree = diffs.filter((d) => !d.agrees);
  return {
    diffs,
    observedAtSkewMs: (legacy.observedAtMs as number) - (authoritative.observedAtMs as number),
    authoritative,
    legacy,
    verdict: disagree.length ? "diverged" : "consistent",
    identity,
    reasons: disagree.map((d) => `${d.field} differs`),
  };
}

// ── Source selection for a trader ───────────────────────────────────────────

/**
 * The account snapshot to show for `userId`'s connection.
 *
 *   1. The connection must belong to `userId` (otherwise `unknown`, NOT_OWNER).
 *   2. The authoritative per-connection snapshot when observed.
 *   3. Otherwise the user's legacy mt5_state projection, ONLY with identity
 *      evidence (same owner, same login and server as the connection). Its
 *      provenance stays `mt5_state` / non-authoritative.
 *   4. Otherwise `unknown`. Never the platform feed, never another tenant.
 */
export function selectConnectionAccountSnapshot(input: {
  userId: number;
  connection: ConnectionAccountFacts | null | undefined;
  legacy?: LegacyStateAccountFacts | null;
}): AccountSnapshot {
  const { userId, connection } = input;
  if (!connection) return unknownSnapshot("NO_CONNECTION", NO_IDENTITY, "mt5_connection");
  const auth = connectionAccountSnapshot(connection);
  if (connection.userId !== userId) {
    return unknownSnapshot("NOT_OWNER", { ...NO_IDENTITY, connectionId: connection.id }, "mt5_connection");
  }
  if (auth.status === "observed") return auth;
  if (!input.legacy) return auth;
  const legacy = legacyStateAccountSnapshot(input.legacy);
  const match = compareAccountIdentity(auth.identity, legacy.identity);
  if (match === "platform_feed") return unknownSnapshot("PLATFORM_FEED_NOT_A_TRADER_ACCOUNT", auth.identity, "mt5_connection");
  if (match !== "match") return unknownSnapshot("NO_IDENTITY_EVIDENCE", auth.identity, "mt5_connection");
  if (legacy.status !== "observed") return auth;
  // Keep the connection id on the identity so the caller knows which
  // connection the projection was matched to; provenance stays legacy.
  return { ...legacy, identity: { ...legacy.identity, connectionId: connection.id } };
}
