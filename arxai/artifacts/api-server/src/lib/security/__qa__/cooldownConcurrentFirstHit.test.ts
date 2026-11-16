// CONCURRENT first-hit serialization for the shared DB rate-limiter.
//
// Proves `consumeRateLimit` serializes simultaneous attempts on the SAME
// (action, scope) via the per-(action,scope) `pg_advisory_xact_lock` taken at
// the top of its transaction. Without that lock two (or N) simultaneous FIRST
// attempts could each read no row, each evaluate allowed:true, and each pass
// before any upsert lands — letting N callers through a limit:1 window.
//
// The decisive proof: fire N `consumeRateLimit` calls for ONE fresh scope with
// a limit:1 rule in a single `Promise.all` and assert EXACTLY ONE is allowed.
// A second scope, fired in the same burst, must independently allow exactly one
// of ITS attempts — proving the lock is per-scope and one actor never throttles
// another.
//
// Requires a real DATABASE_URL: the limiter writes to `security_cooldowns`. All
// rows use a synthetic, clearly-test scope prefix and are deleted in a
// `finally`, so the test never touches a real user's cooldown row. The
// FAIL_SHUT (failOpen:false) rule means a DB outage fails the allow assertion
// loudly rather than passing silently.
//
// Run: node --import tsx --test --test-force-exit \
//   src/lib/security/__qa__/cooldownConcurrentFirstHit.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { and, eq, like } from "drizzle-orm";
import { db, securityCooldownsTable } from "@workspace/db";
import type { RateLimitRule } from "@workspace/domain/security";
import { consumeRateLimit } from "../cooldowns.js";

const TEST_SCOPE_PREFIX = "__qa_cooldown_concurrent__";

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

// A single-attempt window. Fail-CLOSED (failOpen:false) so a DB outage surfaces
// as a failed allow assertion, never a silent pass.
const SINGLE_HIT_RULE: RateLimitRule = {
  limit: 1,
  windowMs: 60_000,
  cooldownMs: 60_000,
  adminVisible: false,
  failOpen: false,
};

test("N simultaneous FIRST attempts on one scope let EXACTLY ONE through (limit:1)", async () => {
  const scope = uniqueScope("burst");
  const N = 12;
  try {
    const results = await Promise.all(
      Array.from({ length: N }, () => consumeRateLimit("MANUAL_SCAN", scope, { rule: SINGLE_HIT_RULE })),
    );

    const allowed = results.filter((r) => r.allowed);
    assert.equal(
      allowed.length,
      1,
      `exactly one of ${N} simultaneous first hits is allowed (got ${allowed.length}) — ` +
        "the advisory lock serialized the read+upsert so no two saw an empty window",
    );

    const blocked = results.filter((r) => !r.allowed);
    assert.equal(blocked.length, N - 1, "every other simultaneous attempt is blocked");
    assert.ok(
      blocked.every((r) => r.retryAfterMs > 0),
      "each blocked attempt reports a positive retryAfterMs for the countdown",
    );

    // The persisted row reflects the over-limit attempts (count > limit) — proof
    // the serialized upserts accumulated rather than racing past one another.
    const [row] = await db
      .select()
      .from(securityCooldownsTable)
      .where(and(eq(securityCooldownsTable.actionKey, "MANUAL_SCAN"), eq(securityCooldownsTable.scopeKey, scope)))
      .limit(1);
    assert.ok(row, "the burst persisted a single cooldown row for the scope");
    assert.ok(row.count >= 1, "the persisted count reflects the serialized attempts");
  } finally {
    await deleteTestRows();
  }
});

test("the serialization is PER-scope — a concurrent burst on a second scope is independent", async () => {
  const scopeA = uniqueScope("multiA");
  const scopeB = uniqueScope("multiB");
  const N = 6;
  try {
    // Interleave two scopes' bursts in ONE Promise.all so they run concurrently.
    const calls = [
      ...Array.from({ length: N }, () => ({ scope: scopeA })),
      ...Array.from({ length: N }, () => ({ scope: scopeB })),
    ].map(({ scope }) => consumeRateLimit("MANUAL_SCAN", scope, { rule: SINGLE_HIT_RULE }));
    const results = await Promise.all(calls);

    const allowedA = results.filter((r, i) => i < N && r.allowed);
    const allowedB = results.filter((r, i) => i >= N && r.allowed);
    assert.equal(allowedA.length, 1, "scope A independently allows exactly one of its concurrent first hits");
    assert.equal(allowedB.length, 1, "scope B independently allows exactly one of its concurrent first hits");
  } finally {
    await deleteTestRows();
  }
});
