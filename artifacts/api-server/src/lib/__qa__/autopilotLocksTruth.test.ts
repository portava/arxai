// Truth regression: the Autopilot Control Center's safety locks and kill switch.
//
// Before: every lock read as an un-tripped "clear" badge, although only
// KILL_SWITCH, DAILY_LOSS and WEEKLY_LOSS have a code path that sets them. A
// scan inside a news window moved State to BLOCKED_BY_NEWS while NEWS_WINDOW
// read clear. The platform kill switch (safety core) was not reported at all,
// so an engaged platform stop showed no banner.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit src/lib/__qa__/autopilotLocksTruth.test.ts

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const realMdl = await import("../marketDataLayer.js");
mock.module("../marketDataLayer.js", { namedExports: {
  ...realMdl,
  currentNewsRisk: (symbol?: string) => ({
    symbol: symbol ?? null, blocking: true, blockReason: "Within news avoid window: QA event", events: [], dataSource: "SIMULATOR",
  }),
} });
mock.module("../marketScanner.js", { namedExports: { pushDecision: () => undefined } });
mock.module("../oms.js", { namedExports: {
  placeOrder: async () => { throw new Error("no order expected in OBSERVE_ONLY"); },
  fillOrder: async () => { throw new Error("no fill expected"); },
  listOrders: () => [],
  listPositions: () => [],
  pnlSummary: () => ({ dailyPnL: 0, weeklyPnL: 0 }),
} });

const ap = await import("../autopilot.js");

const SRC_DIR = fileURLToPath(new URL("..", import.meta.url));
const AUTOPILOT_SRC = readFileSync(join(SRC_DIR, "autopilot.ts"), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name === "__qa__") continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

test("a lock reported as evaluated has a code path that sets it; every other lock says it is not checked", () => {
  const locks = ap.getSafetyLocks();
  assert.ok(locks.length > 0);
  for (const l of locks) {
    const setter = l.code === "KILL_SWITCH"
      ? /tripLock\("KILL_SWITCH"/.test(AUTOPILOT_SRC)
      : new RegExp(`tripLock\\("${l.code}"`).test(AUTOPILOT_SRC);
    if (l.evaluated) {
      assert.ok(setter, `${l.code} is reported as evaluated but nothing calls tripLock("${l.code}")`);
    } else {
      assert.match(l.checks, /not checked|cannot be set/i, `${l.code} must say it is not checked`);
    }
    assert.ok(l.checks.length > 0, `${l.code} needs plain-English copy`);
  }
  const unchecked = locks.filter((l) => !l.evaluated).map((l) => l.code).sort();
  for (const code of ["NEWS_WINDOW", "WIDE_SPREAD", "RISK_BLOCK", "STALE_DATA", "MAX_DRAWDOWN", "DUPLICATE_ORDER", "AUDIT_FAIL", "OMS_FAIL", "POSITION_MGR_FAIL", "MT5_STATUS"]) {
    assert.ok(unchecked.includes(code), `${code} has no setter and must be reported as not checked`);
  }
});

test("CONSECUTIVE_LOSSES is not checked while nothing feeds the losing-streak counter", () => {
  const callers = walk(join(SRC_DIR, ".."))
    .filter((f) => !f.endsWith(join("lib", "autopilot.ts")))
    .filter((f) => /recordTradeOutcome\(/.test(readFileSync(f, "utf8")) && /autopilot/.test(readFileSync(f, "utf8")));
  const lock = ap.getSafetyLocks().find((l) => l.code === "CONSECUTIVE_LOSSES")!;
  if (callers.length === 0) {
    assert.equal(lock.evaluated, false, "recordTradeOutcome has no caller, so the streak lock can never trip");
    assert.equal(ap.status().consecutiveLossesMeasured, false);
  }
});

test("before any scan, the loss locks are not presented as checked", () => {
  const daily = ap.getSafetyLocks().find((l) => l.code === "DAILY_LOSS")!;
  assert.equal(daily.evaluated, true);
  assert.equal(daily.lastCheckedAt, null, "no scan has run, so DAILY_LOSS was not checked yet");
});

test("a scan inside a news window: State says BLOCKED_BY_NEWS and NEWS_WINDOW does not read as a checked, clear lock", async () => {
  const s = ap.startSession({ name: "qa", mode: "OBSERVE_ONLY", rules: { symbols: ["EURUSD"] } });
  assert.ok(!("error" in s), JSON.stringify(s));
  try {
    const d = await ap.runDecisionPipeline({ force: true, symbol: "EURUSD" });
    if ("error" in d) assert.fail(d.error);
    assert.equal(d.newsRisk, "BLOCKING");
    const news = ap.getSafetyLocks().find((l) => l.code === "NEWS_WINDOW")!;
    assert.ok(news.tripped || news.evaluated === false,
      "NEWS_WINDOW must be tripped or reported as not checked while the scan saw a blocking window");
    assert.ok(!news.lastCheckedAt, "nothing checked NEWS_WINDOW as a lock");
    const daily = ap.getSafetyLocks().find((l) => l.code === "DAILY_LOSS")!;
    if (d.rulesFailed.includes("NO_DATA")) {
      assert.equal(daily.lastCheckedAt, null, "no setup: the loss rules were not reached");
    } else {
      assert.ok(daily.lastCheckedAt, "the scan checked the daily loss limit");
    }
  } finally {
    ap.stopSession();
  }
});

test("the safety-core kill switch is reported, with what it does and does not do to the autopilot", async () => {
  const engagedAt = new Date("2026-10-28T09:00:00Z");
  const r = await ap.autopilotPlatformStop({
    readSwitches: async () => ({ readable: true, emergencyStop: { engaged: false, reason: null, engagedAt: null } }),
    readSafetyCore: async () => ({ readable: true, engaged: true, reason: "operator emergency stop", engagedAt }),
  });
  assert.equal(r.engaged, true);
  assert.equal(r.readByAutopilot, false, "no autopilot code reads the platform stop");
  assert.equal(r.haltsAutopilotOrders, true, "the Risk Governor halts paper orders on the safety-core switch");
  assert.deepEqual(r.sources, [{
    source: "safety_core_kill_switch", reason: "operator emergency stop", engagedAt: engagedAt.toISOString(), haltsAutopilotOrders: true,
  }]);
  // The autopilot's own emergency stop is a different control and stays clear.
  assert.equal(ap.status().killSwitchEngaged, false);
});

test("the platform emergency stop is reported but does not halt the autopilot's paper orders", async () => {
  const r = await ap.autopilotPlatformStop({
    readSwitches: async () => ({ readable: true, emergencyStop: { engaged: true, reason: "ops", engagedAt: null } }),
    readSafetyCore: async () => ({ readable: true, engaged: false, reason: null }),
  });
  assert.equal(r.engaged, true);
  assert.equal(r.haltsAutopilotOrders, false);
  assert.equal(r.sources[0]!.source, "platform_emergency_stop");
  assert.equal(r.sources[0]!.haltsAutopilotOrders, false);
});

test("an unreadable platform stop is reported as unreadable, not released", async () => {
  const r = await ap.autopilotPlatformStop({
    readSwitches: async () => { throw new Error("db down"); },
    readSafetyCore: async () => ({ readable: true, engaged: false, reason: null }),
  });
  assert.equal(r.readable, false);
  assert.equal(r.engaged, true);
  assert.equal(r.haltsAutopilotOrders, true);
});
