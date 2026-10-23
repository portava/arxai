// AACI Security Handshake (Task #238, Phase 2) — PURE domain unit tests.
//
// Verifies the honesty + safety contracts of the security handshake evaluator
// and the Security-Score-band → autonomy mapper, plus the HARD_GATE wiring:
//  1. Default-deny: every required check that is `false` OR `undefined`
//     (unevaluable) fails the handshake — an empty input never passes.
//  2. A fully-good input passes; a passing handshake never enables anything
//     (it only ever ADDS a block; the verdict is advisory-additive).
//  3. BLOCK vs ALERT_ADMIN classification: an identity/permission failure is a
//     BLOCK; a system-posture failure (redaction/audit/lockdown) is ALERT_ADMIN.
//  4. Admin-only actions additionally require a valid admin surface.
//  5. HARD_GATE ordering: SECURITY_HANDSHAKE_FAILED is surfaced FIRST and a
//     false handshake fails the gate closed (value 0) — no bypass.
//  6. Autonomy bands are strictly monotonic: a worse band is never more
//     permissive; Lockdown defers entirely with size 0.
//  7. No internal UPPER_SNAKE token / secret leaks into any user-facing string.
//
// Pure & deterministic. No DB, no IO.
//
// Run: pnpm --filter @workspace/scripts run test:security-handshake

import {
  evaluateSecurityHandshake,
  resolveSecurityAutonomyEffect,
  isSensitiveAction,
  SENSITIVE_ACTION_KEYS,
  SENSITIVE_ACTIONS,
  SECURITY_BANDS,
  type SecurityBand,
  type SecurityHandshakeCheckInput,
  type SensitiveAction,
} from "@workspace/domain/security";
import {
  buildAaciHardGateFactors,
  evaluateAaciHardGate,
} from "@workspace/domain/aaci";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    console.error(`  FAIL  ${name}`);
    failures++;
  }
}

// User-facing strings must never contain an internal UPPER_SNAKE token.
const TOKEN_RE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/;
function assertNoTokens(label: string, s: string) {
  check(`${label}: no internal token in "${s.slice(0, 60)}…"`, !TOKEN_RE.test(s));
}

// A fully-verified-good input for a NON-admin action.
const ALL_GOOD: SecurityHandshakeCheckInput = {
  authenticated: true,
  roleAuthorized: true,
  actionPermissioned: true,
  secretsNotExposed: true,
  auditAvailable: true,
  adminSurfaceOk: true,
  encryptionConfigHealthy: true,
  lockdownActive: false,
  securityBand: "Healthy",
};

// ── 1. Default-deny ─────────────────────────────────────────────────────────
{
  const empty = evaluateSecurityHandshake("LIVE_TRADE_EXECUTION", {});
  check("default-deny: empty input fails", empty.pass === false);
  check("default-deny: empty securityHandshakePass=false", empty.securityHandshakePass === false);
  check(
    "default-deny: reason prefixed SECURITY_HANDSHAKE_FAILED",
    empty.reasonCode.startsWith("SECURITY_HANDSHAKE_FAILED"),
  );
  assertNoTokens("default-deny userMessage", empty.userMessage);

  // Each required check, individually unknown, must fail closed.
  const requiredKeys: (keyof SecurityHandshakeCheckInput)[] = [
    "authenticated",
    "roleAuthorized",
    "actionPermissioned",
    "secretsNotExposed",
    "auditAvailable",
    "encryptionConfigHealthy",
  ];
  for (const key of requiredKeys) {
    const input = { ...ALL_GOOD };
    delete input[key];
    const v = evaluateSecurityHandshake("LIVE_TRADE_EXECUTION", input);
    check(`default-deny: missing ${key} fails closed`, v.pass === false);
  }

  // Unknown lockdown state cannot prove "no lockdown" → fail closed.
  const noLock = { ...ALL_GOOD };
  delete noLock.lockdownActive;
  check(
    "default-deny: unknown lockdown fails closed",
    evaluateSecurityHandshake("LIVE_TRADE_EXECUTION", noLock).pass === false,
  );
}

