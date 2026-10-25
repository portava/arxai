// Owner decision 16 — one authoritative account snapshot per MT5 connection.
// Pure: no DB, no network.
//
// Proves:
//   - the snapshot carries figures, identity, provenance and observation time;
//   - a never-synced connection is unknown (never the column default 0);
//   - the legacy mt5_state projection is never authoritative;
//   - reconciliation compares only the same tenant's same account, and reports
//     platform, other-tenant, other-account and no-evidence rows as not
//     comparable without comparing their figures;
//   - selection never substitutes the platform feed or another tenant's row,
//     and falls back to the legacy feed only with identity evidence.
//
// Run: pnpm --filter @workspace/api-server run test:broker-hub-account-snapshot

import assert from "node:assert/strict";
import test from "node:test";
import {
  accountFiguresOf,
  compareAccountIdentity,
  connectionAccountSnapshot,
  legacyStateAccountSnapshot,
  reconcileAccountSnapshots,
  selectConnectionAccountSnapshot,
  type ConnectionAccountFacts,
  type LegacyStateAccountFacts,
} from "../accountSnapshot.js";

const T = new Date("2026-10-01T12:00:00.000Z");
const USER_A = 101;
const USER_B = 202;

function conn(over: Partial<ConnectionAccountFacts> = {}): ConnectionAccountFacts {
  return {
    id: 7,
    userId: USER_A,
    accountNumber: "5012345",
    brokerName: "QA Broker",
    serverName: "QA-Demo",
    accountCurrency: "USD",
    accountBalance: 10_000,
    accountEquity: 10_250.5,
    margin: 120,
    freeMargin: 10_130.5,
    accountSyncedAt: T,
    ...over,
  };
}

function legacy(over: Partial<LegacyStateAccountFacts> = {}): LegacyStateAccountFacts {
  return {
    userId: USER_A,
    account: "5012345",
    broker: "QA Broker",
    server: "QA-Demo",
    currency: "USD",
    balance: 10_000,
    equity: 10_250.5,
    margin: 120,
    freeMargin: 10_130.5,
    lastSyncAt: new Date(T.getTime() + 2_000),
    ...over,
  };
}

test("an observed connection snapshot carries figures, identity, provenance and time", () => {
  const s = connectionAccountSnapshot(conn());
  assert.equal(s.status, "observed");
  assert.equal(s.unknownReason, null);
  assert.deepEqual(s.identity, { connectionId: 7, userId: USER_A, login: "5012345", server: "QA-Demo", broker: "QA Broker" });
  assert.deepEqual(s.provenance, { feed: "mt5_connection", authoritative: true });
  assert.equal(s.observedAt, T.toISOString());
  assert.equal(s.observedAtMs, T.getTime());
  assert.equal(s.balance, 10_000);
  assert.equal(s.equity, 10_250.5);
  assert.equal(s.currency, "USD");
});

test("a never-synced connection is unknown, not the column default 0", () => {
  const s = connectionAccountSnapshot(conn({ accountSyncedAt: null, accountBalance: 0, accountEquity: 0 }));
  assert.equal(s.status, "unknown");
  assert.equal(s.unknownReason, "NEVER_SYNCED");
  assert.equal(s.balance, null);
  assert.equal(s.equity, null);
  assert.equal(s.identity.connectionId, 7, "identity is still reported");
  assert.deepEqual(accountFiguresOf(s), { balance: null, equity: null, margin: null, freeMargin: null, syncedAtMs: null });
});

test("missing connection and invalid observation time are unknown", () => {
  assert.equal(connectionAccountSnapshot(null).unknownReason, "NO_CONNECTION");
  assert.equal(connectionAccountSnapshot(conn({ accountSyncedAt: new Date("nope") })).unknownReason, "INVALID_OBSERVATION_TIME");
});

