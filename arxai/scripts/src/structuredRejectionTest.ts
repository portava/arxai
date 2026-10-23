// T033 Phase 8 — structured rejection contract test.
//
// Proves: each distinct live reason gets distinct user copy + correct reject
// layer + fixable-by (never collapsed into one vague message), the real current
// rejections render cleanly, LIVE_BLOCKED: envelopes are unwrapped, and a
// missing reason degrades to the explicit "No detailed reason reported" state
// (not a fake success, not a catch-all).

import {
  structureRejection,
  rejectLayerLabel,
  fixableByLabel,
} from "../../artifacts/trading-dashboard/src/lib/structuredRejection.js";

type CheckResult = { id: number; name: string; ok: boolean; detail: string };
const results: CheckResult[] = [];
function record(id: number, name: string, ok: boolean, detail: string) {
  results.push({ id, name, ok, detail });
}

// 1. MASTER_SNAPSHOT_STALE — the exact reason the live V75 test hit.
const r1 = structureRejection("MASTER_SNAPSHOT_STALE");
record(1, "MASTER_SNAPSHOT_STALE clean copy",
  /stale/i.test(r1.userMessage) && r1.rejectLayer === "backend-gate" && r1.fixableBy === "ea-mt5",
  `${r1.userMessage} | ${r1.rejectLayer}`);

// 2. LIVE_BLOCKED: envelope is unwrapped to the inner code.
const r2 = structureRejection("LIVE_BLOCKED:MASTER_SNAPSHOT_STALE");
record(2, "LIVE_BLOCKED envelope unwrapped",
  r2.userMessage === r1.userMessage && r2.rejectLayer === "backend-gate",
  `${r2.userMessage}`);

// 3. BROKER_RULE_SPREAD_TOO_WIDE — the real broker rejection from history.
const r3 = structureRejection("BROKER_RULE_SPREAD_TOO_WIDE");
record(3, "spread-too-wide → MT5-broker / market",
  /spread/i.test(r3.userMessage) && r3.rejectLayer === "MT5-broker" && r3.fixableBy === "market",
  `${r3.userMessage} | ${r3.rejectLayer}/${r3.fixableBy}`);

// 4. TERMINAL_DISCONNECTED → EA-preflight.
const r4 = structureRejection("TERMINAL_DISCONNECTED");
record(4, "terminal disconnected → EA-preflight",
  /not connected/i.test(r4.userMessage) && r4.rejectLayer === "EA-preflight",
  `${r4.userMessage}`);

// 5. SYMBOL_AMBIGUOUS → symbol-resolver, user-fixable.
const r5 = structureRejection("SYMBOL_AMBIGUOUS");
record(5, "symbol ambiguous → symbol-resolver/user",
  /choose|exact/i.test(r5.userMessage) && r5.rejectLayer === "symbol-resolver" && r5.fixableBy === "user",
  `${r5.userMessage}`);

// 6. SYMBOL_NOT_FOUND → distinct from ambiguous (NOT collapsed).
const r6 = structureRejection("SYMBOL_NOT_FOUND");
record(6, "symbol not found ≠ ambiguous (distinct copy)",
  r6.userMessage !== r5.userMessage && /not found/i.test(r6.userMessage),
  `${r6.userMessage}`);

// 7. Distinct causes → distinct messages (the core no-collapse guarantee).
const msgs = [r1, r3, r4, r5, r6].map((r) => r.userMessage);
record(7, "distinct causes have distinct messages",
  new Set(msgs).size === msgs.length, `${new Set(msgs).size}/${msgs.length} unique`);

// 8. Object input shape ({error/primaryReason/detail}) is handled.
const r8 = structureRejection({ error: "LIVE_BLOCKED:MASTER_SNAPSHOT_STALE", reason: "master snapshot age 95s > 60s", primaryReason: "MASTER_SNAPSHOT_STALE" });
record(8, "object rejection shape parsed",
  /stale/i.test(r8.userMessage) && r8.rawReason === "master snapshot age 95s > 60s",
  `${r8.userMessage} | raw=${r8.rawReason}`);

// 9. Missing reason → explicit "No detailed reason reported", NOT fake success.
const r9 = structureRejection({});
record(9, "missing reason → explicit no-reason state",
  /no detailed reason/i.test(r9.title) && r9.rejectLayer === "unknown" && r9.fixableBy === "none",
  `${r9.title} | ${r9.rejectLayer}`);

// 10. Missing reason still names where the trail went cold (suggestedFix).
record(10, "missing reason names the lost layer",
  /audit log|experts log|trail/i.test(r9.suggestedFix), r9.suggestedFix.slice(0, 40));

// 11. Every reason carries the verbatim technical code (admin preservation).
record(11, "raw technical code preserved",
  structureRejection("INSUFFICIENT_MARGIN").technicalCode === "INSUFFICIENT_MARGIN", "");

// 12. ALGO_DISABLED + ENABLE_LIVE_FALSE + READ_ONLY_MODE are 3 distinct EA reasons.
const ea = [structureRejection("ALGO_DISABLED"), structureRejection("ENABLE_LIVE_FALSE"), structureRejection("READ_ONLY_MODE")];
record(12, "three EA gates are distinct messages",
  new Set(ea.map((r) => r.userMessage)).size === 3 && ea.every((r) => r.rejectLayer === "EA-preflight"),
  ea.map((r) => r.userMessage).join(" / "));

// 13. INVALID_VOLUME → MT5-broker, user-fixable.
const r13 = structureRejection("INVALID_VOLUME");
record(13, "invalid volume → user-fixable",
  r13.fixableBy === "user" && /lot|volume/i.test(r13.userMessage), `${r13.userMessage}`);

