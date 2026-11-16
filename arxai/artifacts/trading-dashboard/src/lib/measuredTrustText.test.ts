import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { measuredTrustText, type MeasuredTrust } from "./measuredTrustText";

// The admin Agent Ecosystem page shows MEASURED trust (what drives influence)
// and its reason; registry scores are labelled as not validated.

const m = (o: Partial<MeasuredTrust>): MeasuredTrust => ({
  status: "unmeasured", n: 0, influence: 0, trustScore: 50, basis: "no_scored_record:n=0", effectiveAuthorityWeight: 0, ...o,
});

describe("measuredTrustText", () => {
  it("states the reason for an agent with no replayable record", () => {
    const t = measuredTrustText(m({ basis: "no_replayable_record:a language-model desk read, not a deterministic function of market data" }));
    expect(t).toBe("No graded record: a language-model desk read, not a deterministic function of market data.");
  });
  it("says a measured record without skill earns influence 0, with its N", () => {
    expect(measuredTrustText(m({ status: "measured", n: 11336, basis: "no_out_of_sample_skill:lower95=-0.000089" })))
      .toBe("Measured on N=11336: no out-of-sample skill over the base rate, so influence 0.");
  });
  it("reports measured skill with its influence", () => {
    expect(measuredTrustText(m({ status: "measured", n: 7439, influence: 0.113, basis: "out_of_sample_skill:lower95=0.002252" })))
      .toBe("Measured on N=7439: out-of-sample skill, influence 0.113.");
  });
  it("covers a missing payload and small records", () => {
    expect(measuredTrustText(undefined)).toBe("Not reported by the server.");
    expect(measuredTrustText(m({ n: 12, basis: "record_too_small_for_skill_test:n=12<100" }))).toMatch(/too small.*N=12/);
  });
});

describe("admin Agent Ecosystem page", () => {
  const src = readFileSync(resolve(__dirname, "../pages/admin/agent-ecosystem.tsx"), "utf8");
  it("shows measured influence and N in the registry table, not the registry trust", () => {
    expect(src).toContain("Measured influence");
    expect(src).not.toMatch(/<th[^>]*>Trust<\/th>/);
    expect(src).toContain("agent-influence-");
  });
  it("labels registry scores as not driving influence", () => {
    expect(src).toContain("Registry scores below are not validated against outcomes and do not drive influence.");
    expect(src).toContain('"Registry trust"');
  });
});
