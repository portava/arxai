import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FirstRunReadinessPanel } from "./FirstRunReadinessPanel";

/**
 * Truth guard: the header subtitle was a hard-coded "live trading armed"
 * while the server sends liveLocked:true and the footer of the same card says
 * live trading is BLOCKED. The subtitle must come from the server's field.
 */

function mount(resp: { ok: boolean; status?: number; body?: unknown }) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(resp.body ?? {}), { status: resp.status ?? (resp.ok ? 200 : 500) })));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <FirstRunReadinessPanel />
    </QueryClientProvider>,
  );
}

const okBody = (liveLocked: boolean) => ({
  generatedAt: new Date().toISOString(),
  items: [],
  summary: { passed: 0, total: 0, blockingFailures: 0, readyForFirstTrade: false },
  safetyMode: "paper_only",
  liveLocked,
  readOnlyMode: true,
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("FirstRunReadinessPanel live lock subtitle", () => {
  it("never says 'live trading armed' when the server reports live trading locked", async () => {
    mount({ ok: true, body: okBody(true) });
    expect((await screen.findByTestId("text-first-run-live-lock")).textContent).toBe("live trading locked");
    expect(screen.queryByText(/live trading armed/i)).toBeNull();
    expect(screen.getByTestId("text-first-run-footer").textContent).toMatch(/Live trading remains BLOCKED/);
  });

  it("does not claim BLOCKED in the footer when the server does not report a lock", async () => {
    mount({ ok: true, body: okBody(false) });
    expect((await screen.findByTestId("text-first-run-live-lock")).textContent).toBe("server does not report live trading as locked");
    expect(screen.getByTestId("text-first-run-footer").textContent).not.toMatch(/BLOCKED/);
  });

  it("a failed load says the lock status could not be loaded, and claims neither state", async () => {
    mount({ ok: false, status: 500 });
    expect((await screen.findByTestId("text-first-run-live-lock")).textContent).toBe("live lock status could not be loaded");
    expect(screen.queryByText(/live trading armed/i)).toBeNull();
    expect(screen.getByTestId("text-first-run-footer").textContent).not.toMatch(/BLOCKED/);
  });
});
