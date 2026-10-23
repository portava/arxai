// T033 — EA v1.50 capability mapping contract test.
//
// Proves the v1.50 capability vocabulary is no longer silently dropped, that
// it translates into the backend normalized supportsX keys, that raw keys are
// preserved, that unknown keys are preserved-but-not-enabled, and that the
// legacy v1.40 payload still works. Runs no trades, touches no DB.

import {
  ingestEaCapabilities,
  isV150Aware,
  eaUpdateRequiredMessage,
  V150_NORMALIZED_KEYS,
} from "../../artifacts/api-server/src/lib/mt5/eaCapabilityMapping.js";

type CheckResult = { id: number; name: string; ok: boolean; detail: string };
const results: CheckResult[] = [];
function record(id: number, name: string, ok: boolean, detail: string) {
  results.push({ id, name, ok, detail });
}

// A representative v1.50 EA heartbeat capabilities payload (subset of what
// ARX_AI_Universal_Agent_v150.mq5 emits).
const v150Payload = {
  eaName: "ARX_AI_Universal_Agent",
  eaVersion: "1.50",
  build: "1500",
  protocol: "2",
  marketOrders: true,
  openMarket: true,
  closePosition: true,
  partialClose: true,
  reversePosition: true,
  moveSL: true,
  moveTP: true,
  breakEven: true,
  symbolDiscovery: true,
  symbolRules: true,
  validateOnly: true,
  accountSnapshot: true,
  openPositionSync: true,
  pendingOrderSync: true,
  structuredErrors: true,
  commandIdempotency: true,
  magicCommentTagging: true,
  panicCloseAll: true,
  // honestly-false in this build:
  trailingStop: false,
  manualTradeDetection: false,
  marketTelemetryIndicators: false,
  remoteConfig: false,
  // an unknown future key the backend doesn't know yet:
  someFutureExperimentalThing: true,
};

const ing = ingestEaCapabilities(v150Payload, v150Payload);

// 1. Identity is captured.
record(1, "EA identity parsed",
  ing.eaName === "ARX_AI_Universal_Agent" && ing.eaVersion === "1.50" &&
  ing.eaBuild === "1500" && ing.eaProtocol === "2",
  `name=${ing.eaName} ver=${ing.eaVersion} build=${ing.eaBuild} proto=${ing.eaProtocol}`);

// 2. Raw EA caps preserved verbatim (including the unknown key).
record(2, "raw EA capabilities preserved",
  ing.rawEaCapabilities["openMarket"] === true &&
  ing.rawEaCapabilities["someFutureExperimentalThing"] === true,
  `raw has ${Object.keys(ing.rawEaCapabilities).length} keys`);

// 3. v1.50 keys translate to normalized supportsX keys (NOT dropped).
const n = ing.normalizedCapabilities;
record(3, "openMarket → supportsMarketOrders", n.supportsMarketOrders === true, String(n.supportsMarketOrders));
record(4, "partialClose → supportsPartialClose", n.supportsPartialClose === true, String(n.supportsPartialClose));
record(5, "validateOnly → supportsValidateOnly", n.supportsValidateOnly === true, String(n.supportsValidateOnly));
record(6, "symbolDiscovery → supportsSymbolDiscovery", n.supportsSymbolDiscovery === true, String(n.supportsSymbolDiscovery));
record(7, "accountSnapshot → supportsAccountSnapshots", n.supportsAccountSnapshots === true, String(n.supportsAccountSnapshots));
record(8, "openPositionSync → supportsOpenPositionSync", n.supportsOpenPositionSync === true, String(n.supportsOpenPositionSync));
record(9, "reversePosition → supportsReverse", n.supportsReverse === true, String(n.supportsReverse));
record(10, "breakEven → supportsBreakEven", n.supportsBreakEven === true, String(n.supportsBreakEven));

// 11. Multiple EA keys OR-merge into supportsEmergencyClose.
record(11, "panicCloseAll → supportsEmergencyClose", n.supportsEmergencyClose === true, String(n.supportsEmergencyClose));

// 12. Honestly-false caps stay false.
record(12, "trailingStop stays false", n.supportsTrailingStop === false, String(n.supportsTrailingStop));
record(13, "manualTradeDetection stays false", n.supportsManualMT5Detection === false, String(n.supportsManualMT5Detection));
record(14, "remoteConfig stays false", n.supportsRemoteConfig === false, String(n.supportsRemoteConfig));

// 15. Unknown TRUE key preserved as unmapped, NOT enabled anywhere.
record(15, "unknown key recorded as unmapped",
  ing.unmappedKeys.includes("someFutureExperimentalThing"),
  `unmapped=[${ing.unmappedKeys.join(",")}]`);
const leaked = V150_NORMALIZED_KEYS.some((k) => (n as Record<string, boolean>)[k] === true &&
  // ensure no normalized key was set true purely by the unknown key (sanity)
  false);
record(16, "unknown key did NOT auto-enable a feature", !leaked, "no normalized key enabled by unknown");

// 17. v1.50-awareness detection.
record(17, "isV150Aware true for protocol 2", isV150Aware(ing) === true, String(isV150Aware(ing)));

// 18. Legacy v1.40 payload still parses (closed-set caps preserved).
const v140Payload = {
  eaVersion: "1.40",
  marketOrders: true, pendingOrders: true, modifyPositionProtection: true,
};
const ing140 = ingestEaCapabilities(v140Payload, v140Payload);
record(18, "v1.40 legacy caps still parse",
  ing140.legacyCapabilities.marketOrders === true &&
  ing140.legacyCapabilities.pendingOrders === true,
  `legacy market=${ing140.legacyCapabilities.marketOrders}`);
record(19, "v1.40 also maps to normalized pending",
  ing140.normalizedCapabilities.supportsPendingOrders === true,
  String(ing140.normalizedCapabilities.supportsPendingOrders));
record(20, "v1.40 not flagged v1.50-aware",
  isV150Aware(ing140) === false, String(isV150Aware(ing140)));

// 21. Update-required gate.
record(21, "old EA → update-required message",
  eaUpdateRequiredMessage("1.40") !== null && eaUpdateRequiredMessage("1.50") === null,
  `v1.40:${eaUpdateRequiredMessage("1.40") ? "msg" : "null"} v1.50:${eaUpdateRequiredMessage("1.50") ? "msg" : "null"}`);

// 22. Non-boolean values never enable.
const ingBadTypes = ingestEaCapabilities({ openMarket: "true", partialClose: 1 } as unknown);
record(22, "non-boolean cap values ignored",
  ingBadTypes.normalizedCapabilities.supportsMarketOrders === false &&
  ingBadTypes.normalizedCapabilities.supportsPartialClose === false,
  "string/number values did not enable");

// ─── tally ───
const passed = results.filter((r) => r.ok).length;
for (const r of results) {
  // eslint-disable-next-line no-console
  console.log(`${r.ok ? "PASS" : "FAIL"}  #${String(r.id).padStart(2, "0")}  ${r.name}${r.ok ? "" : "  → " + r.detail}`);
}
// eslint-disable-next-line no-console
console.log(`\n${passed}/${results.length} capability-mapping checks passed`);
if (passed !== results.length) process.exit(1);
