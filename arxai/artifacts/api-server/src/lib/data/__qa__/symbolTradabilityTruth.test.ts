// QA — the tradability badge says only what was checked.
//
// "Tradable via MT5" + "This market can be traded through the connected MT5
// bridge if all live safety gates pass" came from one allow-list lookup:
// nothing about a connected bridge, the broker's symbols, ARX Focus approval
// or governance was checked. A symbol on the default list but outside ARX
// Focus (NAS100 / WTI / UKOIL) — which the live pipeline refuses outright
// (SYMBOL_NOT_IN_ARX_FOCUS) — still read "Tradable via MT5", and when the
// user's own list could not be read the default list was used silently and
// presented as theirs.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//   src/lib/data/__qa__/symbolTradabilityTruth.test.ts

process.env.DATABASE_URL ??= "postgres://qa:qa@127.0.0.1:1/qa_offline_never_connects";

import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { isApprovedArxMarket } from "@workspace/domain/market";

let settings: () => Promise<{ allowedSymbols: string[] | null }> = async () => ({ allowedSymbols: null });
mock.module("../../live/liveCommandPipeline.js", { namedExports: {
  getOrCreateUserSettings: async () => settings(),
} });
// The Risk Governor's limits in force and the owner/admin governance, as the
// order path reads them. Defaults: nothing restricts the symbol.
type Limits = {
  liveAllowed: boolean; allowedSymbols: string[] | null;
  symbolLimits: Record<string, { maxLots: number | null; blocked: boolean }>;
};
const OPEN_LIMITS: Limits = { liveAllowed: true, allowedSymbols: null, symbolLimits: {} };
let limits: () => Promise<Limits> = async () => OPEN_LIMITS;
mock.module("../../riskGovernor/limitSettings.js", { namedExports: {
  loadEffectiveLimits: async () => limits(),
} });
type Gov = {
  isPrivileged: boolean; ownerLiveControlMode: boolean;
  allowedSymbols: string[] | null; blockedSymbols: string[]; enforceSymbolAllowlist: boolean;
};
const NORMAL_USER: Gov = { isPrivileged: false, ownerLiveControlMode: false, allowedSymbols: null, blockedSymbols: [], enforceSymbolAllowlist: false };
let governance: () => Promise<Gov> = async () => NORMAL_USER;
mock.module("../../governance/effectiveGovernance.js", { namedExports: {
  getEffectiveTradingGovernance: async () => governance(),
} });

const { getSymbolTradability } = await import("../symbolTradability.js");

beforeEach(() => {
  settings = async () => ({ allowedSymbols: null });
  limits = async () => OPEN_LIMITS;
  governance = async () => NORMAL_USER;
});

test("a default-list symbol outside ARX Focus is not shown as tradable (the pipeline refuses it)", async () => {
  assert.equal(isApprovedArxMarket("NAS100"), false, "fixture: NAS100 is outside ARX Focus");
  const t = await getSymbolTradability("NAS100", 1);
  assert.notEqual(t.badgeLabel, "Tradable via MT5");
  assert.equal(t.mt5Tradable, "no");
  assert.equal(t.liveExecutionAllowed, false);
  assert.match(t.userMessage, /ARX Focus/);
  assert.match(t.userMessage, /refused/);
});

test("the user's live list could not be read → not verified, never the default list presented as theirs", async () => {
  settings = async () => { throw new Error("db offline"); };
  const t = await getSymbolTradability("EURUSD", 1);
  assert.notEqual(t.badgeLabel, "Tradable via MT5");
  assert.equal(t.mt5Tradable, "unknown");
  assert.equal(t.badgeLabel, "Tradability not verified");
  assert.equal(t.liveExecutionAllowed, false);
  assert.match(t.userMessage, /could not be loaded/);
});

test("allowed symbol: the label says it is allowed, and the copy names what was not checked", async () => {
  settings = async () => ({ allowedSymbols: ["EURUSD"] });
  const t = await getSymbolTradability("EURUSD", 1);
  assert.equal(t.mt5Tradable, "yes");
  assert.equal(t.liveExecutionAllowed, true);
  assert.equal(t.badgeLabel, "Allowed for MT5 live");
  // No claim about a bridge connection it never looked at.
  assert.doesNotMatch(t.userMessage, /connected/i);
  assert.match(t.userMessage, /your live market list/);
  assert.match(t.userMessage, /bridge/);
  assert.match(t.userMessage, /only when an order is submitted/);
});

