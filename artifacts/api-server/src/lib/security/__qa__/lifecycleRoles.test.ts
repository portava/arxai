// Capability #51 — separation of duties: lifecycle roles + enforcement gate.
//
// Pins, offline (pure domain + middleware with an injected grant loader —
// no HTTP socket, no DB):
//   1. The six roles exist, distinctly, and the conflict matrix refuses every
//      collapsing combination: author⟂validator, author⟂risk-approver,
//      deployer⟂author/validator/risk-approver, auditor⟂everything.
//   2. Compatible combinations still grant (validator+risk-approver,
//      account-admin+anything-but-auditor).
//   3. Default-deny: unknown role names never grant and never satisfy a
//      requirement; double-grant refuses as ALREADY_GRANTED.
//   4. Middleware: NOT_HELD → 403 once SoD is configured (ADMIN included);
//      HELD → next(); SOD_NOT_CONFIGURED → loud pass-through; loader failure
//      → 403 fail-closed; anonymous → 401.
//   5. Route wiring pins: learning-version APPROVE requires DEPLOYER
//      (rollback deliberately NOT gated — risk-reducing), risk-template
//      mutations require RISK_APPROVER, and the grant route consults the
//      pure evaluator.
//
// Run: node --import tsx --test src/lib/security/__qa__/lifecycleRoles.test.ts

process.env["DATABASE_URL"] ??= "postgres://user:pass@127.0.0.1:1/nonexistent";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const {
  LIFECYCLE_ROLES,
  CONFLICTING_ROLE_PAIRS,
  evaluateLifecycleRoleGrant,
  evaluateLifecycleRequirement,
  lifecycleRoleKey,
} = (await import("@workspace/domain")).security;
const { requireLifecycleRole } = await import("../lifecycleRoleGate.js");

// ── 1+2+3. Pure grant evaluation ────────────────────────────────────────────

test("the six lifecycle roles are distinct and exactly the spec's six", () => {
  assert.deepEqual([...LIFECYCLE_ROLES].sort(), [
    "ACCOUNT_ADMIN", "AUDITOR", "DEPLOYER",
    "RISK_APPROVER", "STRATEGY_AUTHOR", "STRATEGY_VALIDATOR",
  ]);
  assert.equal(new Set(LIFECYCLE_ROLES).size, 6);
  assert.equal(lifecycleRoleKey("AUDITOR"), "LIFECYCLE_AUDITOR");
});

test("every conflicting combination refuses, in both grant directions", () => {
  for (const [a, b] of CONFLICTING_ROLE_PAIRS) {
    const d1 = evaluateLifecycleRoleGrant([a], b);
    assert.equal(d1.allowed, false, `${a} held, ${b} requested must refuse`);
    assert.ok(d1.reasons.includes("CONFLICTING_ROLE_HELD"));
    assert.deepEqual(d1.conflictsWith, [a]);
    const d2 = evaluateLifecycleRoleGrant([b], a);
    assert.equal(d2.allowed, false, `${b} held, ${a} requested must refuse`);
  }
});

test("the auditor is absolutely independent: conflicts with all five others", () => {
  for (const other of LIFECYCLE_ROLES) {
    if (other === "AUDITOR") continue;
    assert.equal(evaluateLifecycleRoleGrant(["AUDITOR"], other).allowed, false);
    assert.equal(evaluateLifecycleRoleGrant([other], "AUDITOR").allowed, false);
  }
});

test("compatible combinations still grant", () => {
  assert.equal(evaluateLifecycleRoleGrant(["STRATEGY_VALIDATOR"], "RISK_APPROVER").allowed, true);
  assert.equal(evaluateLifecycleRoleGrant(["ACCOUNT_ADMIN"], "DEPLOYER").allowed, true);
  assert.equal(evaluateLifecycleRoleGrant(["ACCOUNT_ADMIN"], "STRATEGY_AUTHOR").allowed, true);
  assert.equal(evaluateLifecycleRoleGrant([], "AUDITOR").allowed, true);
});

test("default-deny: unknown roles never grant; double-grant refuses", () => {
  const unknown = evaluateLifecycleRoleGrant([], "SUPER_ADMIN");
  assert.equal(unknown.allowed, false);
  assert.deepEqual(unknown.reasons, ["ROLE_UNKNOWN"]);

  const dup = evaluateLifecycleRoleGrant(["DEPLOYER"], "DEPLOYER");
  assert.equal(dup.allowed, false);
  assert.ok(dup.reasons.includes("ALREADY_GRANTED"));

  const held = evaluateLifecycleRoleGrant(["MYSTERY_ROLE"], "DEPLOYER");
  assert.equal(held.allowed, true, "an unknown HELD value cannot block (it grants nothing either)");
  assert.deepEqual(held.unknownHeldRoles, ["MYSTERY_ROLE"], "…but it is reported");
});

