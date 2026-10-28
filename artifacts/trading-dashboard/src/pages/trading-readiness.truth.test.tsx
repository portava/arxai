// Trading Readiness truth: the mental check-in starts unanswered (no invented
// 4/5 self-report earning a PASS), and a failed "last check" read says it
// could not be loaded instead of crashing the board.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { default: TradingReadinessPage } = await import("./trading-readiness");

const READY_EVAL = {
  evaluation: {
    status: "READY", score: 100,
    checklist: [{ id: "mental", label: "Mental state checked", status: "PASS", detail: "All indicators in healthy range" }],
    reasons: [], warnings: [], blockers: [],
    marketCondition: "NORMAL", brokerStatus: "CONNECTED", newsRiskLevel: "NONE",
    aiSummary: "READY — score 100/100. All checks passed.",
  },
};
const NO_CHECK = { status: 404, body: { error: "No readiness check yet" } };

type Reply = { status: number; body: unknown } | "reject";
function stubFetch(routes: { evaluate: () => Reply; latest: () => Reply }) {
  const calls: { url: string; body: unknown }[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const reply = url.includes("/api/readiness/evaluate") ? routes.evaluate()
      : url.includes("/api/readiness/checks/latest") ? routes.latest()
      : { status: 404, body: {} };
    if (reply === "reject") throw new TypeError("Failed to fetch");
    return {
      ok: reply.status >= 200 && reply.status < 300, status: reply.status,
      json: async () => reply.body,
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

function renderPage() {
  const qc = new QueryClient();
  render(<QueryClientProvider client={qc}><TradingReadinessPage /></QueryClientProvider>);
  return qc;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Trading Readiness mental check-in", () => {
  it("sends no self-report until the trader answers, and shows the scales as not answered", async () => {
    const calls = stubFetch({ evaluate: () => ({ status: 200, body: READY_EVAL }), latest: () => NO_CHECK });
    renderPage();
    await waitFor(() => expect(calls.some((c) => c.url.includes("/api/readiness/evaluate"))).toBe(true));
    const first = calls.find((c) => c.url.includes("/api/readiness/evaluate"))!.body as Record<string, unknown>;
    expect(first["mentalState"]).toBeNull();
    expect(first["sleepQuality"]).toBeNull();
    expect(first["stressLevel"]).toBeNull();
    expect(first["confidenceLevel"]).toBeNull();
    expect(screen.queryByText("4/5")).toBeNull();
    expect(screen.queryByText("2/5")).toBeNull();
    expect(screen.getAllByText("Not answered")).toHaveLength(4);
    // No scale shows a selected value the trader never picked.
    expect(screen.queryAllByRole("radio", { checked: true })).toHaveLength(0);
  });

  it("an answer the trader picks is what gets sent", async () => {
    const calls = stubFetch({ evaluate: () => ({ status: 200, body: READY_EVAL }), latest: () => NO_CHECK });
    renderPage();
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    act(() => { screen.getByRole("radio", { name: "Mental state 3 of 5" }).click(); });
    await waitFor(() => {
      const evals = calls.filter((c) => c.url.includes("/api/readiness/evaluate"));
      expect((evals.at(-1)!.body as Record<string, unknown>)["mentalState"]).toBe(3);
    });
    expect(screen.getByRole("radio", { name: "Mental state 3 of 5" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("3/5")).toBeTruthy();
  });
});

describe("Trading Readiness last submitted check", () => {
  for (const [label, reply] of [
    ["500", { status: 500, body: { error: "x" } }],
    ["401 not signed in", { status: 401, body: { error: "AUTH_REQUIRED" } }],
    ["network failure", "reject"],
  ] as const) {
    it(`a ${label} read says it could not be loaded and keeps the live evaluation`, async () => {
      stubFetch({ evaluate: () => ({ status: 200, body: READY_EVAL }), latest: () => reply });
      renderPage();
      expect(await screen.findByText("Readiness score")).toBeTruthy();
      const box = await screen.findByTestId("readiness-last-check");
      await waitFor(() => expect(box.textContent).toMatch(/could not be loaded/i));
      expect(screen.queryByTestId("readiness-last-check-summary")).toBeNull();
    });
  }

  it("no check on record says so instead of showing nothing", async () => {
    stubFetch({ evaluate: () => ({ status: 200, body: READY_EVAL }), latest: () => NO_CHECK });
    renderPage();
    const box = await screen.findByTestId("readiness-last-check");
    await waitFor(() => expect(box.textContent).toMatch(/no readiness check has been submitted yet/i));
    expect(screen.queryByTestId("readiness-last-check-summary")).toBeNull();
  });

  it("a stored check is shown with its status, score and time", async () => {
    stubFetch({
      evaluate: () => ({ status: 200, body: READY_EVAL }),
      latest: () => ({ status: 200, body: { check: { id: 1, status: "CAUTION", readinessScore: 72, createdAt: "2026-10-27T08:00:00.000Z" } } }),
    });
    renderPage();
    const summary = await screen.findByTestId("readiness-last-check-summary");
    expect(summary.textContent).toMatch(/CAUTION · 72\/100/);
  });
});
