// Bridge v2 admin status — the lock text and the heartbeat age agree with the
// shared heartbeat vocabulary (fresh < 15 s, degraded < 60 s, offline beyond).
// Run via:
//   node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//     src/lib/bridgeV2/__qa__/adminStatusHeartbeatAgreement.test.ts
//
// The stream rows, the latest HEARTBEAT event, the config manifest and the
// command list are stubbed; nothing touches a database or a broker.

import { mock, test } from "node:test";
import assert from "node:assert/strict";

const NOW = Date.parse("2026-10-28T12:00:00.000Z");
let heartbeatAgeMs: number | null = 90_000;

const realStreams = await import("../../brokerHub/bridgeV2StreamState.js");
mock.module("../../brokerHub/bridgeV2StreamState.js", {
  namedExports: {
    ...realStreams,
    listBridgeV2StreamStates: async () => [{
      userId: 5, bridgeConnectionId: 9, messageType: "HEARTBEAT", streamKey: "hb",
      lastSequence: 10, lastEventAt: heartbeatAgeMs == null ? null : new Date(NOW - heartbeatAgeMs),
      totalAccepted: 10, totalDuplicates: 0, totalGaps: 0, totalMissed: 0, totalRejected: 0, totalResets: 0,
    }],
  },
});
const realEgress = await import("../egress.js");
mock.module("../egress.js", {
  namedExports: {
    ...realEgress,
    loadBridgeV2ConfigForEa: async () => ({ executionAllowed: false, configVersion: 1, lastAckedVersion: 1 }),
    listBridgeV2CommandsForEa: async () => [],
  },
});
const realDb = await import("@workspace/db");
function rowsFor(messageType: unknown) {
  if (messageType !== "HEARTBEAT" || heartbeatAgeMs == null) return [];
  return [{ payload: { accountType: "demo" }, eaVersion: "2.0", createdAt: new Date(NOW - heartbeatAgeMs) }];
}
let lastMessageType: unknown = null;
const fakeDb = {
  select: () => ({
    from: () => ({
      where: (cond: unknown) => {
        // The query's message type is the only thing the stub needs; the
        // chain is consumed once per latestAcceptedEvent call.
        void cond;
        return { orderBy: () => ({ limit: async () => rowsFor(lastMessageType) }) };
      },
    }),
  }),
};
mock.module("@workspace/db", { namedExports: { ...realDb, db: fakeDb } });
const drizzle = await import("drizzle-orm");
mock.module("drizzle-orm", {
  namedExports: {
    ...drizzle,
    eq: (col: unknown, val: unknown) => {
      if (typeof val === "string" && /^[A-Z_]+$/.test(val)) lastMessageType = val;
      return drizzle.eq(col as never, val as never);
    },
  },
});

const { buildBridgeV2AdminStatus } = await import("../status.js");

async function statusAt(ageMs: number | null) {
  heartbeatAgeMs = ageMs;
  const real = Date.now;
  Date.now = () => NOW;
  try {
    const [b] = await buildBridgeV2AdminStatus(5);
    return b!;
  } finally {
    Date.now = real;
  }
}

test("90 s old heartbeat: lock text and heartbeat freshness both say offline", async () => {
  const b = await statusAt(90_000);
  assert.equal(b.heartbeatFreshness, "offline");
  assert.equal(b.streamHealth, "STALE", "the separately named stream band is unchanged");
  assert.equal(b.safetyLockReason, "Bridge offline — last heartbeat 90s ago (offline from 60 s)");
});

test("30 s old heartbeat: delayed, not called offline", async () => {
  const b = await statusAt(30_000);
  assert.equal(b.heartbeatFreshness, "degraded");
  assert.doesNotMatch(b.safetyLockReason ?? "", /^Bridge offline/);
  assert.equal(b.safetyLockReason, "Heartbeat delayed — last one 30s ago (fresh below 15 s, offline from 60 s)");
});

test("14.6 s old heartbeat: the shown age is not rounded up past the fresh bound", async () => {
  const b = await statusAt(14_600);
  assert.equal(b.heartbeatFreshness, "fresh");
  assert.equal(b.heartbeatAgeSeconds, 14);
  assert.doesNotMatch(b.safetyLockReason ?? "", /heartbeat/i);
});

test("no heartbeat event: the lock text says none was received", async () => {
  const b = await statusAt(null);
  assert.equal(b.heartbeatFreshness, "unknown");
  assert.equal(b.safetyLockReason, "No heartbeat received from this bridge");
});
