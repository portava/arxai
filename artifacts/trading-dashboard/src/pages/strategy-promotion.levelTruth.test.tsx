// Regression: Strategy Promotion relabelled the server level PAPER_APPROVED as
// "DEMO_APPROVED". DEMO_APPROVED is a separate, higher gate (50 tracked,
// expectancy > 0, calibration WELL/UNDER), so the client upgraded the server's
// claim and the row read "DEMO_APPROVED" next to "eligible → DEMO_APPROVED".
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";

vi.mock("@/hooks/useProductRole", () => ({
  useProductRole: () => ({ role: "ADMIN", isAdmin: true, isInvestor: false, isTrader: false, isLoading: false, homePath: "/" }),
}));

import StrategyPromotion from "./strategy-promotion";

const stats = { sample: 30, tracked: 25, winRate: 0.56, avgR: 0.4, drawdownR: 2, rgViolations: 0, expectancy: 0.2 };

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Strategy Promotion shows the server's level", () => {
  it("a PAPER_APPROVED strategy is not shown as DEMO_APPROVED", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      strategies: [{ strategy: "X", level: "PAPER_APPROVED", eligibleFor: "DEMO_APPROVED", demotion: null, updatedAt: "2026-10-28T10:00:00Z", lastReason: "", stats }],
      demotionSuggestions: [],
    }), { status: 200 })));
    render(<StrategyPromotion />);
    await waitFor(() => expect(screen.getByText("X")).toBeTruthy());
    expect(screen.getByText("PAPER_APPROVED")).toBeTruthy();
    // The only DEMO_APPROVED text is the eligibility badge, not the level.
    const demo = screen.queryAllByText(/DEMO_APPROVED/);
    expect(demo).toHaveLength(1);
    expect(demo[0].textContent).toMatch(/eligible/);
  });
});