test("no list of their own → the copy says the default list was used", async () => {
  const t = await getSymbolTradability("EURUSD", 1);
  assert.equal(t.mt5Tradable, "yes");
  assert.match(t.userMessage, /default live market list/);
});

test("not on the list → analysis only, naming the list", async () => {
  settings = async () => ({ allowedSymbols: ["GBPUSD"] });
  const t = await getSymbolTradability("EURUSD", 1);
  assert.equal(t.mt5Tradable, "no");
  assert.equal(t.badgeLabel, "Analysis only");
  assert.match(t.userMessage, /not on your live market list/);
});

test("the live pipeline's synthetic-floor inputs are unchanged", async () => {
  const v = await getSymbolTradability("V75", 1);
  assert.equal(v.assetClass, "synthetic");
  assert.equal(v.dataProvider, "deriv");
  const e = await getSymbolTradability("EURUSD", 1);
  assert.equal(e.dataProvider, "external");
});

// ── The label never names a data provider it did not observe ───────────────

test("synthetic not on the list: the label/copy do not name Deriv (the router may serve it from the MT5 broker)", async () => {
  settings = async () => ({ allowedSymbols: ["EURUSD"] });
  const t = await getSymbolTradability("V75", 1);
  assert.equal(t.mt5Tradable, "no");
  assert.notEqual(t.badgeLabel, "Data-only via Deriv");
  assert.equal(t.badgeLabel, "Analysis only");
  assert.doesNotMatch(t.userMessage, /deriv/i);
  assert.doesNotMatch(t.userMessage, /current MT5 bridge/i);
  assert.match(t.userMessage, /not on your live market list/);
  // The class-derived route label the live pipeline's synthetic floor reads stays.
  assert.equal(t.dataProvider, "deriv");
});

// ── The governor's and governance's own refusals ───────────────────────────
// "Allowed for MT5 live" came from the live list and ARX Focus only. The Risk
// Governor also refuses every live order when the operator limited the
// account to demo, the symbol is off the operator's instruments, or the
// trader switched it off; owner/admin governance refuses its blocklist and,
// when enforced, anything off its allowlist (and then the live list is not
// read at all). All are stored facts, so the badge now says so.

test("an account the operator limited to demo is not shown as allowed for MT5 live", async () => {
  limits = async () => ({ ...OPEN_LIMITS, liveAllowed: false });
  const t = await getSymbolTradability("EURUSD", 1);
  assert.equal(t.mt5Tradable, "no");
  assert.equal(t.liveExecutionAllowed, false);
  assert.equal(t.badgeLabel, "Analysis only");
  assert.match(t.userMessage, /operator limited your account to demo/);
});

test("a symbol off the operator's instruments or switched off in the trader's limits is not allowed", async () => {
  limits = async () => ({ ...OPEN_LIMITS, allowedSymbols: ["GBPUSD"] });
  const off = await getSymbolTradability("EURUSD", 1);
  assert.equal(off.mt5Tradable, "no");
  assert.equal(off.badgeLabel, "Analysis only");
  assert.match(off.userMessage, /not on the instruments your operator allowed/);

  limits = async () => ({ ...OPEN_LIMITS, symbolLimits: { EURUSD: { maxLots: null, blocked: true } } });
  const blocked = await getSymbolTradability("eurusd", 1);
  assert.equal(blocked.mt5Tradable, "no");
  assert.match(blocked.userMessage, /switched off in your risk limits/);
});

test("risk limits that could not be read leave tradability unverified, never allowed", async () => {
  limits = async () => { throw new Error("db offline"); };
  const t = await getSymbolTradability("EURUSD", 1);
  assert.equal(t.mt5Tradable, "unknown");
  assert.equal(t.badgeLabel, "Tradability not verified");
  assert.equal(t.liveExecutionAllowed, false);
  assert.match(t.userMessage, /risk limits could not be loaded/);
});

