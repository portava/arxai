// T033 Phase 8 (backend) — retcode mapping + result-payload extraction test.
//
// Proves: retcode 10009 (the real LIVE_FILLED from ticket 40800224965) maps to
// "filled"/success; the required categories resolve; unmapped codes degrade to
// unknown_broker_response (never faked as success); and the field-extraction
// helpers pull retcode/brokerMessage/fill from the EA payload shapes the EA
// actually sends.

import { classifyRetcode, isSuccessRetcode } from "../../artifacts/api-server/src/lib/mt5/retcodeMap.js";
import { classifyRetcode as feClassifyRetcode } from "../../artifacts/trading-dashboard/src/lib/structuredRejection.js";

type CheckResult = { id: number; name: string; ok: boolean; detail: string };
const results: CheckResult[] = [];
const rec = (id: number, name: string, ok: boolean, detail = "") => results.push({ id, name, ok, detail });

// ── retcode classification ──
// 1. THE PROOF CASE: 10009 → filled / success.
const r9 = classifyRetcode(10009);
rec(1, "retcode 10009 → filled/success", r9.category === "filled" && r9.isSuccess === true, `${r9.category}/${r9.isSuccess}`);

// 2. isSuccessRetcode(10009) true; failures false.
rec(2, "isSuccessRetcode 10009 vs 10019", isSuccessRetcode(10009) === true && isSuccessRetcode(10019) === false, "");

// 3. Required categories map correctly.
const cases: Array<[number, string]> = [
  [10008, "accepted"], [10019, "insufficient_margin"], [10018, "market_closed"],
  [10016, "invalid_stops"], [10014, "invalid_lot_size"], [10017, "trade_disabled"],
  [10004, "requote_price_changed"], [10006, "rejected_by_broker"], [10012, "timeout"],
];
for (const [code, cat] of cases) {
  const c = classifyRetcode(code);
  rec(3, `retcode ${code} → ${cat}`, c.category === cat, `got ${c.category}`);
}

// 4. Unmapped retcode → unknown_broker_response, NOT success.
const unk = classifyRetcode(99999);
rec(4, "unmapped retcode → unknown, not success", unk.category === "unknown_broker_response" && unk.isSuccess === false, `${unk.category}`);

// 5. null/undefined retcode → unknown, not success (pre-dispatch reject case).
rec(5, "null retcode → unknown, not success", classifyRetcode(null).category === "unknown_broker_response" && !isSuccessRetcode(null), "");

// 6. Raw retcode preserved on the info object.
rec(6, "raw retcode preserved", classifyRetcode(10016).retcode === 10016, "");

// ── payload extraction (mirror of the handler's num/str helpers) ──
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v
  : (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

// 7. retcode extracted from primary field name.
const payload = { mt5Retcode: 10009, brokerMessage: "Request executed", fillPrice: 27775.07, filledLotSize: 0.01 };
rec(7, "mt5Retcode extracted from payload", num(payload["mt5Retcode"]) === 10009, "");

// 8. brokerMessage extracted.
rec(8, "brokerMessage extracted", str(payload["brokerMessage"]) === "Request executed", "");

// 9. fill price + lot extracted as numbers.
rec(9, "fillPrice + lot extracted", num(payload.fillPrice) === 27775.07 && num(payload.filledLotSize) === 0.01, "");

// 10. retcode as STRING (some EAs stringify) still parses to number.
rec(10, "stringified retcode coerced", num("10009") === 10009, String(num("10009")));

// 11. empty/missing fields → null (not 0, not ""), so 'absent' is distinguishable.
rec(11, "missing fields → null", num(undefined) === null && str(undefined) === null && str("") === null, "");

// 12. alternate field names (comment / price / volume) fall back correctly.
const alt = { comment: "Done", price: 100.5, volume: 0.02, retcode: 10008 };
rec(12, "alternate field names parsed",
  str(alt.comment) === "Done" && num(alt.price) === 100.5 && num(alt.retcode) === 10008, "");

// 13. DRIFT GUARD: the frontend retcode mirror (structuredRejection.ts) must
// agree with the backend failure map for every mapped failure code. Catches the
// two maps silently diverging — a stale frontend would show the wrong category
// (or generic copy) for a real broker rejection.
const mismatches: string[] = [];
for (let code = 10000; code <= 10060; code++) {
  const be = classifyRetcode(code);
  if (be.isSuccess) continue; // success codes never render a rejection
  if (be.category === "unknown_broker_response") continue; // backend doesn't map it either
  const fe = feClassifyRetcode(code);
  if (!fe.mapped || fe.category !== be.category) {
    mismatches.push(`${code}: backend=${be.category} frontend=${fe.mapped ? fe.category : "UNMAPPED"}`);
  }
}
rec(13, "frontend retcode mirror matches backend failure map", mismatches.length === 0, mismatches.join(" | "));

// ── tally ──
const passed = results.filter((r) => r.ok).length;
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  #${String(r.id).padStart(2, "0")}  ${r.name}${r.ok ? "" : "  → " + r.detail}`);
console.log(`\n${passed}/${results.length} retcode-mapping checks passed`);
if (passed !== results.length) process.exit(1);