// ── 2. All-good passes; advisory-additive ───────────────────────────────────
{
  const ok = evaluateSecurityHandshake("LIVE_TRADE_EXECUTION", ALL_GOOD);
  check("all-good: passes", ok.pass === true);
  check("all-good: recommendedAction ALLOW", ok.recommendedAction === "ALLOW");
  check("all-good: no failed checks", ok.failedChecks.length === 0);
  check("all-good: reasonCode OK", ok.reasonCode === "SECURITY_HANDSHAKE_OK");
  assertNoTokens("all-good userMessage", ok.userMessage);

  // The optional session/device-trust signal is NEVER required.
  const noDeviceTrust = { ...ALL_GOOD, sessionDeviceTrust: undefined };
  check("all-good: missing optional device trust still passes", evaluateSecurityHandshake("CLOSE_POSITION", noDeviceTrust).pass === true);
}

// ── 3. BLOCK vs ALERT_ADMIN classification ──────────────────────────────────
{
  const permFail = evaluateSecurityHandshake("LIVE_TRADE_EXECUTION", { ...ALL_GOOD, actionPermissioned: false });
  check("class: permission fail → BLOCK", permFail.recommendedAction === "BLOCK");

  const redactionFail = evaluateSecurityHandshake("LIVE_TRADE_EXECUTION", { ...ALL_GOOD, secretsNotExposed: false });
  check("class: redaction fail → ALERT_ADMIN", redactionFail.recommendedAction === "ALERT_ADMIN");

  const lockdownFail = evaluateSecurityHandshake("LIVE_TRADE_EXECUTION", { ...ALL_GOOD, lockdownActive: true });
  check("class: active lockdown fails", lockdownFail.pass === false);
  check("class: active lockdown → ALERT_ADMIN", lockdownFail.recommendedAction === "ALERT_ADMIN");

  // adminMessage names check keys only — no secret values, but a token is OK in
  // the ADMIN-facing message; only the USER message must be token-free.
  assertNoTokens("class permFail userMessage", permFail.userMessage);
}

// ── 4. Admin-only actions require an admin surface ───────────────────────────
{
  const adminAction: SensitiveAction = "DISABLE_KILL_SWITCH";
  check("admin: catalog marks DISABLE_KILL_SWITCH adminOnly", SENSITIVE_ACTIONS[adminAction].adminOnly === true);

  const noSurface = { ...ALL_GOOD, adminSurfaceOk: undefined };
  check("admin: missing admin surface fails closed", evaluateSecurityHandshake(adminAction, noSurface).pass === false);

  const badSurface = { ...ALL_GOOD, adminSurfaceOk: false };
  check("admin: wrong surface fails", evaluateSecurityHandshake(adminAction, badSurface).pass === false);

  const goodSurface = { ...ALL_GOOD, adminSurfaceOk: true };
  check("admin: valid admin surface passes", evaluateSecurityHandshake(adminAction, goodSurface).pass === true);

  // A NON-admin action does NOT require an admin surface.
  const nonAdminNoSurface = { ...ALL_GOOD, adminSurfaceOk: undefined };
  check("admin: non-admin action ignores admin surface", evaluateSecurityHandshake("MODIFY_SL_TP", nonAdminNoSurface).pass === true);
}

