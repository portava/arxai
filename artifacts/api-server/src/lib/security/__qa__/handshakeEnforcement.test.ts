// ═══════════════════════════════════════════════════════════════════════════
// handshakeEnforcement.test.ts — action-level enforcement + no-bypass proof for
// the server `enforceSensitiveAction` wrapper (AACI Security Phase 2).
//
// This exercises the REAL server enforcement decision (consult → domain verdict
// → ok/blocked) over the WHOLE SENSITIVE_ACTIONS catalog. It proves:
//   1. DEFAULT-DENY — every sensitive action BLOCKs an unauthenticated caller.
//   2. BROKEN-ACCESS-CONTROL — admin-only actions BLOCK a merely-authenticated
//      (non-privileged) user.
//   3. ROLE GATE — a privileged caller is never BLOCKed by the identity/role
//      class (posture degradations downgrade to ALERT_ADMIN, never BLOCK).
//   4. NON-ADMIN actions never BLOCK an authenticated user (so a user can always
//      reduce live risk / reset a password).
//   5. NO-BYPASS invariant — `ok` is true IFF the recommendation is not BLOCK,
//      every BLOCK carries a SECURITY_HANDSHAKE_FAILED reasonCode, and a blocked
//      user message never leaks a token, code, or action key.
//
// Requires the dev DB to be reachable (consult reads security settings + score);
// the same prerequisite as the other api-server __qa__ suites.
// ═══════════════════════════════════════════════════════════════════════════

import { test } from "node:test";
import assert from "node:assert/strict";
import { SENSITIVE_ACTION_KEYS, SENSITIVE_ACTIONS } from "@workspace/domain/security";
import { enforceSensitiveAction, type SensitiveActionEnforcement } from "../handshake.js";

const CLEAN_USER_MESSAGE = "Security check failed. This action cannot continue right now.";

// The user-facing copy must never name a check, an internal UPPER_SNAKE code, or
// the reasonCode (which carries a ":" separator).
function assertNoLeak(res: SensitiveActionEnforcement, action: string): void {
  assert.equal(res.userMessage, CLEAN_USER_MESSAGE, `${action}: blocked user message must be the constant clean copy`);
  assert.ok(!res.userMessage.includes(":"), `${action}: user message must not contain a reasonCode separator`);
  assert.ok(!res.userMessage.includes("_"), `${action}: user message must not contain an UPPER_SNAKE token`);
  assert.ok(!res.userMessage.includes(action), `${action}: user message must not name the action`);
  assert.ok(!res.userMessage.toUpperCase().includes("SECURITY_HANDSHAKE"), `${action}: user message must not leak the internal code`);
}

// The single inviolable invariant: ok is true exactly when the recommendation is
// not BLOCK, and a BLOCK always fails closed with the canonical reason prefix.
function assertNoBypass(res: SensitiveActionEnforcement, action: string): void {
  assert.equal(res.ok, res.recommendedAction !== "BLOCK", `${action}: ok must track (recommendedAction !== BLOCK)`);
  if (res.recommendedAction === "BLOCK") {
    assert.equal(res.ok, false, `${action}: a BLOCK must never be ok`);
    assert.equal(res.blocked, true, `${action}: a BLOCK must be flagged blocked`);
    assert.ok(
      res.reasonCode.startsWith("SECURITY_HANDSHAKE_FAILED"),
      `${action}: a BLOCK must carry a SECURITY_HANDSHAKE_FAILED reasonCode (got ${res.reasonCode})`,
    );
    assertNoLeak(res, action);
  }
}

test("default-deny: every sensitive action BLOCKs an unauthenticated caller", async () => {
  for (const action of SENSITIVE_ACTION_KEYS) {
    const res = await enforceSensitiveAction(action, { userId: null, authenticated: false });
    assert.equal(res.ok, false, `${action}: unauthenticated caller must be refused`);
    assert.equal(res.recommendedAction, "BLOCK", `${action}: unauthenticated caller must BLOCK`);
    assertNoBypass(res, action);
  }
});

test("broken-access-control: admin-only actions BLOCK a non-privileged user", async () => {
  for (const action of SENSITIVE_ACTION_KEYS) {
    if (!SENSITIVE_ACTIONS[action].adminOnly) continue;
    const res = await enforceSensitiveAction(action, { userId: 999_001, role: "USER", authenticated: true });
    assert.equal(res.ok, false, `${action}: a non-privileged user must not pass an admin-only handshake`);
    assert.equal(res.recommendedAction, "BLOCK", `${action}: admin-only + non-privileged must BLOCK`);
    assertNoBypass(res, action);
  }
});

test("role gate: a privileged caller is never BLOCKed (posture only downgrades)", async () => {
  for (const action of SENSITIVE_ACTION_KEYS) {
    if (!SENSITIVE_ACTIONS[action].adminOnly) continue;
    const res = await enforceSensitiveAction(action, {
      userId: 999_002, role: "ADMIN", authenticated: true, adminSurfaceOk: true,
    });
    assert.notEqual(res.recommendedAction, "BLOCK", `${action}: a privileged admin must never hit the BLOCK class`);
    assert.equal(res.ok, true, `${action}: a privileged admin must proceed (ALERT_ADMIN still proceeds)`);
    assertNoBypass(res, action);
  }
});

test("non-admin actions never BLOCK an authenticated user", async () => {
  for (const action of SENSITIVE_ACTION_KEYS) {
    if (SENSITIVE_ACTIONS[action].adminOnly) continue;
    const res = await enforceSensitiveAction(action, { userId: 1, role: "USER", authenticated: true });
    assert.notEqual(res.recommendedAction, "BLOCK", `${action}: an authenticated user must never be BLOCKed on a non-admin action`);
    assert.equal(res.ok, true, `${action}: an authenticated user must proceed on a non-admin action`);
    assertNoBypass(res, action);
  }
});