test("requirement verdicts: HELD / NOT_HELD / SOD_NOT_CONFIGURED / ROLE_UNKNOWN", () => {
  assert.equal(evaluateLifecycleRequirement({
    requiredRole: "DEPLOYER", heldRoles: ["DEPLOYER"], anyGrantsExistSystemWide: true,
  }), "HELD");
  assert.equal(evaluateLifecycleRequirement({
    requiredRole: "DEPLOYER", heldRoles: [], anyGrantsExistSystemWide: true,
  }), "NOT_HELD");
  assert.equal(evaluateLifecycleRequirement({
    requiredRole: "DEPLOYER", heldRoles: [], anyGrantsExistSystemWide: false,
  }), "SOD_NOT_CONFIGURED");
  assert.equal(evaluateLifecycleRequirement({
    requiredRole: "GOD_MODE", heldRoles: ["GOD_MODE"], anyGrantsExistSystemWide: true,
  }), "ROLE_UNKNOWN", "an unknown requirement never passes, even if 'held'");
});

// ── 4. Middleware behavior (injected loader, no HTTP socket) ───────────────

async function runGate(args: {
  userId: number | null;
  held: string[];
  configured: boolean;
  fail?: boolean;
}): Promise<{ status: number | null; nexted: boolean; body: unknown }> {
  let nexted = false;
  const res = {
    statusCode: null as number | null,
    body: null as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
  const req = {
    path: "/qa",
    ...(args.userId != null ? { authUser: { id: args.userId, role: "ADMIN" } } : {}),
  };
  const mw = requireLifecycleRole("DEPLOYER", async () => {
    if (args.fail) throw new Error("qa: loader down");
    return { heldRoles: args.held, anyGrantsExistSystemWide: args.configured };
  });
  await mw(req as never, res as never, () => { nexted = true; });
  return { status: res.statusCode, nexted, body: res.body };
}

test("middleware: NOT_HELD → 403 once SoD is configured (an ADMIN is refused too)", async () => {
  const r = await runGate({ userId: 7, held: [], configured: true });
  assert.equal(r.status, 403);
  assert.equal(r.nexted, false);
  assert.equal((r.body as { error: string }).error, "LIFECYCLE_ROLE_REQUIRED");
});

test("middleware: HELD → next()", async () => {
  const r = await runGate({ userId: 7, held: ["DEPLOYER"], configured: true });
  assert.equal(r.status, null);
  assert.equal(r.nexted, true);
});

test("middleware: SOD_NOT_CONFIGURED → pass-through (loud, logged)", async () => {
  const r = await runGate({ userId: 7, held: [], configured: false });
  assert.equal(r.nexted, true);
});

test("middleware: loader failure → 403 fail-closed", async () => {
  const r = await runGate({ userId: 7, held: ["DEPLOYER"], configured: true, fail: true });
  assert.equal(r.status, 403);
  assert.equal(r.nexted, false);
  assert.equal((r.body as { error: string }).error, "LIFECYCLE_ROLE_READ_FAILED");
});

test("middleware: anonymous → 401", async () => {
  const r = await runGate({ userId: null, held: [], configured: true });
  assert.equal(r.status, 401);
  assert.equal(r.nexted, false);
});

// ── 5. Route wiring pins ───────────────────────────────────────────────────

test("route wiring: approve→DEPLOYER (rollback ungated on purpose), risk templates→RISK_APPROVER", () => {
  const learning = readFileSync(
    fileURLToPath(new URL("../../../routes/adminLearningVersions.ts", import.meta.url)),
    "utf8",
  );
  assert.ok(
    /versions\/:id\/approve",\s*requireUser,\s*requireLifecycleRole\("DEPLOYER"\)/.test(learning),
    "live approval must require the DEPLOYER lifecycle role",
  );
  assert.ok(
    !/versions\/:id\/rollback",[^)]*requireLifecycleRole/.test(learning),
    "rollback stays ungated (risk-reducing must never be trapped)",
  );

  const risk = readFileSync(
    fileURLToPath(new URL("../../../routes/adminRiskTemplates.ts", import.meta.url)),
    "utf8",
  );
  assert.equal(
    (risk.match(/requireLifecycleRole\("RISK_APPROVER"\)/g) ?? []).length,
    3,
    "create/update/archive risk-template mutations all require RISK_APPROVER",
  );

  const grants = readFileSync(
    fileURLToPath(new URL("../../../routes/adminLifecycleRoles.ts", import.meta.url)),
    "utf8",
  );
  assert.ok(grants.includes("evaluateLifecycleRoleGrant"),
    "the grant route consults the pure conflict evaluator");
  assert.ok(grants.includes("LIFECYCLE_GRANT_REFUSED"),
    "conflicting grants are refused with a typed 409");
});