// ── 5. HARD_GATE wiring — fail closed, surfaced first, no bypass ─────────────
{
  // A handshake FAIL feeds securityHandshakePass=false into the hard gate.
  const fail = buildAaciHardGateFactors({
    securityHandshakePass: false,
    permission: true,
    funded: true,
    active: true,
    autonomyAllowed: true,
    riskPass: true,
    lossLimitPass: true,
    bridgeReady: true,
    feedFresh: true,
    symbolTradable: true,
    allocationAvailable: true,
    executionRouteReady: true,
    auditReady: true,
  });
  const gate = evaluateAaciHardGate(fail);
  check("hardgate: false handshake fails the gate", gate.pass === false);
  check("hardgate: false handshake value=0 (no bypass)", gate.value === 0);
  check(
    "hardgate: SECURITY_HANDSHAKE_FAILED surfaced first",
    gate.failures[0]?.code === "SECURITY_HANDSHAKE_FAILED",
  );
  check(
    "hardgate: only the handshake factor failed",
    gate.failures.length === 1 && gate.failures[0]?.code === "SECURITY_HANDSHAKE_FAILED",
  );
  gate.failures.forEach((f) => assertNoTokens("hardgate userMessage", f.userMessage));

  // A passing handshake must NOT flip any other false factor to true.
  const otherFalse = buildAaciHardGateFactors({
    securityHandshakePass: true,
    permission: true,
    funded: true,
    active: true,
    autonomyAllowed: true,
    riskPass: false, // genuine risk block
    lossLimitPass: true,
    bridgeReady: true,
    feedFresh: true,
    symbolTradable: true,
    allocationAvailable: true,
    executionRouteReady: true,
    auditReady: true,
  });
  const gate2 = evaluateAaciHardGate(otherFalse);
  check("hardgate: pass handshake never rescues another false factor", gate2.pass === false);
  check(
    "hardgate: the risk block still surfaces",
    gate2.failures.some((f) => f.code === "RISK_GOVERNOR_BLOCK"),
  );
}

// ── 6. Autonomy bands strictly monotonic ────────────────────────────────────
{
  const effects = SECURITY_BANDS.map((b) => resolveSecurityAutonomyEffect(b as SecurityBand));
  effects.forEach((e) => {
    check(`autonomy ${e.band}: size in [0,1]`, e.sizeMultiplier >= 0 && e.sizeMultiplier <= 1);
    assertNoTokens(`autonomy ${e.band} userMessage`, e.userMessage);
  });

  // Worse band never raises the size multiplier.
  for (let i = 1; i < effects.length; i++) {
    check(
      `autonomy: ${effects[i]!.band} size ≤ ${effects[i - 1]!.band}`,
      effects[i]!.sizeMultiplier <= effects[i - 1]!.sizeMultiplier,
    );
  }

  const lockdown = resolveSecurityAutonomyEffect("Lockdown");
  check("autonomy: Lockdown defers (no autonomy)", lockdown.allowAutonomy === false);
  check("autonomy: Lockdown requires admin review", lockdown.requireAdminReview === true);
  check("autonomy: Lockdown size 0", lockdown.sizeMultiplier === 0);

  const healthy = resolveSecurityAutonomyEffect("Healthy");
  check("autonomy: Healthy allows autonomy", healthy.allowAutonomy === true);
  check("autonomy: Healthy full size", healthy.sizeMultiplier === 1);
}

// ── 7. Catalog integrity + no token leak across EVERY action ─────────────────
{
  check("catalog: isSensitiveAction true for known", isSensitiveAction("APPROVE_USER"));
  check("catalog: isSensitiveAction false for junk", !isSensitiveAction("NOT_A_REAL_ACTION"));
  check("catalog: key list non-empty", SENSITIVE_ACTION_KEYS.length >= 17);

  for (const action of SENSITIVE_ACTION_KEYS) {
    // Every action default-denies on empty input AND never leaks a token in the
    // constant user message.
    const v = evaluateSecurityHandshake(action, {});
    check(`catalog ${action}: default-deny`, v.pass === false);
    assertNoTokens(`catalog ${action} userMessage`, v.userMessage);
  }
}

if (failures > 0) {
  console.error(`\nsecurity-handshake: ${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log(`\nsecurity-handshake: all checks passed`);
}

export {};
