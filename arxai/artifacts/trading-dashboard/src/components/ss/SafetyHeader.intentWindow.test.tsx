// Regression: GET /api/live-intent/queue counts only its newest `limit`
// intents (default 100) and says hasMore when older ones exist. The global
// SafetyHeader showed counts.total as the total ("100 Intents" with 350
// stored), kept the last count after a failed read, and showed a non-admin's
// empty admin-only answer as "0 Intents".
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { readIntentQueueCount } from "@/lib/intentQueueCount";

vi.mock("@/hooks/useFeatureUnlock", () => ({
  useAllUnlocks: () => ({ mt5: false, paper: true, analysis: true, simulator: true }),
}));
vi.mock("@/hooks/useTradingMode", () => ({
  useTradingMode: () => ({ isAdminPreviewingUserMode: false, isLiveShared: false }),
}));
vi.mock("@/lib/use-chart-symbol", () => ({ useChartSymbol: () => ["EURUSD"] }));

import { SafetyHeader } from "./SafetyHeader";

const admin = (total: number, hasMore: boolean | undefined, limit: number | undefined = 100) => ({
  intents: [], counts: { total, pendingMt5: 0, ready: 0, rejected: 0, executedLater: 0 },
  ...(limit !== undefined ? { limit } : {}), ...(hasMore !== undefined ? { hasMore } : {}),
  modeScopeApplied: true, adminScope: true,
});
const nonAdmin = {
  intents: [], counts: { total: 0, pendingMt5: 0, ready: 0, rejected: 0, executedLater: 0 },
  modeScopeApplied: true, scopeNote: "Live Intent Queue is admin-only operator data.",
};

function stubQueue(answer: { status: number; body?: unknown } | "throw") {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (String(url).includes("/api/live-intent/queue")) {
      if (answer === "throw") throw new Error("network");
      return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status });
    }
    return new Response("null", { status: 404 });
  }));
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("readIntentQueueCount", () => {
  it("is exact only when the server says nothing older exists (or the window was not full)", () => {
    expect(readIntentQueueCount(admin(100, true))).toEqual({ kind: "at_least", total: 100 });
    expect(readIntentQueueCount(admin(100, false))).toEqual({ kind: "exact", total: 100 });
    expect(readIntentQueueCount(admin(3, undefined))).toEqual({ kind: "exact", total: 3 });
    expect(readIntentQueueCount(admin(100, undefined, undefined))).toEqual({ kind: "at_least", total: 100 });
  });

  it("a failed or malformed answer is an error, and a non-admin answer is not a count", () => {
    expect(readIntentQueueCount(null)).toEqual({ kind: "error" });
    expect(readIntentQueueCount({ error: "Failed to load live intent queue" })).toEqual({ kind: "error" });
    expect(readIntentQueueCount({ adminScope: true, counts: {} })).toEqual({ kind: "error" });
    expect(readIntentQueueCount({ adminScope: true, counts: { total: 0 } })).toEqual({ kind: "exact", total: 0 });
    expect(readIntentQueueCount(nonAdmin)).toEqual({ kind: "not_shown", note: nonAdmin.scopeNote });
  });
});

describe("SafetyHeader intent pill", () => {
  it("350 stored, newest 100 counted → '100+ Intents', not '100 Intents'", async () => {
    stubQueue({ status: 200, body: admin(100, true) });
    render(<SafetyHeader />);
    const pill = await screen.findByTestId("safety-header-intents");
    expect(pill.textContent).toMatch(/100\+ Intents/);
    expect(pill.getAttribute("title")).toMatch(/newest 100/);
  });

  it("the whole queue in the window keeps the exact count", async () => {
    stubQueue({ status: 200, body: admin(7, false) });
    render(<SafetyHeader />);
    expect((await screen.findByTestId("safety-header-intents")).textContent).toMatch(/^\s*7 Intents$/);
  });

  it("a failed read says not loaded, never a count", async () => {
    stubQueue({ status: 500, body: { error: "Failed to load live intent queue" } });
    render(<SafetyHeader />);
    const pill = await screen.findByTestId("safety-header-intents");
    expect(pill.textContent).toMatch(/not loaded/);
    expect(pill.textContent).not.toMatch(/\d/);
    cleanup();
    stubQueue("throw");
    render(<SafetyHeader />);
    expect((await screen.findByTestId("safety-header-intents")).textContent).toMatch(/not loaded/);
  });

  it("a non-admin's admin-only answer is not shown as '0 Intents'", async () => {
    stubQueue({ status: 200, body: nonAdmin });
    render(<SafetyHeader />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("safety-header-intents")).toBeNull();
    expect(screen.queryByText(/0 Intents/)).toBeNull();
  });
});
