import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TradingSetupReadinessCard } from "./TradingSetupReadinessCard";

/**
 * Truth guard: the first readiness chip is bound to ready_for_paper but was
 * labelled "Demo" (two "Demo" chips), and "N of M checks complete" counted
 * `not_required` checks as complete.
 */

function mount(report: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ ok: true, report }), { status: 200 })),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <TradingSetupReadinessCard />
    </QueryClientProvider>,
  );
}

const base = {
  accountMode: null,
  liveExecutionHardLockActive: true,
  paperOnlyHardLockActive: true,
  ready_for_paper: true,
  ready_for_demo: false,
  ready_for_live: false,
  blockers: [],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TradingSetupReadinessCard", () => {
  it("labels the paper chip 'Paper' and the demo chip 'Demo'", async () => {
    mount({ ...base, statuses: [] });
    const paper = await screen.findByTestId("readiness-paper");
    expect(paper.textContent).toContain("Paper");
    expect(paper.textContent).toContain("Ready");
    const demo = screen.getByTestId("readiness-demo");
    expect(demo.textContent).toContain("Demo");
    expect(demo.textContent).toContain("Not ready");
  });

  it("does not count a not-required check as complete", async () => {
    mount({
      ...base,
      statuses: [
        { id: "a", label: "Broker link", status: "not_required", nextStep: null },
        { id: "b", label: "Risk profile", status: "fail", nextStep: "Set your risk profile" },
      ],
    });
    const count = await screen.findByTestId("readiness-count");
    expect(count.textContent).not.toMatch(/^1 of 2/);
    expect(count.textContent).toBe("0 of 1 required checks passed · 1 not required");
    expect(screen.getByTestId("readiness-percent").textContent).toBe("0%");
  });

  it("does not present the separate pre-session check as the full version of this setup report", async () => {
    mount({ ...base, statuses: [{ id: "a", label: "Risk profile", status: "pass", nextStep: null }] });
    await screen.findByTestId("readiness-count");
    expect(screen.queryByText(/full readiness/i)).toBeNull();
    const link = screen.getByTestId("button-open-pre-session-check");
    expect(link.getAttribute("href")).toBe("/trading-readiness");
    expect(link.textContent).toBe("Open pre-session check");
    expect(screen.getByTestId("text-pre-session-check-note").textContent).toMatch(/separate check .* with its own score\. It does not\s+measure the setup checks above\./);
  });
});
