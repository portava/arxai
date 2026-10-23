// Regression test for the Live Shared trade ticket clean-copy mapper.
//
// Asserts that for every known Phase B 16-gate refusal code (and the
// extra envelope-level codes we surface), the user-facing sentence
// produced by mapValidationToUserCopy:
//   1. is non-empty prose,
//   2. does NOT contain any forbidden raw token (gate codes, flag names,
//      "defaultDeny", "VIRTUAL_ACCOUNT_ACTIVE", "LIVE_BLOCKED", "/api/",
//      "primaryReason", "blockReasons", etc.),
//   3. successful preflight passes return null (the component renders its
//      own success copy in that case).
//
// Run: pnpm --filter @workspace/scripts run test:live-shared-reason-copy

import {
  mapValidationToUserCopy,
  FORBIDDEN_USER_COPY_TOKENS,
} from "../../artifacts/trading-dashboard/src/components/live/liveSharedReasonCopy.js";

type Case = { name: string; input: Parameters<typeof mapValidationToUserCopy>[0]; expectsNull?: boolean };

const CASES: Case[] = [
  { name: "preflight pass returns null", input: { ok: true, stage: "preflight_passed" }, expectsNull: true },
  { name: "null input returns null", input: null, expectsNull: true },
  { name: "master switch off", input: { primaryReason: "LIVE_BLOCKED:LIVE_BROKER_EXECUTION_DISABLED" } },
  { name: "master switch lower", input: { primaryReason: "MASTER_SWITCH_OFF" } },
  { name: "user not armed", input: { primaryReason: "USER_NOT_ARMED" } },
  { name: "not armed alt", input: { primaryReason: "LIVE_BLOCKED:NOT_ARMED_FOR_LIVE" } },
  { name: "kill switch", input: { primaryReason: "LIVE_BLOCKED:KILL_SWITCH_ACTIVE" } },
  { name: "heartbeat stale", input: { primaryReason: "LIVE_BLOCKED:EA_HEARTBEAT_STALE" } },
  { name: "bridge stale alias", input: { primaryReason: "BRIDGE_STALE" } },
  { name: "ea version low", input: { primaryReason: "LIVE_BLOCKED:EA_VERSION_BELOW_MIN" } },
  { name: "read only mode", input: { primaryReason: "READ_ONLY_MODE_ACTIVE" } },
  { name: "enable live execution off", input: { primaryReason: "ENABLE_LIVE_EXECUTION_OFF" } },
  { name: "live execution off alt", input: { primaryReason: "LIVE_EXECUTION_OFF" } },
  { name: "terminal disconnected", input: { primaryReason: "TERMINAL_NOT_CONNECTED" } },
  { name: "algo trading off", input: { primaryReason: "ALGO_TRADING_DISALLOWED" } },
  { name: "account type wrong", input: { primaryReason: "ACCOUNT_TYPE_NOT_LIVE" } },
  { name: "not live account alt", input: { primaryReason: "NOT_LIVE_ACCOUNT" } },
  { name: "symbol not allowed", input: { primaryReason: "SYMBOL_NOT_IN_ALLOWLIST" } },
  { name: "max lot exceeded", input: { primaryReason: "MAX_LOT_EXCEEDED" } },
  { name: "volume too big", input: { primaryReason: "VOLUME_OVER_LIMIT" } },
  { name: "daily loss cap", input: { primaryReason: "DAILY_LOSS_CAP_REACHED" } },
  { name: "stop loss required", input: { primaryReason: "STOP_LOSS_REQUIRED" } },
  { name: "sl required alt", input: { primaryReason: "SL_REQUIRED" } },
  { name: "shared routing", input: { primaryReason: "SHARED_ROUTING_MISSING_IDS" } },
  { name: "virtual account not found", input: { primaryReason: "VIRTUAL_ACCOUNT_NOT_RESOLVED" } },
  { name: "routing not resolved", input: { primaryReason: "ROUTING_NOT_RESOLVED" } },
  { name: "duplicate idempotency", input: { primaryReason: "DUPLICATE_LIVE_IDEMPOTENCY_KEY" } },
  { name: "confirmation mismatch", input: { primaryReason: "CONFIRMATION_INTENT_MISMATCH" } },
  { name: "unknown code falls back cleanly", input: { primaryReason: "WHATEVER_NEW_GATE_CODE_999" } },
  { name: "reason fallback when primaryReason absent", input: { reason: "EA_HEARTBEAT_STALE" } },
  { name: "empty reason still returns prose", input: { ok: false, primaryReason: "" } },

  // ── createLiveDraft preflight refusals (envelope: reason) ─────────────
  { name: "preflight missing SL", input: { ok: false, stage: "preflight", reason: "MISSING_STOP_LOSS" } },
  { name: "preflight missing TP", input: { ok: false, stage: "preflight", reason: "MISSING_TAKE_PROFIT" } },
  { name: "preflight missing risk template", input: { ok: false, stage: "preflight", reason: "MISSING_RISK_TEMPLATE" } },
  { name: "preflight symbol not allowed", input: { ok: false, stage: "preflight", reason: "SYMBOL_NOT_ALLOWED" } },
  { name: "preflight symbol not live tradable", input: { ok: false, stage: "preflight", reason: "SYMBOL_NOT_LIVE_TRADABLE" } },
  { name: "preflight volume exceeds user max", input: { ok: false, stage: "preflight", reason: "VOLUME_EXCEEDS_USER_MAX_LOT" } },
  { name: "preflight volume exceeds market max", input: { ok: false, stage: "preflight", reason: "VOLUME_EXCEEDS_MARKET_MAX_LOT" } },
  { name: "preflight no active bridge", input: { ok: false, stage: "preflight", reason: "NO_ACTIVE_BRIDGE" } },
  { name: "preflight invalid command type", input: { ok: false, stage: "preflight", reason: "INVALID_COMMAND_TYPE" } },
  { name: "preflight invalid side", input: { ok: false, stage: "preflight", reason: "INVALID_SIDE" } },
  { name: "preflight user not armed", input: { ok: false, stage: "preflight", reason: "USER_NOT_ARMED_FOR_LIVE" } },
  { name: "preflight kill switch", input: { ok: false, stage: "preflight", reason: "KILL_SWITCH_ENGAGED" } },

  // ── requireSharedRouting refusals (envelope: error, NOT reason) ───────
  // These previously fell through to the generic sentence — they were the
  // exact root cause of the scanner ticket showing "Pre-flight checks
  // didn't pass" for users without a shared-master allocation.
  { name: "routing 409 not resolved (error field)", input: { ok: false, error: "ROUTING_NOT_RESOLVED" } },
  { name: "routing 409 not shared master (error field)", input: { ok: false, error: "ROUTING_NOT_SHARED_MASTER" } },
  { name: "routing 409 missing ids (error field)", input: { ok: false, error: "SHARED_ROUTING_MISSING_IDS" } },

  // ── Input validation 400s (envelope: error) ───────────────────────────
  { name: "input 400 symbol required", input: { ok: false, error: "SYMBOL_REQUIRED" } },
  { name: "input 400 volume required", input: { ok: false, error: "VOLUME_REQUIRED" } },
  { name: "auth required (error field)", input: { ok: false, error: "AUTH_REQUIRED" } },
];

