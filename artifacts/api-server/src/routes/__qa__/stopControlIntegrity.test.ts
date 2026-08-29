// Stop-control integrity — the authority on the platform-wide safety endpoints
// and the honesty of the Risk Settings emergency stop.
//
// Two audit findings are pinned here.
//
// RANK 7 — POST /api/system/mode, /system/kill-switch/engage and
// /system/kill-switch/reset were mounted BARE (routes/index.ts:274) with no
// requireUser, no requireAdmin, no router.use and no checkPermission anywhere
// in routes/system.ts. The only check on reset was the acknowledgement literal
// "I_UNDERSTAND_RISK", which the /emergency dialog prints on screen. The global
// gate denies anonymous /api/*, so this was not unauthenticated — but ANY
// signed-in trader could release the platform emergency stop for every user, or
// flip the global mode to LIVE_TRADING. The vault actor came from
// caller-supplied body fields (changedBy / triggeredBy / resetBy), hardcoded to
// "operator" by the UI, so the audit trail answering "who stopped trading and
// who restarted it" was caller-controlled.
//
// RANK 5 — POST /bot/emergency-stop looped the user's OPEN rows in `trades` and
// wrote {status:'CANCELLED', closedAt:now, pnl:0}. No broker command was issued
// anywhere in the handler, and `trades` rows carry mode 'LIVE' as well as
// 'DEMO'. The biggest red button in Risk Settings rewrote executed trade history
// as cancelled-with-zero-P&L while the real positions stayed open.
//
// The permission assertions run for REAL against checkPermission (its seed-map
// fallback makes it offline-safe — see lib/security/permissions.ts). The
// wiring assertions are source-structural, which is what proves a *route* is
// wrapped: a unit test cannot see a handler that was never gated.
//
// Run: node --import tsx --test --test-force-exit \
//   src/routes/__qa__/stopControlIntegrity.test.ts

process.env.DATABASE_URL ??= "postgres://qa:qa@127.0.0.1:1/qa_offline_never_connects";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// Dynamic: permissions.js transitively imports @workspace/db, whose module init
// throws when DATABASE_URL is unset — a static import would be hoisted above the
// assignment above. The pg Pool is lazy; checkPermission's DB lookup fails and
// falls through to its seed map, so no query is ever issued by these tests.
const { checkPermission } = await import("../../lib/security/permissions.js");

const SYSTEM_SRC = readFileSync(fileURLToPath(new URL("../system.ts", import.meta.url)), "utf8");
const BOT_SRC = readFileSync(fileURLToPath(new URL("../bot.ts", import.meta.url)), "utf8");

// ── RANK 7 · the permission keys actually separate authority ────────────────

test("ENGAGE is available to a trader; RESET is not", async () => {
  // Pulling a stop is a REDUCE-only action — every trader must be able to.
  assert.equal((await checkPermission("TRADER", "live_trading:kill_switch")).allowed, true);
  // Releasing the platform stop for every user is not a trader's call.
  assert.equal((await checkPermission("TRADER", "live_trading:reset")).allowed, false);
});

test("ADMIN and OWNER hold both; VIEWER holds neither", async () => {
  for (const role of ["ADMIN", "OWNER"]) {
    assert.equal((await checkPermission(role, "live_trading:kill_switch")).allowed, true, `${role} engage`);
    assert.equal((await checkPermission(role, "live_trading:reset")).allowed, true, `${role} reset`);
  }
  assert.equal((await checkPermission("VIEWER", "live_trading:kill_switch")).allowed, false);
  assert.equal((await checkPermission("VIEWER", "live_trading:reset")).allowed, false);
});

test("an unknown or absent role normalises to VIEWER, not to trust", async () => {
  for (const role of [undefined, null, "", "SUPERUSER", "root"]) {
    assert.equal(
      (await checkPermission(role, "live_trading:reset")).allowed,
      false,
      `role ${String(role)} must not be able to release the platform kill switch`,
    );
  }
});

// ── RANK 7 · the three mutating /system routes are gated ───────────────────