test("non-finite figures are reported as null, never passed through", () => {
  const s = connectionAccountSnapshot(conn({ accountEquity: Number.NaN }));
  assert.equal(s.equity, null);
  assert.equal(s.balance, 10_000);
});

test("accountFiguresOf returns the observed figures and the sync time", () => {
  assert.deepEqual(accountFiguresOf(connectionAccountSnapshot(conn())), {
    balance: 10_000, equity: 10_250.5, margin: 120, freeMargin: 10_130.5, syncedAtMs: T.getTime(),
  });
});

test("the legacy mt5_state projection is never authoritative and has no connection id", () => {
  const s = legacyStateAccountSnapshot(legacy());
  assert.equal(s.status, "observed");
  assert.deepEqual(s.provenance, { feed: "mt5_state", authoritative: false });
  assert.equal(s.identity.connectionId, null);
  assert.equal(legacyStateAccountSnapshot(null).unknownReason, "NO_LEGACY_ROW");
  assert.equal(legacyStateAccountSnapshot(legacy({ lastSyncAt: null })).unknownReason, "NEVER_SYNCED");
});

test("identity evidence needs the same owner, login and server", () => {
  const a = connectionAccountSnapshot(conn()).identity;
  assert.equal(compareAccountIdentity(a, legacyStateAccountSnapshot(legacy()).identity), "match");
  assert.equal(compareAccountIdentity(a, legacyStateAccountSnapshot(legacy({ server: " qa-demo " })).identity), "match", "server compare ignores case and spaces");
  assert.equal(compareAccountIdentity(a, legacyStateAccountSnapshot(legacy({ userId: null })).identity), "platform_feed");
  assert.equal(compareAccountIdentity(a, legacyStateAccountSnapshot(legacy({ userId: USER_B })).identity), "different_tenant");
  assert.equal(compareAccountIdentity(a, legacyStateAccountSnapshot(legacy({ account: "999" })).identity), "different_account");
  assert.equal(compareAccountIdentity(a, legacyStateAccountSnapshot(legacy({ server: "Other-Live" })).identity), "different_account");
  assert.equal(compareAccountIdentity(a, legacyStateAccountSnapshot(legacy({ account: null })).identity), "no_evidence");
  assert.equal(compareAccountIdentity(a, legacyStateAccountSnapshot(legacy({ server: "  " })).identity), "no_evidence");
});

test("reconcile: same account, same figures → consistent", () => {
  const r = reconcileAccountSnapshots(connectionAccountSnapshot(conn()), legacyStateAccountSnapshot(legacy()));
  assert.equal(r.verdict, "consistent");
  assert.equal(r.identity, "match");
  assert.equal(r.observedAtSkewMs, 2_000);
  assert.ok(r.diffs.every((d) => d.agrees));
});

test("reconcile: same account, different equity → diverged with the delta", () => {
  const r = reconcileAccountSnapshots(connectionAccountSnapshot(conn()), legacyStateAccountSnapshot(legacy({ equity: 10_200.5 })));
  assert.equal(r.verdict, "diverged");
  const eq = r.diffs.find((d) => d.field === "equity")!;
  assert.equal(eq.agrees, false);
  assert.equal(eq.delta, -50);
  assert.deepEqual(r.reasons, ["equity differs"]);
});

test("reconcile: within tolerance agrees; a currency mismatch diverges", () => {
  const near = reconcileAccountSnapshots(connectionAccountSnapshot(conn()), legacyStateAccountSnapshot(legacy({ balance: 10_000.005 })));
  assert.equal(near.verdict, "consistent");
  const ccy = reconcileAccountSnapshots(connectionAccountSnapshot(conn()), legacyStateAccountSnapshot(legacy({ currency: "EUR" })));
  assert.equal(ccy.verdict, "diverged");
});

