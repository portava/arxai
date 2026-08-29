// Capability #37 — unified authority grants: pure contract proofs.
//
// Proven here (offline, no DB):
//   * default-deny: no grant → baseline ceiling; expired/revoked grants are
//     simply absent; grantedAt in the future doesn't matter, only expiry.
//   * scope algebra: ACCOUNT covers everything of its kind; a scoped grant
//     covers exactly its (scopeType, scopeRef) and nothing else.
//   * the asymmetry: reductions always allowed, increases above baseline need
//     an active covering grant, corrupt levels clamp to the ladder max.
//   * grant requests: mandatory future expiry, bounded duration and level.
//
// Run: pnpm --filter @workspace/api-server run test:authority-grants

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveAuthorityCeiling,
  checkLevelChange,
  validateGrantRequest,
  isGrantActive,
  AUTHORITY_BASELINES,
  MAX_GRANT_DURATION_MS,
  type AuthorityGrantLike,
} from "@workspace/domain/safety-contracts/authorityGrants";

const NOW = new Date("2026-08-29T12:00:00Z");
const FUTURE = new Date("2026-09-05T12:00:00Z");
const PAST = new Date("2026-08-01T12:00:00Z");

function grant(over: Partial<AuthorityGrantLike>): AuthorityGrantLike {
  return {
    id: 1,
    kind: "MISSION_AUTOMATION_LEVEL",
    scopeType: "ACCOUNT",
    scopeRef: null,
    maxLevel: 4,
    grantedAt: PAST,
    expiresAt: FUTURE,
    revokedAt: null,
    ...over,
  };
}

test("no grants → baseline ceiling, source BASELINE", () => {
  const c = resolveAuthorityCeiling({ kind: "MISSION_AUTOMATION_LEVEL", now: NOW, grants: [] });
  assert.equal(c.ceiling, AUTHORITY_BASELINES.MISSION_AUTOMATION_LEVEL);
  assert.equal(c.source, "BASELINE");
  assert.equal(c.grantId, null);
});

test("an expired grant is absent — automatic expiry needs no press", () => {
  const g = grant({ expiresAt: new Date(NOW.getTime() - 1) });
  assert.equal(isGrantActive(g, NOW), false);
  const c = resolveAuthorityCeiling({ kind: "MISSION_AUTOMATION_LEVEL", now: NOW, grants: [g] });
  assert.equal(c.ceiling, 2);
  assert.equal(c.source, "BASELINE");
});

test("a revoked grant is absent instantly", () => {
  const g = grant({ revokedAt: NOW });
  const c = resolveAuthorityCeiling({ kind: "MISSION_AUTOMATION_LEVEL", now: NOW, grants: [g] });
  assert.equal(c.source, "BASELINE");
});

test("ACCOUNT grant covers a MISSION-scoped query of the same kind", () => {
  const c = resolveAuthorityCeiling({
    kind: "MISSION_AUTOMATION_LEVEL", scopeType: "MISSION", scopeRef: "77",
    now: NOW, grants: [grant({ maxLevel: 3 })],
  });
  assert.equal(c.ceiling, 3);
  assert.equal(c.source, "GRANT");
  assert.deepEqual(c.expiresAt, FUTURE);
});

test("MISSION-scoped grant covers only its exact mission", () => {
  const g = grant({ scopeType: "MISSION", scopeRef: "77", maxLevel: 5 });
  const hit = resolveAuthorityCeiling({ kind: "MISSION_AUTOMATION_LEVEL", scopeType: "MISSION", scopeRef: "77", now: NOW, grants: [g] });
  assert.equal(hit.ceiling, 5);
  const miss = resolveAuthorityCeiling({ kind: "MISSION_AUTOMATION_LEVEL", scopeType: "MISSION", scopeRef: "78", now: NOW, grants: [g] });
  assert.equal(miss.source, "BASELINE");
  // A scoped grant also never leaks into an account-wide query.
  const acct = resolveAuthorityCeiling({ kind: "MISSION_AUTOMATION_LEVEL", now: NOW, grants: [g] });
  assert.equal(acct.source, "BASELINE");
});

test("kind mismatch never matches", () => {
  const g = grant({ kind: "AGENT_AUTONOMY_LEVEL", maxLevel: 3 });
  const c = resolveAuthorityCeiling({ kind: "MISSION_AUTOMATION_LEVEL", now: NOW, grants: [g] });
  assert.equal(c.source, "BASELINE");
});

test("a corrupt over-max grant clamps to the ladder max, never above", () => {
  const c = resolveAuthorityCeiling({ kind: "AGENT_AUTONOMY_LEVEL", now: NOW, grants: [grant({ kind: "AGENT_AUTONOMY_LEVEL", maxLevel: 99 })] });
  assert.equal(c.ceiling, 4);
});

test("asymmetry: reductions always allowed, increases need coverage", () => {
  const baseline = resolveAuthorityCeiling({ kind: "MISSION_AUTOMATION_LEVEL", now: NOW, grants: [] });
  assert.equal(checkLevelChange({ currentLevel: 5, targetLevel: 2, ceiling: baseline }).allowed, true);
  assert.equal(checkLevelChange({ currentLevel: 5, targetLevel: 0, ceiling: baseline }).reason, "REDUCTION_ALWAYS_ALLOWED");
  assert.equal(checkLevelChange({ currentLevel: 1, targetLevel: 2, ceiling: baseline }).reason, "WITHIN_BASELINE");
  const refused = checkLevelChange({ currentLevel: 2, targetLevel: 3, ceiling: baseline });
  assert.equal(refused.allowed, false);
  assert.equal(refused.reason, "AUTHORITY_GRANT_REQUIRED");

  const granted = resolveAuthorityCeiling({ kind: "MISSION_AUTOMATION_LEVEL", now: NOW, grants: [grant({ maxLevel: 4 })] });
  assert.equal(checkLevelChange({ currentLevel: 2, targetLevel: 4, ceiling: granted }).allowed, true);
  assert.equal(checkLevelChange({ currentLevel: 2, targetLevel: 5, ceiling: granted }).allowed, false);
});

test("grant requests: expiry is mandatory, future, and bounded", () => {
  const base = { kind: "MISSION_AUTOMATION_LEVEL", scopeType: "ACCOUNT", scopeRef: null, maxLevel: 3, now: NOW };
  assert.equal(validateGrantRequest({ ...base, expiresAt: FUTURE }).ok, true);
  assert.equal((validateGrantRequest({ ...base, expiresAt: null }) as { reason: string }).reason, "EXPIRY_REQUIRED");
  assert.equal((validateGrantRequest({ ...base, expiresAt: PAST }) as { reason: string }).reason, "EXPIRY_IN_PAST");
  assert.equal(
    (validateGrantRequest({ ...base, expiresAt: new Date(NOW.getTime() + MAX_GRANT_DURATION_MS + 1) }) as { reason: string }).reason,
    "EXPIRY_TOO_FAR",
  );
  assert.equal((validateGrantRequest({ ...base, maxLevel: 2, expiresAt: FUTURE }) as { reason: string }).reason, "INVALID_LEVEL");
  assert.equal((validateGrantRequest({ ...base, maxLevel: 7, expiresAt: FUTURE }) as { reason: string }).reason, "INVALID_LEVEL");
  assert.equal(
    (validateGrantRequest({ ...base, scopeType: "MISSION", expiresAt: FUTURE }) as { reason: string }).reason,
    "SCOPE_REF_REQUIRED",
  );
  assert.equal((validateGrantRequest({ ...base, kind: "NOT_A_KIND", expiresAt: FUTURE }) as { reason: string }).reason, "INVALID_KIND");
});
