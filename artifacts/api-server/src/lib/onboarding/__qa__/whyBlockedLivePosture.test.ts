// Help / "why am I blocked" must describe the account's live-trading posture
// from the SAME source as the dashboard's Trading Permission card
// (/api/me/account-mode: computeAccountShell + getMyArming +
// readPlatformSwitches → computeAccountModePrecedence), never from a
// hard-coded "This app is PAPER_ONLY ... cannot be enabled" constant.
//
// Before the fix an armed LIVE_SHARED trader saw "Live trading is active on
// your shared-master allocation" on the dashboard and "This app is PAPER_ONLY.
// The internal safety core does not allow live trading." in Help.
//
// The real explainers and the real precedence resolver run; only the account
// reads and the paper-stack inputs are stubbed. No database, no network.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/lib/onboarding/__qa__/whyBlockedLivePosture.test.ts

import { mock, test } from "node:test";
import assert from "node:assert/strict";

type Shell = { tradingMode: "DISABLED" | "SIMULATED" | "DEMO" | "LIVE"; tradingStatus: string; notes: { sharedMasterAccountAssigned: boolean; needsReviewItems: number } };
const state: { shell: Shell | Error; armed: boolean; liveOn: boolean } = {
  shell: { tradingMode: "LIVE", tradingStatus: "ACTIVE", notes: { sharedMasterAccountAssigned: true, needsReviewItems: 0 } },
  armed: true,
  liveOn: true,
};

mock.module("../../../routes/meAccountShell.js", {
  namedExports: {
    computeAccountShell: async () => {
      if (state.shell instanceof Error) throw state.shell;
      return state.shell;
    },
  },
});
mock.module("../../live/liveArming.js", {
  namedExports: { getMyArming: async () => ({ isArmed: state.armed }) },
});
mock.module("../../safety/platformSwitches.js", {
  namedExports: {
    readPlatformSwitches: async () => ({
      readable: true,
      liveBrokerExecution: { envEnabled: state.liveOn, operatorArmed: state.liveOn, enabled: state.liveOn, armedAt: null, armedBy: null, armedBridgeId: null },
    }),
  },
});
mock.module("../../paperSession/manager.js", {
  namedExports: { preflight: async () => ({ paperTestingAllowed: true, hardBlocks: [] }), getActiveSession: async () => null },
});
mock.module("../../readiness/traderReadiness.js", { namedExports: { evaluateReadiness: async () => null } });
mock.module("../../readiness/gate.js", { namedExports: { getGateStatus: async () => null } });
mock.module("../../alerts/alertManager.js", { namedExports: { getCriticalUnread: async () => [], createAlert: async () => undefined } });
mock.module("../../systemHealth/audit.js", { namedExports: { auditEvent: async () => undefined } });
mock.module("@workspace/db", {
  namedExports: { db: { insert: () => ({ values: async () => undefined }) }, blockedActionExplanationsTable: {} },
});

const { explainBlockedAction, explainTopic } = await import("../whyBlocked.js");

// Any wording that states the account (or "this app") cannot trade live.
const PAPER_ONLY_CLAIM = /PAPER_ONLY|paper[- ]only|live trading (is|remains) disabled|cannot be (enabled|unlocked)|does not allow live/i;

function armedLiveShared() {
  state.shell = { tradingMode: "LIVE", tradingStatus: "ACTIVE", notes: { sharedMasterAccountAssigned: true, needsReviewItems: 0 } };
  state.armed = true;
  state.liveOn = true;
}

test("armed LIVE_SHARED: why-blocked(ENABLE_LIVE_TRADING) says what the dashboard says, not PAPER_ONLY", async () => {
  armedLiveShared();
  const e = await explainBlockedAction("ENABLE_LIVE_TRADING", 7);
  for (const r of [...e.plainEnglishReasons, ...e.recommendedFixes, e.safeNextStep]) assert.doesNotMatch(r, PAPER_ONLY_CLAIM);
  assert.equal(e.livePosture.state, "LIVE_ARMED");
  assert.equal(e.livePosture.currentAccountMode, "LIVE_SHARED");
  // The cockpit's own label and message (computeAccountModePrecedence).
  assert.match(e.plainEnglishReasons.join(" "), /Live \(Shared Master MT5\)/);
  assert.match(e.plainEnglishReasons.join(" "), /Live trading is active on your shared-master allocation/);
  assert.match(e.plainEnglishReasons.join(" "), /checked \d\d:\d\d UTC/);
});

test("armed LIVE_SHARED: explainTopic('why is live trading disabled') does not claim it is", async () => {
  armedLiveShared();
  const r = await explainTopic("why is live trading disabled", 7);
  assert.doesNotMatch(r.plainEnglishExplanation, PAPER_ONLY_CLAIM);
  assert.doesNotMatch(r.safetyReminder, PAPER_ONLY_CLAIM);
  for (const a of r.recommendedNextActions) assert.doesNotMatch(a, PAPER_ONLY_CLAIM);
  assert.match(r.plainEnglishExplanation, /Live \(Shared Master MT5\)/);
  assert.equal(r.status, "INFO");
});

test("armed LIVE_SHARED: broker topic and paper-session explainer carry no account-wide paper-only claim", async () => {
  armedLiveShared();
  const b = await explainTopic("why is broker read-only", 7);
  assert.doesNotMatch(b.plainEnglishExplanation, PAPER_ONLY_CLAIM);
  assert.doesNotMatch(b.plainEnglishExplanation, /Live execution is disabled in this app/i);
  const e = await explainBlockedAction("START_PAPER_SESSION", 7);
  for (const r of [...e.plainEnglishReasons, ...e.technicalReasons]) assert.doesNotMatch(r, PAPER_ONLY_CLAIM);
  assert.ok(e.technicalReasons.some((t) => /accountMode=LIVE_SHARED liveExecutionArmed=true/.test(t)));
});

test("demo account: the account-mode words say demo", async () => {
  state.shell = { tradingMode: "DEMO", tradingStatus: "ACTIVE", notes: { sharedMasterAccountAssigned: false, needsReviewItems: 0 } };
  state.armed = false;
  state.liveOn = false;
  const e = await explainBlockedAction("USE_BROKER_EXECUTION", 7);
  assert.equal(e.livePosture.state, "NOT_LIVE");
  assert.match(e.plainEnglishReasons[0]!, /Demo Mode/);
  for (const r of e.plainEnglishReasons) assert.doesNotMatch(r, PAPER_ONLY_CLAIM);
});

test("account mode unreadable: says it could not be read — never paper, never live", async () => {
  state.shell = new Error("ECONNREFUSED (fixture)");
  const e = await explainBlockedAction("ENABLE_LIVE_TRADING", 7);
  assert.equal(e.livePosture.state, "UNKNOWN");
  assert.equal(e.livePosture.currentAccountMode, null);
  assert.match(e.plainEnglishReasons[0]!, /could not be read/);
  for (const r of e.plainEnglishReasons) {
    assert.doesNotMatch(r, PAPER_ONLY_CLAIM);
    assert.doesNotMatch(r, /Live \(Shared|Demo Mode|Paper Mode/);
  }
  const t = await explainTopic("is live trading disabled?", 7);
  assert.equal(t.status, "WARN");
  assert.match(t.plainEnglishExplanation, /could not be read/);
});
