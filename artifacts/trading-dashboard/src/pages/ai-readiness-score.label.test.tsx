// AI Readiness Score: the header badge shows the readiness band the server
// computed. PAPER_READY (score 70-84) is never relabelled DEMO_READY (85-94),
// which would claim one tier more than the server and make two different
// server states read the same.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

vi.mock("@/hooks/useProductRole", () => ({
  useProductRole: () => ({
    role: "ADMIN",
    isAdmin: true,
    isInvestor: false,
    isTrader: false,
    isLoading: false,
    homePath: "/",
  }),
}));

const { default: AiReadinessScore } = await import("./ai-readiness-score");

let body: unknown;

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => body,
  }) as unknown as Response));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function flush() {
  for (let i = 0; i < 5; i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  }
}

describe("AI Readiness Score label", () => {
  it("shows PAPER_READY when the server says PAPER_READY", async () => {
    body = { score: 75, label: "PAPER_READY", factors: {}, realBrokerReadiness: "x" };
    render(<AiReadinessScore />);
    await flush();
    expect(screen.getByText("PAPER_READY")).toBeTruthy();
    expect(screen.queryByText("DEMO_READY")).toBeNull();
  });

  it("shows DEMO_READY only when the server says DEMO_READY", async () => {
    body = { score: 90, label: "DEMO_READY", factors: {}, realBrokerReadiness: "x" };
    render(<AiReadinessScore />);
    await flush();
    expect(screen.getByText("DEMO_READY")).toBeTruthy();
    expect(screen.queryByText("PAPER_READY")).toBeNull();
  });
});