test("governance users: the governance lists decide, and the live market list is not named", async () => {
  // The pipeline does not read the live market list under governance, so a
  // symbol off that list is not "refused because it is not on your list".
  settings = async () => ({ allowedSymbols: ["GBPUSD"] });
  governance = async () => ({ ...NORMAL_USER, isPrivileged: true, ownerLiveControlMode: true });
  const open = await getSymbolTradability("EURUSD", 1);
  assert.equal(open.mt5Tradable, "yes");
  assert.equal(open.badgeLabel, "Allowed for MT5 live");
  assert.doesNotMatch(open.userMessage, /live market list/);
  assert.match(open.userMessage, /governance/);

  governance = async () => ({ ...NORMAL_USER, isPrivileged: true, ownerLiveControlMode: true, blockedSymbols: ["EURUSD"] });
  const blocked = await getSymbolTradability("EURUSD", 1);
  assert.equal(blocked.mt5Tradable, "no");
  assert.equal(blocked.badgeLabel, "Analysis only");
  assert.match(blocked.userMessage, /governance blocklist/);
  assert.doesNotMatch(blocked.userMessage, /live market list/);

  governance = async () => ({ ...NORMAL_USER, isPrivileged: true, ownerLiveControlMode: true, enforceSymbolAllowlist: true, allowedSymbols: ["GBPUSD"] });
  const offAllow = await getSymbolTradability("EURUSD", 1);
  assert.equal(offAllow.mt5Tradable, "no");
  assert.match(offAllow.userMessage, /governance symbol allowlist/);
});

test("governance that could not be read leaves tradability unverified", async () => {
  governance = async () => { throw new Error("db offline"); };
  const t = await getSymbolTradability("EURUSD", 1);
  assert.equal(t.mt5Tradable, "unknown");
  assert.equal(t.liveExecutionAllowed, false);
  assert.match(t.userMessage, /could not be loaded/);
});

test("the pipeline's synthetic-floor inputs do not depend on the new reads", async () => {
  limits = async () => { throw new Error("db offline"); };
  governance = async () => { throw new Error("db offline"); };
  const v = await getSymbolTradability("V75", 1);
  assert.equal(v.assetClass, "synthetic");
  assert.equal(v.dataProvider, "deriv");
});

// The live pipeline's synthetic floor refuses every synthetic order unless the
// account has the owner-unrestricted risk profile, the master broker is Deriv
// and the symbol has a live tick — none of which this label reads. Under
// governance the live market list is not read either, so a governance user
// with V75 off their own list was shown a green "Allowed for MT5 live" with
// submit enabled, although an ADMIN without that profile is always refused.
test("governance user, synthetic not on their own live list: never 'yes' and submit stays off", async () => {
  settings = async () => ({ allowedSymbols: ["EURUSD"] });
  governance = async () => ({ ...NORMAL_USER, isPrivileged: true, ownerLiveControlMode: true });
  assert.equal(isApprovedArxMarket("V75"), true, "fixture: V75 is an ARX Focus market");
  const t = await getSymbolTradability("V75", 1);
  assert.notEqual(t.mt5Tradable, "yes");
  assert.equal(t.liveExecutionAllowed, false);
  assert.notEqual(t.badgeLabel, "Allowed for MT5 live");
  assert.equal(t.mt5Tradable, "unknown");
  assert.equal(t.badgeLabel, "Tradability not verified");
  assert.match(t.userMessage, /synthetic index/);
  assert.match(t.userMessage, /owner-unrestricted risk profile/);
  assert.match(t.userMessage, /Deriv/);
  assert.match(t.userMessage, /live tick/);
  // The pipeline does not read the live market list under governance.
  assert.doesNotMatch(t.userMessage, /live market list/);
  // The floor's inputs are unchanged.
  assert.equal(t.assetClass, "synthetic");
  assert.equal(t.dataProvider, "deriv");

  // With no list of their own (the default list, which holds no synthetics) the same.
  settings = async () => ({ allowedSymbols: null });
  const d = await getSymbolTradability("V75", 1);
  assert.equal(d.mt5Tradable, "unknown");
  assert.equal(d.liveExecutionAllowed, false);
});

test("an allowed synthetic says the synthetic-index requirements were not checked", async () => {
  settings = async () => ({ allowedSymbols: ["V75"] });
  const t = await getSymbolTradability("V75", 1);
  assert.equal(t.mt5Tradable, "yes");
  assert.match(t.userMessage, /owner-unrestricted risk profile, a Deriv master broker and a live tick/);
  assert.match(t.userMessage, /only when an order is submitted/);
});