test("reconcile: platform feed, other tenant, other account and no evidence are not comparable, and figures are not compared", () => {
  const auth = connectionAccountSnapshot(conn());
  for (const [over, id] of [
    [{ userId: null, equity: 1 }, "platform_feed"],
    [{ userId: USER_B, equity: 1 }, "different_tenant"],
    [{ account: "999", equity: 1 }, "different_account"],
    [{ account: null, equity: 1 }, "no_evidence"],
  ] as const) {
    const r = reconcileAccountSnapshots(auth, legacyStateAccountSnapshot(legacy(over)));
    assert.equal(r.verdict, "not_comparable", id);
    assert.equal(r.identity, id);
    assert.equal(r.diffs.length, 0, `${id}: no figures compared`);
    assert.equal(r.reasons.length, 1);
  }
});

test("reconcile: an unknown side is not comparable", () => {
  const r = reconcileAccountSnapshots(connectionAccountSnapshot(conn({ accountSyncedAt: null })), legacyStateAccountSnapshot(legacy()));
  assert.equal(r.verdict, "not_comparable");
  assert.equal(r.identity, "unknown_side");
  assert.match(r.reasons[0]!, /NEVER_SYNCED/);
});

test("select: the authoritative snapshot wins when observed", () => {
  const s = selectConnectionAccountSnapshot({ userId: USER_A, connection: conn(), legacy: legacy({ equity: 1 }) });
  assert.equal(s.provenance.feed, "mt5_connection");
  assert.equal(s.equity, 10_250.5);
});

test("select: another tenant's connection is unknown (NOT_OWNER) and leaks nothing", () => {
  const s = selectConnectionAccountSnapshot({ userId: USER_B, connection: conn(), legacy: legacy({ userId: USER_B }) });
  assert.equal(s.status, "unknown");
  assert.equal(s.unknownReason, "NOT_OWNER");
  assert.equal(s.balance, null);
  assert.equal(s.identity.login, null, "the other tenant's login is not exposed");
});

test("select: never the platform feed for a trader's never-synced connection", () => {
  const s = selectConnectionAccountSnapshot({
    userId: USER_A,
    connection: conn({ accountSyncedAt: null }),
    legacy: legacy({ userId: null, balance: 1_000_000, equity: 1_000_000 }),
  });
  assert.equal(s.status, "unknown");
  assert.equal(s.unknownReason, "PLATFORM_FEED_NOT_A_TRADER_ACCOUNT");
  assert.equal(s.balance, null);
});

test("select: no identity evidence → unknown, never a guess", () => {
  for (const over of [{ account: null }, { account: "999" }, { userId: USER_B }] as const) {
    const s = selectConnectionAccountSnapshot({ userId: USER_A, connection: conn({ accountSyncedAt: null }), legacy: legacy(over) });
    assert.equal(s.status, "unknown", JSON.stringify(over));
    assert.equal(s.unknownReason, "NO_IDENTITY_EVIDENCE");
    assert.equal(s.balance, null);
  }
  const noLogin = selectConnectionAccountSnapshot({ userId: USER_A, connection: conn({ accountSyncedAt: null, accountNumber: null }), legacy: legacy() });
  assert.equal(noLogin.unknownReason, "NO_IDENTITY_EVIDENCE");
});

test("select: the legacy feed is used only with identity evidence, and says so", () => {
  const s = selectConnectionAccountSnapshot({ userId: USER_A, connection: conn({ accountSyncedAt: null }), legacy: legacy({ equity: 9_999 }) });
  assert.equal(s.status, "observed");
  assert.deepEqual(s.provenance, { feed: "mt5_state", authoritative: false });
  assert.equal(s.identity.connectionId, 7);
  assert.equal(s.equity, 9_999);
});

test("select: no connection, or nothing usable, is unknown", () => {
  assert.equal(selectConnectionAccountSnapshot({ userId: USER_A, connection: null, legacy: legacy() }).unknownReason, "NO_CONNECTION");
  assert.equal(selectConnectionAccountSnapshot({ userId: USER_A, connection: conn({ accountSyncedAt: null }) }).unknownReason, "NEVER_SYNCED");
});