// Forbidden: the bare generic sentence must NEVER be returned for any
// blocker whose code we actually know how to interpret. This is the
// regression assertion for the bug the user reported on the scanner
// ticket. Add the code here whenever a new known refusal lands.
const MUST_NOT_BE_GENERIC: Array<LiveSharedReasonInputForTest> = [
  // every createLiveDraft refusal
  { reason: "USER_NOT_ARMED_FOR_LIVE" }, { reason: "KILL_SWITCH_ENGAGED" },
  { reason: "INVALID_COMMAND_TYPE" }, { reason: "INVALID_SIDE" },
  { reason: "VOLUME_EXCEEDS_USER_MAX_LOT" }, { reason: "VOLUME_EXCEEDS_MARKET_MAX_LOT" },
  { reason: "SYMBOL_NOT_ALLOWED" }, { reason: "SYMBOL_NOT_LIVE_TRADABLE" },
  { reason: "MISSING_STOP_LOSS" }, { reason: "MISSING_TAKE_PROFIT" },
  { reason: "MISSING_RISK_TEMPLATE" }, { reason: "NO_ACTIVE_BRIDGE" },
  // every requireSharedRouting refusal
  { error: "ROUTING_NOT_RESOLVED" }, { error: "ROUTING_NOT_SHARED_MASTER" },
  { error: "SHARED_ROUTING_MISSING_IDS" },
  // input validation
  { error: "SYMBOL_REQUIRED" }, { error: "VOLUME_REQUIRED" }, { error: "AUTH_REQUIRED" },
];
type LiveSharedReasonInputForTest = Parameters<typeof mapValidationToUserCopy>[0];
const GENERIC_SENTENCES = new Set<string>([
  "Pre-flight checks didn't pass. Adjust the trade or contact your operator.",
  "Trade blocked by safety checks. Adjust the trade or contact your operator.",
]);

let pass = 0, fail = 0;
const failures: string[] = [];

for (const c of CASES) {
  const out = mapValidationToUserCopy(c.input);
  if (c.expectsNull) {
    if (out === null) { pass++; continue; }
    fail++; failures.push(`[${c.name}] expected null, got ${JSON.stringify(out)}`);
    continue;
  }
  if (!out || typeof out !== "string" || out.length < 10) {
    fail++; failures.push(`[${c.name}] empty/short copy: ${JSON.stringify(out)}`);
    continue;
  }
  const leaked = FORBIDDEN_USER_COPY_TOKENS.filter((t) => out.includes(t));
  if (leaked.length > 0) {
    fail++; failures.push(`[${c.name}] leaked tokens ${JSON.stringify(leaked)} in: ${out}`);
    continue;
  }
  pass++;
}

// Regression assertion for the scanner-ticket bug: every KNOWN refusal
// code must map to a SPECIFIC sentence, never the generic fallback.
for (const input of MUST_NOT_BE_GENERIC) {
  const out = mapValidationToUserCopy(input);
  const label = JSON.stringify(input);
  if (!out) {
    fail++; failures.push(`[non-generic ${label}] expected specific copy, got null`);
    continue;
  }
  if (GENERIC_SENTENCES.has(out)) {
    fail++; failures.push(`[non-generic ${label}] fell through to generic sentence: ${out}`);
    continue;
  }
  pass++;
}

console.log(`live-shared reason-copy: ${pass}/${pass + fail} PASS`);
if (failures.length) {
  for (const f of failures) console.log("  FAIL " + f);
  process.exit(1);
}
process.exit(0);