test("all three mutating /system endpoints carry a permission gate", () => {
  assert.match(
    SYSTEM_SRC,
    /router\.post\("\/system\/mode",\s*requirePermission\("live_trading:kill_switch"\)/,
    "POST /system/mode must be permission-gated",
  );
  assert.match(
    SYSTEM_SRC,
    /router\.post\("\/system\/kill-switch\/engage",\s*requirePermission\("live_trading:kill_switch"\)/,
    "POST /system/kill-switch/engage must be permission-gated",
  );
  assert.match(
    SYSTEM_SRC,
    /router\.post\("\/system\/kill-switch\/reset",\s*requirePermission\("live_trading:reset"\)/,
    "POST /system/kill-switch/reset must require the ADMIN-level reset permission",
  );
});

test("selecting an EXECUTION-CAPABLE mode needs the admin-level permission", () => {
  // OBSERVE_ONLY / SUGGEST_ONLY only ever narrow authority; PAPER_TRADING and
  // LIVE_TRADING widen it, so they need live_trading:reset on top of the floor.
  assert.match(SYSTEM_SRC, /EXECUTION_CAPABLE_MODES\s*=\s*new Set\(\["PAPER_TRADING",\s*"LIVE_TRADING"\]\)/);
  assert.match(SYSTEM_SRC, /EXECUTION_CAPABLE_MODES\.has\(body\.mode\)/);
  assert.match(SYSTEM_SRC, /checkPermission\(role,\s*"live_trading:reset"\)/);
});

test("the vault actor is resolved from the session, never from the body", () => {
  // Every call site must pass resolveActor(req)...
  assert.match(SYSTEM_SRC, /setOperationalMode\(\{\s*mode:\s*body\.mode,\s*changedBy:\s*resolveActor\(req\)\s*\}\)/);
  assert.match(SYSTEM_SRC, /engageKillSwitch\(\{\s*reason:\s*body\.reason,\s*triggeredBy:\s*resolveActor\(req\)\s*\}\)/);
  assert.match(SYSTEM_SRC, /resetKillSwitch\(\{\s*resetBy:\s*resolveActor\(req\),/);
  // ...and resolveActor must read the request, not the payload.
  const fnStart = SYSTEM_SRC.indexOf("function resolveActor(");
  assert.ok(fnStart > 0, "resolveActor must exist");
  const fnBody = SYSTEM_SRC.slice(fnStart, SYSTEM_SRC.indexOf("\n}", fnStart));
  assert.match(fnBody, /readRoleFromRequest\(req\)/);
  assert.doesNotMatch(fnBody, /req\.body/, "the actor must never come from the request body");
  // The old spread that fed body fields straight into the safety core is gone.
  assert.doesNotMatch(SYSTEM_SRC, /engageKillSwitch\(body\)/);
  assert.doesNotMatch(SYSTEM_SRC, /resetKillSwitch\(body\)/);
  assert.doesNotMatch(SYSTEM_SRC, /setOperationalMode\(body\)/);
});

// ── RANK 5 · the emergency stop does not falsify trade records ─────────────

// Assembled at runtime, never written as one literal — including in this
// comment: check-route-collisions.ts scans every source file (tests included)
// for route registrations, and a verbatim registration string for this path in
// this file would count as a second definition of the route and fail the guard.
const EMERGENCY_STOP_REGISTRATION = `router.${"post"}("/bot/emergency-stop"`;

function emergencyStopHandler(): string {
  const start = BOT_SRC.indexOf(EMERGENCY_STOP_REGISTRATION);
  assert.ok(start > 0, "POST /bot/emergency-stop must exist in routes/bot.ts");
  const end = BOT_SRC.indexOf("export default router", start);
  return BOT_SRC.slice(start, end === -1 ? undefined : end);
}

test("the emergency stop NEVER writes to the trades table", () => {
  const handler = emergencyStopHandler();
  assert.doesNotMatch(
    handler,
    /update\(tradesTable\)/,
    "the emergency stop must not mutate executed trade records — it cannot reach the broker, so a CANCELLED/pnl:0 rewrite is a falsified history",
  );
  assert.doesNotMatch(handler, /status:\s*"CANCELLED"/);
  assert.doesNotMatch(handler, /pnl:\s*0\s*[,}]/);
  assert.doesNotMatch(handler, /delete\(tradesTable\)/);
});

test("the emergency stop still halts what it CAN halt", () => {
  const handler = emergencyStopHandler();
  assert.match(handler, /engageKillSwitch\(/, "it must engage the platform kill switch");
  assert.match(handler, /mode:\s*"OFF"/, "it must switch the user's bot OFF");
});

test("it reports zero closed trades, because it closes nothing", () => {
  const handler = emergencyStopHandler();
  assert.match(
    handler,
    /closedTrades:\s*0/,
    "closedTrades used to report the number of rows overwritten, which was never a close",
  );
  // And the user is told what is still open rather than left to assume.
  assert.match(handler, /NOT closed/);
  assert.match(handler, /does not send a close command to your broker/);
});
