// Security Phase 7 (Task #243) — PURE domain unit tests.
//
// Verifies the safety + honesty contracts of the operational-security engines
// that the api-server composes at chokepoints. All ADD caution on top of the
// existing gates and NEVER relax one:
//  1. evaluateRateLimit: trips a cooldown after the limit, then reports an
//     active cooldown without consuming further.
//  2. evaluateStepUp: a dangerous admin action is BLOCKED with no confirmation
//     and ALLOWED only with the exact confirm phrase (or recent reauth).
//  3. evaluateTradeCommandAnomaly: an over-cap lot or a non-permitted agent is
//     BLOCKED; a normal in-baseline command is ALLOWED (advisory-additive).
//  4. resolveOperationalModePosture: LOCKDOWN/INCIDENT (and any unknown mode)
//     pause autonomous entries while STILL allowing protective actions; NORMAL
//     pauses nothing; an unknown mode resolves to the safest (INCIDENT) posture.
//  5. Export envelope: a non-admin export never includes internal formulas,
//     always excludes raw broker payloads, and serialises canonically so the
//     server-side sha256 is reproducible.
//
// Pure & deterministic. No DB, no IO.
// Run: pnpm --filter @workspace/scripts run test:security-phase7

import { createHash } from "node:crypto";
import {
  evaluateRateLimit,
  evaluateStepUp,
  evaluateTradeCommandAnomaly,
  resolveOperationalModePosture,
  buildExportEnvelopeMeta,
  canonicalExportPayload,
  DEFAULT_RATE_LIMIT_POLICY,
  DEFAULT_STEP_UP_POLICY,
  DEFAULT_ANOMALY_POLICY,
  type RateLimitState,
  type TradeCommandObservation,
  type TradeCommandBaseline,
} from "@workspace/domain/security";

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name}`);
  }
}

// ── 1. Rate-limit / cooldown trip ────────────────────────────────────────────
console.log("evaluateRateLimit");
{
  const rule = DEFAULT_RATE_LIMIT_POLICY.LOGIN;
  const now = 1_000_000;
  let state: RateLimitState | null = null;
  let lastDecision = evaluateRateLimit(state, rule, now);
  // Consume exactly `limit` allowed attempts.
  for (let i = 0; i < rule.limit; i += 1) {
    lastDecision = evaluateRateLimit(state, rule, now);
    state = lastDecision.nextState;
  }
  check("allows up to the limit", lastDecision.allowed === true);
  // The next attempt exceeds the limit and trips a cooldown.
  const tripped = evaluateRateLimit(state, rule, now);
  state = tripped.nextState;
  check("blocks once the limit is exceeded", tripped.allowed === false && tripped.blocked === true);
  check("trip reason is RATE_LIMIT_EXCEEDED", tripped.reason === "RATE_LIMIT_EXCEEDED");
  check("trip sets a blockedUntil in the future", (state?.blockedUntil ?? 0) > now);
  // A further attempt while blocked reports the active cooldown and does NOT
  // extend it (the count is not consumed again).
  const whileBlocked = evaluateRateLimit(state, rule, now + 1);
  check("reports active cooldown without re-consuming", whileBlocked.reason === "RATE_LIMIT_COOLDOWN_ACTIVE");
  check("cooldown decision stays blocked", whileBlocked.allowed === false);
  // After the cooldown elapses, a fresh window allows again.
  const afterCooldown = evaluateRateLimit(state, rule, (state?.blockedUntil ?? now) + 1);
  check("allows again after the cooldown elapses", afterCooldown.allowed === true);
}

// ── 2. Step-up blocks an unconfirmed dangerous admin action ──────────────────
console.log("evaluateStepUp");
{
  const rule = DEFAULT_STEP_UP_POLICY.SET_OPERATIONAL_MODE;
  const empty = evaluateStepUp("SET_OPERATIONAL_MODE", rule, {});
  check("unconfirmed dangerous action is NOT satisfied", empty.satisfied === false);
  check("unconfirmed action still flags required", empty.required === true);
  check("unconfirmed method is NONE", empty.methodUsed === "NONE");

  const wrongPhrase = evaluateStepUp("SET_OPERATIONAL_MODE", rule, { confirmPhrase: "nope" });
  check("wrong confirm phrase is NOT satisfied", wrongPhrase.satisfied === false);

  const confirmed = evaluateStepUp("SET_OPERATIONAL_MODE", rule, { confirmPhrase: rule.confirmPhrase ?? "" });
  check("exact confirm phrase satisfies step-up", confirmed.satisfied === true);
  check("satisfied method is CONFIRM_PHRASE", confirmed.methodUsed === "CONFIRM_PHRASE");

  const reauth = evaluateStepUp("SET_OPERATIONAL_MODE", rule, { reauthenticated: true });
  check("recent reauth satisfies step-up", reauth.satisfied === true);
}

// ── 3. Anomalous trade command is blocked (advisory-additive) ────────────────
console.log("evaluateTradeCommandAnomaly");
{
  const baseline: TradeCommandBaseline = { typicalLot: 1, knownSymbols: ["EURUSD"], sampleSize: 50 };
  const normal: TradeCommandObservation = {
    lot: 1,
    symbol: "EURUSD",
    hasStopLoss: true,
    hourUtc: 12,
    source: "self-trade",
    expectedSources: ["self-trade"],
    recentAttempts: 0,
    agentPermitted: true,
    payloadChangedAfterApproval: false,
  };
  const allow = evaluateTradeCommandAnomaly(normal, baseline, DEFAULT_ANOMALY_POLICY);
  check("a normal in-baseline command is ALLOWED", allow.recommendedAction === "ALLOW");

  const overCap = evaluateTradeCommandAnomaly(
    { ...normal, lot: DEFAULT_ANOMALY_POLICY.absoluteLotHardCap + 1 },
    baseline,
    DEFAULT_ANOMALY_POLICY,
  );
  check("an over-hard-cap lot is BLOCKED", overCap.recommendedAction === "BLOCK");

  const notPermitted = evaluateTradeCommandAnomaly(
    { ...normal, agentPermitted: false },
    baseline,
    DEFAULT_ANOMALY_POLICY,
  );
  check("a non-permitted agent is BLOCKED", notPermitted.recommendedAction === "BLOCK");

  const tampered = evaluateTradeCommandAnomaly(
    { ...normal, payloadChangedAfterApproval: true },
    baseline,
    DEFAULT_ANOMALY_POLICY,
  );
  check("a post-approval payload change is BLOCKED", tampered.recommendedAction === "BLOCK");
}

// ── 4. Lockdown pauses autonomous entries but allows protective actions ───────
console.log("resolveOperationalModePosture");
{
  const normal = resolveOperationalModePosture("NORMAL");
  check("NORMAL pauses no autonomous entries", normal.pauseAutonomousEntries === false);
  check("NORMAL allows protective actions", normal.allowProtectiveActions === true);

  const lockdown = resolveOperationalModePosture("LOCKDOWN");
  check("LOCKDOWN pauses autonomous entries", lockdown.pauseAutonomousEntries === true);
  check("LOCKDOWN STILL allows protective actions", lockdown.allowProtectiveActions === true);
  check("LOCKDOWN blocks new allocations", lockdown.blockNewAllocations === true);

  const incident = resolveOperationalModePosture("INCIDENT");
  check("INCIDENT pauses autonomous entries", incident.pauseAutonomousEntries === true);
  check("INCIDENT disables affected tokens", incident.disableAffectedTokens === true);
  check("INCIDENT STILL allows protective actions", incident.allowProtectiveActions === true);

  const unknown = resolveOperationalModePosture("???");
  check("an unknown mode resolves to the safest (INCIDENT) posture", unknown.mode === "INCIDENT");
  check("unknown mode pauses autonomous entries", unknown.pauseAutonomousEntries === true);
  check("unknown mode allows protective actions", unknown.allowProtectiveActions === true);
}

// ── 5. Export envelope excludes secrets + serialises canonically ─────────────
console.log("exportProtection");
{
  const userMeta = buildExportEnvelopeMeta(
    {
      exportType: "data_protection",
      requestedBy: "u-42",
      requestedByRole: "USER",
      redactionStatus: "REDACTED",
      redactedKeys: ["bridgeToken", "apiKeyHash"],
      recordCount: 10,
      adminExport: false,
    },
    "exp-1",
    "2026-06-07T00:00:00.000Z",
  );
  check("non-admin export excludes internal formulas", userMeta.internalFormulasIncluded === false);
  check("export always excludes raw broker payloads", userMeta.rawBrokerPayloadExcluded === true);
  check("export declares sha256 signature algorithm", userMeta.signatureAlgorithm === "sha256");
  check("redacted keys are surfaced + sorted", userMeta.redactedKeys.join(",") === "apiKeyHash,bridgeToken");

  const adminMeta = buildExportEnvelopeMeta(
    {
      exportType: "data_protection",
      requestedBy: "admin-1",
      requestedByRole: "ADMIN",
      redactionStatus: "REDACTED",
      redactedKeys: [],
      recordCount: 10,
      adminExport: true,
    },
    "exp-2",
    "2026-06-07T00:00:00.000Z",
  );
  check("admin export may include internal formulas", adminMeta.internalFormulasIncluded === true);

  // Canonical payload is deterministic → reproducible sha256.
  const a = canonicalExportPayload(userMeta);
  const b = canonicalExportPayload(userMeta);
  check("canonical payload is stable", a === b);
  const hashA = createHash("sha256").update(a).digest("hex");
  const hashB = createHash("sha256").update(b).digest("hex");
  check("canonical sha256 is reproducible", hashA === hashB && hashA.length === 64);
}

// ── 6. Fail-open classification (regression) ─────────────────────────────────
// A persistence error must NEVER turn a sensitive cooldown into a control
// bypass. Only public anti-enumeration auth paths may fail open; every
// admin/trade/retry/assistant action must fail closed (unknown ⇒ caution).
{
  const PUBLIC_AUTH = new Set(["LOGIN", "FORGOT_PASSWORD", "RESET_PASSWORD", "INVITE_CODE_ATTEMPT", "REQUEST_ACCESS"]);
  let classificationOk = true;
  for (const [action, rule] of Object.entries(DEFAULT_RATE_LIMIT_POLICY)) {
    const expected = PUBLIC_AUTH.has(action);
    if (rule.failOpen !== expected) classificationOk = false;
  }
  check("only public-auth actions fail open; all sensitive actions fail closed", classificationOk);
  check("ADMIN_ACTION fails closed", DEFAULT_RATE_LIMIT_POLICY.ADMIN_ACTION.failOpen === false);
  check("ADMIN_ACTION_FAILED fails closed", DEFAULT_RATE_LIMIT_POLICY.ADMIN_ACTION_FAILED.failOpen === false);
  check("LIVE_COMMAND_RETRY fails closed", DEFAULT_RATE_LIMIT_POLICY.LIVE_COMMAND_RETRY.failOpen === false);
  check("SCANNER_TO_TRADE fails closed", DEFAULT_RATE_LIMIT_POLICY.SCANNER_TO_TRADE.failOpen === false);
  check("LOGIN fails open", DEFAULT_RATE_LIMIT_POLICY.LOGIN.failOpen === true);
}

if (failures > 0) {
  console.error(`\nSecurity Phase 7 tests FAILED: ${failures} failure(s).`);
  process.exit(1);
}
console.log("\nSecurity Phase 7 tests passed.");

export {};
