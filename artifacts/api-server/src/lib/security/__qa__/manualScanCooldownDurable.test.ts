// DURABLE manual-scan cooldown.
//
// Proves the per-user manual Broad Scan cooldown is backed by the DB limiter
// (`security_cooldowns` via `consumeRateLimit("MANUAL_SCAN", …)`), NOT an
// in-memory map — so it survives a server restart and is shared across
// horizontally-scaled instances.
//
// The decisive durability proof: this limiter holds NO module-level state, so a
// block decision is derived entirely from the persisted row. Deleting that row
// (what a fresh window / manual clear leaves) immediately unblocks — something
// an in-memory cooldown could never do. A short test-window override exercises
// the natural window-expiry recovery without sleeping for the real 7s.
//
// Requires a real DATABASE_URL: the limiter writes to `security_cooldowns`. All
// rows here use a synthetic, clearly-test scope prefix and are deleted in a
// `finally`, so the test never touches a real user's cooldown row. If the DB is
// unreachable the MANUAL_SCAN policy fails CLOSED, so the first-allow assertion
// fails loudly rather than passing silently.
//
// Run: node --import tsx --test --test-force-exit \
//   src/lib/security/__qa__/manualScanCooldownDurable.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { and, eq, like } from "drizzle-orm";
import { db, securityCooldownsTable } from "@workspace/db";
import type { RateLimitRule } from "@workspace/domain/security";
import { consumeRateLimit } from "../cooldowns.js";

const TEST_SCOPE_PREFIX = "__qa_manual_scan_durable__";

function uniqueScope(label: string): string {
  return `${TEST_SCOPE_PREFIX}:${label}:${process.pid}:${Math.random().toString(36).slice(2, 10)}`;
}

/** Remove ALL synthetic rows this test could have created — never real ones. */
async function deleteTestRows(): Promise<void> {
  await db
    .delete(securityCooldownsTable)
    .where(
      and(
        eq(securityCooldownsTable.actionKey, "MANUAL_SCAN"),
        like(securityCooldownsTable.scopeKey, `${TEST_SCOPE_PREFIX}:%`),
      ),
    );
}

async function rowFor(scope: string) {
  const [row] = await db
    .select()
    .from(securityCooldownsTable)
    .where(and(eq(securityCooldownsTable.actionKey, "MANUAL_SCAN"), eq(securityCooldownsTable.scopeKey, scope)))
    .limit(1);
  return row ?? null;
}

// A tiny window so the natural-expiry recovery path runs fast (no 7s sleep).
const SHORT_RULE: RateLimitRule = {
  limit: 1,
  windowMs: 150,
  cooldownMs: 150,
  adminVisible: false,
  failOpen: false,
};

test("the default MANUAL_SCAN policy durably blocks the 2nd scan in a window", async () => {
  const scope = uniqueScope("default");
  try {
    const first = await consumeRateLimit("MANUAL_SCAN", scope);
    assert.equal(first.allowed, true, "first scan in a fresh window is allowed");
    assert.equal(first.retryAfterMs, 0, "an allowed scan reports no wait");

    // The decision was PERSISTED: a row now exists for (MANUAL_SCAN, scope).
    // This is the state a restarted / sibling instance would read back.
    const persisted = await rowFor(scope);
    assert.ok(persisted, "the cooldown state is written to security_cooldowns (durable)");

    const second = await consumeRateLimit("MANUAL_SCAN", scope);
    assert.equal(second.allowed, false, "a second scan in the window is blocked from the persisted state");
    assert.ok(second.retryAfterMs > 0, "the block reports a positive retryAfterMs for the countdown");
  } finally {
    await deleteTestRows();
  }
});

test("clearing the persisted row unblocks — proves the cooldown is DB-backed, not in-memory", async () => {
  const scope = uniqueScope("clear");
  try {
    assert.equal((await consumeRateLimit("MANUAL_SCAN", scope)).allowed, true);
    assert.equal((await consumeRateLimit("MANUAL_SCAN", scope)).allowed, false, "blocked while the row persists");

    // Delete ONLY this scope's row (what a fresh window / restart-clean would
    // leave). An in-memory limiter would still block here; the DB-backed one
    // recovers — which is exactly the durability contract under test.
    await db
      .delete(securityCooldownsTable)
      .where(and(eq(securityCooldownsTable.actionKey, "MANUAL_SCAN"), eq(securityCooldownsTable.scopeKey, scope)));

    assert.equal(
      (await consumeRateLimit("MANUAL_SCAN", scope)).allowed,
      true,
      "after the persisted row is cleared the scan is allowed again",
    );
  } finally {
    await deleteTestRows();
  }
});

test("the cooldown recovers naturally once the window elapses", async () => {
  const scope = uniqueScope("expiry");
  try {
    assert.equal((await consumeRateLimit("MANUAL_SCAN", scope, { rule: SHORT_RULE })).allowed, true);
    assert.equal((await consumeRateLimit("MANUAL_SCAN", scope, { rule: SHORT_RULE })).allowed, false);

    await new Promise((r) => setTimeout(r, SHORT_RULE.windowMs + SHORT_RULE.cooldownMs + 50));

    assert.equal(
      (await consumeRateLimit("MANUAL_SCAN", scope, { rule: SHORT_RULE })).allowed,
      true,
      "after the window + cooldown elapse the scan is allowed again",
    );
  } finally {
    await deleteTestRows();
  }
});

test("the durable cooldown is isolated per user (scope)", async () => {
  const userA = uniqueScope("userA");
  const userB = uniqueScope("userB");
  try {
    assert.equal((await consumeRateLimit("MANUAL_SCAN", userA)).allowed, true);
    assert.equal((await consumeRateLimit("MANUAL_SCAN", userA)).allowed, false, "user A is now in cooldown");
    // A different scope (user) is unaffected by user A's cooldown.
    assert.equal((await consumeRateLimit("MANUAL_SCAN", userB)).allowed, true, "user B is not throttled by user A");
  } finally {
    await deleteTestRows();
  }
});
