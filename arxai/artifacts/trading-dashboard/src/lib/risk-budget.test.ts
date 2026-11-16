import { describe, expect, it } from "vitest";
import { riskUtilizationPercent } from "./risk-budget";

describe("account-scoped risk utilization", () => {
  it("calculates utilization from the current daily risk budget only", () => {
    expect(riskUtilizationPercent({ dailyRiskLimit: 240, dailyRiskUsed: 63.6 })).toBe(26.5);
    expect(riskUtilizationPercent({ dailyRiskLimit: 0, dailyRiskUsed: 20 })).toBeNull();
    expect(riskUtilizationPercent({ dailyRiskLimit: null, dailyRiskUsed: 20 })).toBeNull();
  });
});