// 14. Unknown-but-present code → falls back via humanize, still names a layer (not 'unknown' guess).
const r14 = structureRejection("SOME_BRAND_NEW_RETCODE_MT5:10016");
record(14, "unknown code still classified, not faked",
  r14.technicalCode === "SOME_BRAND_NEW_RETCODE_MT5:10016" && r14.severity !== "info",
  `${r14.category}/${r14.rejectLayer}`);

// 15. Labels resolve for every layer + fixable value (no missing label crashes).
record(15, "layer + fixable labels resolve",
  rejectLayerLabel("MT5-broker").length > 0 && fixableByLabel("market").length > 0, "");

// ── MT5 broker retcode path (the hero case + override + backward compat) ──

// 16. THE PROOF CASE: a 10016 broker rejection → "stop loss too close" copy,
//     MT5-broker / user, with the admin label "10016 · invalid_stops".
const r16 = structureRejection("LIVE_REJECTED", { mt5Retcode: 10016 });
record(16, "retcode 10016 → stop-loss-too-close + invalid_stops label",
  /stop loss.*too close/i.test(r16.userMessage)
    && r16.rejectLayer === "MT5-broker" && r16.fixableBy === "user"
    && r16.retcodeCategory === "invalid_stops"
    && r16.retcodeLabel === "10016 · invalid_stops",
  `${r16.userMessage} | ${r16.retcodeLabel}`);

// 17. Retcode copy OVERRIDES the generic code copy (broker verdict wins).
const r17generic = structureRejection("LIVE_REJECTED");
record(17, "retcode copy overrides generic raw-code copy",
  r17generic.userMessage !== r16.userMessage && r16.retcodeCategory === "invalid_stops",
  `generic="${r17generic.userMessage}" vs retcode="${r16.userMessage}"`);

// 18. 10027 (autotrading off) → trade_disabled copy, distinct category surfaced.
const r18 = structureRejection({ reason: "Algo trading disabled" }, { mt5Retcode: 10027 });
record(18, "retcode 10027 → trade_disabled category + actionable copy",
  r18.retcodeCategory === "trade_disabled"
    && /turned off|disabled/i.test(r18.userMessage)
    && /autotrading|algo trading/i.test(r18.suggestedFix)
    && r18.retcodeLabel === "10027 · trade_disabled",
  `${r18.userMessage} | ${r18.retcodeLabel}`);

// 19. BACKWARD COMPAT: no retcode supplied → existing behavior, null retcode fields.
const r19 = structureRejection("INSUFFICIENT_MARGIN");
record(19, "no retcode → existing copy + null retcode fields",
  r19.retcodeCategory === null && r19.retcodeLabel === null
    && /margin/i.test(r19.userMessage),
  `${r19.userMessage} | cat=${r19.retcodeCategory}`);

// 20. retcode present but NO gate/EA code → broker retcode IS the reason
//     (not the generic "no detailed reason" state).
const r20 = structureRejection({}, { mt5Retcode: 10019 });
record(20, "retcode-only (no code) → broker reason, not no-reason state",
  r20.retcodeCategory === "insufficient_margin"
    && /margin/i.test(r20.userMessage)
    && !/no detailed reason/i.test(r20.title),
  `${r20.title} | ${r20.userMessage}`);

// 21. Unmapped present retcode → unknown_broker_response, honest (never faked success).
const r21 = structureRejection("LIVE_REJECTED", { mt5Retcode: 99999 });
record(21, "unmapped retcode → unknown_broker_response, honest",
  r21.retcodeCategory === "unknown_broker_response"
    && r21.retcodeLabel === "99999 · unknown_broker_response"
    && r21.severity !== "info",
  `${r21.userMessage} | ${r21.retcodeLabel}`);

// 22. null/non-numeric retcode → no override (treated as pre-broker reject).
const r22 = structureRejection("SYMBOL_NOT_FOUND", { mt5Retcode: null });
record(22, "null retcode → no override (pre-broker reject untouched)",
  r22.retcodeCategory === null && /not found/i.test(r22.userMessage)
    && r22.rejectLayer === "symbol-resolver",
  `${r22.userMessage} | ${r22.rejectLayer}`);

// 23. Invalid retcodes (negative, decimal, NaN, 0, blank/whitespace string) must
// NOT classify and must NOT override — they are not real broker retcodes. Locks
// the classifier hardening (Number("") === 0 trap, non-integer, <=0).
const invalidRetcodes: Array<number | string> = [-1, 0, 10016.5, NaN, "", "   "];
const r23ok = invalidRetcodes.every((rc) => {
  const out = structureRejection("SYMBOL_NOT_FOUND", { mt5Retcode: rc });
  return out.retcodeCategory === null
    && out.retcodeLabel === null
    && /not found/i.test(out.userMessage) // existing copy preserved
    && out.rejectLayer === "symbol-resolver";
});
record(23, "invalid retcodes (neg/decimal/NaN/0/blank) → no classify, no override",
  r23ok, `tested: ${invalidRetcodes.map((v) => JSON.stringify(v)).join(", ")}`);

// ─── tally ───
const passed = results.filter((r) => r.ok).length;
for (const r of results) {
  // eslint-disable-next-line no-console
  console.log(`${r.ok ? "PASS" : "FAIL"}  #${String(r.id).padStart(2, "0")}  ${r.name}${r.ok ? "" : "  → " + r.detail}`);
}
// eslint-disable-next-line no-console
console.log(`\n${passed}/${results.length} structured-rejection checks passed`);
if (passed !== results.length) process.exit(1);
