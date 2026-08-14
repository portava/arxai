// Task #785 — Unified live-readiness PURE decision regression suite (offline).
//
// Verifies decideUnifiedLiveReadiness composes the readiness primitives into an
// honest verdict WITHOUT a DB, feed, or any gate:
//   PART A — A fully-clear input is the ONLY shape that yields liveEntryEligible.
//   PART B — Each blocker fires independently from its own false input.
//   PART C — Multiple simultaneous blockers are all collected (multi-blocker honesty).
//   PART D — Symbol-scoped blockers (symbol/feed) only fire when a symbol is in context.
//   PART E — Investor / bot-agent classification short-circuits the human-only blockers.
//   PART F — Derived booleans (liveExecutionActive, riskEligible, killSwitchClear).
//
// SAFETY: pure logic test. No DB, no feed, no broker calls, no trades. This is a
// DESCRIBE-only resolver; dispatch still re-runs the full 18-gate pipeline.

import {
  decideUnifiedLiveReadiness,
  type UnifiedLiveReadinessInput,
  type LiveReadinessBlockerCode,
} from "../../artifacts/api-server/src/lib/live/unifiedLiveReadinessDecision.js";

type CaseResult = { name: string; ok: boolean; detail?: string };
const results: CaseResult[] = [];
function record(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  // eslint-disable-next-line no-console
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

// A fully-ready HUMAN trader with a symbol+feed in context. Every other case is
// this base with exactly one field flipped, so a single failure is unambiguous.
function readyBase(): UnifiedLiveReadinessInput {
  return {
    userId: 1,
    email: "trader@example.com",
    role: "USER",
    isInvestor: false,
    isBotAgentSystem: false,
    isHumanTrader: true,
    accountMode: "LIVE",
    liveApproved: true,
    sharedBridgeApproved: true,
    fullLiveActivation: true,
    armed: true,
    serverLiveExecutionOn: true,
    killSwitchEngaged: false,
    emergencyKillSwitch: false,
    riskProfileReady: true,
    bridgeMode: "MASTER_LIVE_SHARED",
    bridgeHeartbeatFresh: true,
    brokerAccountId: 42,
    allocationSource: "SHARED_MASTER_POOL",
    allocatedAmount: 1000,
    availableLiveAllocation: 800,
    hasAllocation: true,
    symbol: "EURUSD",
    brokerSymbol: "EURUSD",
    normalizedSymbol: "EURUSD",
    selectedTimeframe: "M1",
    lastTickAt: null,
    lastCandleAt: "2026-06-28T00:00:00.000Z",
    feedSource: "mt5_broker",
    feedConfirmed: true,
    missingIntervals: 0,
    symbolLiveEligible: true,
  };
}

function has(codes: { code: LiveReadinessBlockerCode }[], code: LiveReadinessBlockerCode) {
  return codes.some((b) => b.code === code);
}

// ── PART A — clear input is the only eligible shape ──────────────────
console.log("\nPART A — fully-clear input");
{
  const r = decideUnifiedLiveReadiness(readyBase());
  record("clear input ⇒ liveEntryEligible true", r.liveEntryEligible === true, `blockers=${r.blockers.length}`);
  record("clear input ⇒ zero blockers", r.blockers.length === 0);
  record("clear input ⇒ liveExecutionActive true", r.liveExecutionActive === true);
}

// ── PART B — each blocker fires from its own false input ─────────────
console.log("\nPART B — single-blocker isolation");
const singles: Array<{ label: string; mutate: (i: UnifiedLiveReadinessInput) => void; code: LiveReadinessBlockerCode }> = [
  { label: "not approved", mutate: (i) => (i.liveApproved = false), code: "NOT_APPROVED_FOR_LIVE" },
  { label: "bridge pending", mutate: (i) => (i.sharedBridgeApproved = false), code: "LIVE_BRIDGE_ASSIGNMENT_PENDING" },
  { label: "not activated", mutate: (i) => (i.fullLiveActivation = false), code: "LIVE_CONFIRMATION_REQUIRED" },
  { label: "not armed", mutate: (i) => (i.armed = false), code: "LIVE_ARMING_PENDING" },
  { label: "server off", mutate: (i) => (i.serverLiveExecutionOn = false), code: "SERVER_LIVE_EXECUTION_OFF" },
  { label: "kill switch", mutate: (i) => (i.killSwitchEngaged = true), code: "KILL_SWITCH_ENGAGED" },
  { label: "emergency stop", mutate: (i) => (i.emergencyKillSwitch = true), code: "EMERGENCY_STOP_ACTIVE" },
  { label: "risk incomplete", mutate: (i) => (i.riskProfileReady = false), code: "RISK_PROFILE_INCOMPLETE" },
  { label: "no allocation", mutate: (i) => { i.hasAllocation = false; i.availableLiveAllocation = 0; }, code: "NO_LIVE_ALLOCATION" },
  { label: "heartbeat stale", mutate: (i) => (i.bridgeHeartbeatFresh = false), code: "BRIDGE_HEARTBEAT_STALE" },
  { label: "symbol not eligible", mutate: (i) => (i.symbolLiveEligible = false), code: "SYMBOL_NOT_LIVE_ELIGIBLE" },
  { label: "feed not confirmed", mutate: (i) => (i.feedConfirmed = false), code: "BROKER_FEED_NOT_CONFIRMED" },
];
for (const s of singles) {
  const i = readyBase();
  s.mutate(i);
  const r = decideUnifiedLiveReadiness(i);
  record(`${s.label} ⇒ ${s.code} + not eligible`, has(r.blockers, s.code) && r.liveEntryEligible === false, `blockers=${r.blockers.map((b) => b.code).join(",")}`);
}

// ── PART C — multi-blocker honesty ───────────────────────────────────
console.log("\nPART C — multiple simultaneous blockers all collected");
{
  const i = readyBase();
  i.liveApproved = false;
  i.armed = false;
  i.feedConfirmed = false;
  const r = decideUnifiedLiveReadiness(i);
  const all = has(r.blockers, "NOT_APPROVED_FOR_LIVE") && has(r.blockers, "LIVE_ARMING_PENDING") && has(r.blockers, "BROKER_FEED_NOT_CONFIRMED");
  record("three flipped ⇒ all three blockers present", all && r.blockers.length >= 3, `blockers=${r.blockers.map((b) => b.code).join(",")}`);
}

// ── PART D — symbol-scoped blockers gated by symbol-in-context ────────
console.log("\nPART D — no symbol ⇒ no feed/symbol blockers");
{
  const i = readyBase();
  i.symbol = null;
  i.feedConfirmed = false; // would block IF a symbol were in context
  i.symbolLiveEligible = false;
  const r = decideUnifiedLiveReadiness(i);
  record("null symbol ⇒ no BROKER_FEED_NOT_CONFIRMED", !has(r.blockers, "BROKER_FEED_NOT_CONFIRMED"));
  record("null symbol ⇒ no SYMBOL_NOT_LIVE_ELIGIBLE", !has(r.blockers, "SYMBOL_NOT_LIVE_ELIGIBLE"));
  record("null symbol + account clear ⇒ eligible", r.liveEntryEligible === true, `blockers=${r.blockers.map((b) => b.code).join(",")}`);
}

// ── PART E — investor / bot-agent classification ─────────────────────
console.log("\nPART E — investor / bot-agent short-circuit");
{
  const inv = readyBase();
  inv.isInvestor = true;
  const ri = decideUnifiedLiveReadiness(inv);
  record("investor ⇒ INVESTOR_NOT_ALLOWED + not eligible", has(ri.blockers, "INVESTOR_NOT_ALLOWED") && ri.liveEntryEligible === false);
  record("investor ⇒ no human-only blockers leaked", !has(ri.blockers, "LIVE_ARMING_PENDING"));

  const bot = readyBase();
  bot.isBotAgentSystem = true;
  const rb = decideUnifiedLiveReadiness(bot);
  record("bot/agent ⇒ BOT_AGENT_NOT_ALLOWED + not eligible", has(rb.blockers, "BOT_AGENT_NOT_ALLOWED") && rb.liveEntryEligible === false);
}

// ── PART F — derived booleans ────────────────────────────────────────
console.log("\nPART F — derived booleans");
{
  const i = readyBase();
  i.killSwitchEngaged = true;
  const r = decideUnifiedLiveReadiness(i);
  record("kill switch ⇒ killSwitchClear false", r.killSwitchClear === false);
  record("kill switch ⇒ liveExecutionActive false", r.liveExecutionActive === false);

  const j = readyBase();
  j.availableLiveAllocation = 0;
  j.hasAllocation = false;
  const rj = decideUnifiedLiveReadiness(j);
  record("no available allocation ⇒ riskEligible false", rj.riskEligible === false);
}

// ── Summary ──────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
console.log(`\nunified-live-readiness: ${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) {
  console.error(`FAILED: ${failed.map((f) => f.name).join("; ")}`);
  process.exit(1);
}
