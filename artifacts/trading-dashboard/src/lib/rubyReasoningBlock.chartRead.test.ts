import { describe, expect, it } from "vitest";
import { buildReasoningFromChartRead } from "./rubyReasoningBlock";
import type { ChartRead } from "./rubyReadPanelState";

const base: ChartRead = { bias: "Bullish", confidence: "Medium", dataQuality: "ok", supportZone: "101", resistanceZone: "105", why: "Reported rising structure", readLayer: "FULL", liveSetupWithheld: false };
const build = (read: ChartRead, extra = {}) => buildReasoningFromChartRead({ read, symbol: "V25_1S", timeframe: "M1", ...extra });

describe("chart-read reasoning preserves the evidence actually supplied", () => {
  it("does not present confidence as momentum evidence", () => {
    const evidence = build(base).evidence;
    expect(evidence.momentum).toMatch(/momentum.*not assessed/i);
    expect(evidence.momentum).not.toMatch(/medium/i);
  });
  it("distinguishes missing response evidence from absence on the visible chart", () => {
    const evidence = build(base).evidence;
    expect(evidence.pattern).toMatch(/no qualified .* evidence.*supplied.*assessment/i);
    expect(evidence.trendline).toMatch(/no qualified .* evidence.*supplied.*assessment/i);
    expect(evidence.trendline).toMatch(/chart/i);
  });
  it("uses actual pattern and trendline notes without dropping their context restrictions", () => {
    const result = build({ ...base, readLayer: "STRUCTURAL_ONLY", patternRead: { patternNote: "Developing double top", patternStatus: "forming", patternConditional: true, patternContextOnly: true }, trendlineRead: { trendlineNote: "Ascending support tested twice", trendlineStatus: "confirmed", trendlineConditional: true, trendlineContextOnly: true } } as ChartRead);
    expect(result.evidence.pattern).toContain("Developing double top");
    expect(result.evidence.trendline).toContain("Ascending support tested twice");
    expect(result.evidence.pattern).toMatch(/context only/i);
    expect(result.evidence.trendline).toMatch(/conditional/i);
    expect(result.decision).toMatch(/conditional/i);
  });
  it("does not promote malformed or unqualified child notes", () => {
    const result = build({ ...base, patternRead: { patternNote: "Buy now" }, trendlineRead: { trendlineNote: 123, trendlineStatus: "confirmed", trendlineConditional: false, trendlineContextOnly: false } } as unknown as ChartRead);
    expect(result.evidence.pattern).toMatch(/No qualified .* evidence was supplied/);
    expect(result.evidence.trendline).toMatch(/No qualified .* evidence was supplied/);
    expect(result.evidence.pattern).not.toContain("Buy now");
  });
  it("does not let child annotations override a blocked parent read", () => {
    const result = build({ ...base, gated: true, patternRead: { patternNote: "Confirmed reversal", patternStatus: "CONFIRMED", patternConditional: false, patternContextOnly: false }, trendlineRead: { trendlineNote: "Ascending support", trendlineStatus: "confirmed", trendlineConditional: false, trendlineContextOnly: false } } as ChartRead);
    expect(result.evidence.pattern).not.toContain("Confirmed reversal");
    expect(result.evidence.trendline).not.toContain("Ascending support");
    expect(result.decision).toMatch(/^WAIT/);
  });
  it.each(["UNKNOWN_INTERNAL_STATUS", "constructor", "__proto__"])("does not display an unsupported note status: %s", trendlineStatus => {
    const result = build({ ...base, trendlineRead: { trendlineNote: "A line", trendlineStatus, trendlineConditional: false, trendlineContextOnly: false } });
    expect(result.evidence.trendline).toMatch(/No qualified trendline evidence/);
    expect(result.evidence.trendline).not.toContain(trendlineStatus);
  });
  it("does not infer live freshness from absent downgrade flags or FULL alone", () => {
    expect(build(base).evidence.feedData).not.toMatch(/live read|live feed confirmed/i);
    expect(build({}).evidence.feedData).toMatch(/not.*confirm|not.*establish/i);
  });
  it.each([{ liveSetupWithheld: true }, { readLayer: "STRUCTURAL_ONLY" as const }, { canShowLiveTradeSetup: false }])("respects server setup withholding even without caller flags: %j", flags => {
    const result = build({ ...base, ...flags, blockedReason: "Exact levels withheld: insufficient closed bars" });
    expect(result.decision).toMatch(/conditional|wait/i);
    expect(result.evidence.feedData).toContain("insufficient closed bars");
    expect(result.evidence.supportResistance).toMatch(/exact.*withheld/i);
    expect(result.evidence.feedData).not.toMatch(/live read/i);
  });
  it.each([{ gated: true }, { dataQuality: "insufficient" as const }, { readLayer: "INSUFFICIENT" as const }])("does not leak old levels/direction through a blocked payload: %j", flags => {
    const result = build({ ...base, ...flags, blockedReason: "Too few confirmed bars", buyCondition: "Buy at 102", invalidation: "Exit 99" });
    expect(result.decision).toMatch(/^WAIT/);
    expect(result.why).toContain("Too few confirmed bars");
    expect(result.evidence.structure).not.toContain("Bullish");
    expect(result.traderTest).not.toMatch(/101|105/);
    expect(result.confirmation).not.toContain("102");
    expect(result.invalidation).not.toContain("99");
  });
  it("keeps supplied structural zones when only the exact setup is withheld", () => {
    const result = build({ ...base, liveSetupWithheld: true });
    expect(result.evidence.supportResistance).toContain("101");
    expect(result.evidence.supportResistance).toContain("105");
    expect(result.evidence.supportResistance).toMatch(/exact.*withheld/i);
  });
  it("retains caller feed restrictions even when the payload says FULL", () => {
    const result = build(base, { feedNotConfirmed: true, reason: "Source is delayed" });
    expect(result.decision).toMatch(/^WAIT/);
    expect(result.evidence.feedData).toContain("Source is delayed");
    expect(result.traderTest).not.toMatch(/101|105/);
    expect(result.why).not.toContain("Reported rising structure");
    expect(result.evidence.structure).not.toContain("Bullish");
    expect(result.why).toContain("Source is delayed");
  });
  it.each([{ gated: true }, { feedNotConfirmed: true }])("withholds old risk claims under hard restriction %j", flags => {
    const result = build({ ...base, gated: "gated" in flags ? flags.gated : false, riskNote: "Strong profitable edge", cautions: ["Momentum aligned"] }, { ...flags, reason: "UTC clock unverified" });
    expect(result.evidence.risk).toContain("UTC clock unverified");
    expect(result.evidence.risk).not.toMatch(/profitable|Momentum aligned/);
  });
  it("keeps structural caution and a separate clock limitation without a hard block", () => {
    const result = build({ ...base, liveSetupWithheld: true, riskNote: "Structure can fail" }, { structuralOnly: true, reason: "Owner setup policy pending", feedLimitation: "UTC clock unverified" });
    expect(result.decision).toMatch(/Conditional BUY/);
    expect(result.evidence.structure).toContain("Bullish");
    expect(result.evidence.risk).toContain("Structure can fail");
    expect(result.evidence.feedData).toContain("Owner setup policy pending");
    expect(result.evidence.feedData).toContain("UTC clock unverified");
  });
});
