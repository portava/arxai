// Unit tests for the live open-position freshness/visibility classifier. Run via:
//   node --import tsx --test src/lib/live/__qa__/positionFreshness.test.ts
// (wired as `pnpm --filter @workspace/api-server run test:position-freshness`)
//
// SAFETY INVARIANT under test: a stale `lastSyncedAt` on its own NEVER hides a
// real open position. A stale/missing row is broker-confirmed-absent (hideable)
// ONLY when we ALSO have a reliable recent COMPLETE snapshot — which is now the
// per-bridge `last_positions_snapshot_at` marker (stamped on EVERY ingest,
// including an empty/flat book), NOT the newest row timestamp. This keeps real
// synthetic-index (V75/V25) positions visible while an EA snapshot is merely
// lagging, while still letting a genuinely flat broker clear closed rows.

import { test } from "node:test";
import assert from "node:assert/strict";
import { isSnapshotReliable, classifyRow } from "../positionFreshness.js";

const NOW = 1_000_000_000_000;
const WINDOW = 90_000;

test("isSnapshotReliable: recent marker => reliable; stale/missing => not", () => {
  assert.equal(isSnapshotReliable(NOW - 1_000, WINDOW, NOW), true);
  assert.equal(isSnapshotReliable(NOW - WINDOW, WINDOW, NOW), true); // exactly at edge
  assert.equal(isSnapshotReliable(NOW - WINDOW - 1, WINDOW, NOW), false);
  assert.equal(isSnapshotReliable(null, WINDOW, NOW), false);
});

test("fresh row is always broker-confirmed and never absent", () => {
  const cls = classifyRow(NOW - 5_000, { windowMs: WINDOW, now: NOW, snapshotReliable: true });
  assert.equal(cls.freshness, "FRESH");
  assert.equal(cls.confirmation, "BROKER_CONFIRMED");
  assert.equal(cls.brokerConfirmedAbsent, false);
});

test("FLAT-BROKER: empty snapshot marker is fresh => stale row is broker-confirmed-absent (hidden)", () => {
  // Broker went flat: EA pushed an empty list, marker is fresh, but this row's
  // own lastSyncedAt has aged past the window (never re-stamped). It is genuinely
  // gone and must be hidden — the regression this fix closes.
  const cls = classifyRow(NOW - WINDOW - 10_000, { windowMs: WINDOW, now: NOW, snapshotReliable: true });
  assert.equal(cls.freshness, "STALE");
  assert.equal(cls.brokerConfirmedAbsent, true);
});

test("DELAYED/OFFLINE: marker stale => stale row STAYS VISIBLE pending confirmation", () => {
  // No reliable recent sweep. A real V75 position whose row aged out must NOT be
  // hidden — keep it visible and flag confirmation pending.
  const cls = classifyRow(NOW - WINDOW - 10_000, { windowMs: WINDOW, now: NOW, snapshotReliable: false });
  assert.equal(cls.freshness, "STALE");
  assert.equal(cls.confirmation, "BROKER_CONFIRMATION_PENDING");
  assert.equal(cls.brokerConfirmedAbsent, false);
});

test("MISSING row (never synced) is only absent under a reliable snapshot", () => {
  const reliable = classifyRow(null, { windowMs: WINDOW, now: NOW, snapshotReliable: true });
  assert.equal(reliable.freshness, "MISSING");
  assert.equal(reliable.brokerConfirmedAbsent, true);

  const unreliable = classifyRow(null, { windowMs: WINDOW, now: NOW, snapshotReliable: false });
  assert.equal(unreliable.freshness, "MISSING");
  assert.equal(unreliable.brokerConfirmedAbsent, false);
});
