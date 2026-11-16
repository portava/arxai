import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import StrategyLab from "@/pages/strategy-lab";

// Regression: the page compared e.status === "completed" (lower case) while
// the service writes "COMPLETED" / "RUNNING" / "FAILED" / "PENDING". Every
// experiment therefore got the PENDING clock icon and aria-label
// "status: pending" while the visible text said COMPLETED or FAILED.

function stubExperiments(statuses: string[]) {
  const experiments = statuses.map((status, i) => ({
    experimentId: `exp_${i}`, title: `Experiment ${status}`, status, symbol: "EURUSD",
    resultSummary: {},
  }));
  global.fetch = vi.fn(() =>
    Promise.resolve({ ok: true, json: () => Promise.resolve({ experiments }) } as Response),
  ) as unknown as typeof fetch;
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Strategy Lab status pill", () => {
  it("labels each stored status with a matching accessible label", async () => {
    stubExperiments(["COMPLETED", "RUNNING", "FAILED", "PENDING"]);
    render(<StrategyLab />);
    const completed = await screen.findByText("COMPLETED");
    expect(completed.closest("[aria-label]")?.getAttribute("aria-label")).toBe("status: completed");
    expect(screen.getByText("RUNNING").closest("[aria-label]")?.getAttribute("aria-label")).toBe("status: running");
    expect(screen.getByText("FAILED").closest("[aria-label]")?.getAttribute("aria-label")).toBe("status: failed");
    expect(screen.getByText("PENDING").closest("[aria-label]")?.getAttribute("aria-label")).toBe("status: pending");
  });

  it("does not present an unrecognised status as pending", async () => {
    stubExperiments(["WEIRD"]);
    render(<StrategyLab />);
    const pill = await screen.findByText("WEIRD");
    expect(pill.closest("[aria-label]")?.getAttribute("aria-label")).toBe("status: unknown (WEIRD)");
  });
});
