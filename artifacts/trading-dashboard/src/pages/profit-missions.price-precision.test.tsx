// Mission proposal / draft rows printed prices with toLocaleString(max 5 dp):
// 1.08500 → "1.085", 2380.5 → "2,380.5" — dropping real broker digits and
// adding thousands separators no other board uses. They must follow the one
// instrument display rule (no grouping, at least the symbol's digits).
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ProposalRow, formatMissionPrice } from "./profit-missions";
import type { MissionProposal } from "@workspace/api-client-react";

function proposal(over: Partial<MissionProposal>): MissionProposal {
  return {
    id: 1, proposalId: "p1", missionId: 1, agentKey: "trend" as MissionProposal["agentKey"],
    symbol: "EURUSD", timeframe: "M15", direction: "BUY" as MissionProposal["direction"],
    confidence: 64, urgency: "normal" as MissionProposal["urgency"],
    entryPlan: { entryPrice: 1.0842 } as MissionProposal["entryPlan"],
    riskPlan: { stopLoss: 1.085, takeProfit: 1.09 } as MissionProposal["riskPlan"],
    warnings: [], status: "proposed" as MissionProposal["status"], createdAt: "2026-10-28T10:00:00Z",
    ...over,
  } as MissionProposal;
}

afterEach(cleanup);

describe("mission price precision", () => {
  it("EURUSD levels keep the pair's 5 digits", () => {
    render(<ul><ProposalRow p={proposal({})} /></ul>);
    const row = screen.getByTestId("proposal-p1").textContent ?? "";
    expect(row).toContain("1.08420");
    expect(row).toContain("1.08500 / 1.09000");
    expect(row).not.toMatch(/1\.085 \//);
  });

  it("prices ≥ 1000 are not grouped and keep their digits", () => {
    render(<ul><ProposalRow p={proposal({
      symbol: "XAUUSD",
      entryPlan: { entryPrice: 2380.5 } as MissionProposal["entryPlan"],
      riskPlan: { stopLoss: 2371.25, takeProfit: 2399 } as MissionProposal["riskPlan"],
    })} /></ul>);
    const row = screen.getByTestId("proposal-p1").textContent ?? "";
    expect(row).toContain("2380.50");
    expect(row).toContain("2371.25 / 2399.00");
    expect(row).not.toContain("2,380");
  });

  it("formatMissionPrice: missing is a dash; extra quoted digits are never rounded away", () => {
    expect(formatMissionPrice("EURUSD", null, [])).toBe("—");
    expect(formatMissionPrice("FX:USDJPY", 151.2, [151.2])).toBe("151.200");
    expect(formatMissionPrice("EURUSD", 1.085123, [1.085123])).toBe("1.085123");
  });
});
