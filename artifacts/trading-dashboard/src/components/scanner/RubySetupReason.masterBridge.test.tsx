import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// The master-bridge note under Ruby's Setup Reason must describe the routing
// /api/me/routing-status actually reports: the route resolves DEMO routing with
// live locked (safetyMode paper_only), it can be blocked (ok:false), and it
// changes when the user switches Bridge Preference on My Account.

vi.mock("@/components/ruby/RubyReasoningBlock", () => ({ RubyReasoningBlock: () => null }));
vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => ({ name: "Ruby" }) }));

import { RubySetupReason } from "./RubySetupReason";

const SETUP_REASON = {
  bias: "BUY", hedge: "", why: "", risk: "", invalidation: "", possibleTpArea: "",
  suggestedStopArea: "", confidenceLabel: "", confidenceScore: 50, cautions: [], disclaimer: "Not advice.",
};

// Exactly the shapes routes/meRoutingStatus.ts returns.
const SHARED_OK = {
  ok: true, effectiveRoutingMode: "SHARED_MASTER_MT5", routedViaMaster: true, blockReason: null,
  master: null, safetyMode: "paper_only", liveLocked: true,
};
const SHARED_BLOCKED = { ...SHARED_OK, ok: false, blockReason: "SHARED_MASTER_UNHEALTHY" };
const USER_OWNED = {
  ok: true, effectiveRoutingMode: "USER_OWNED_MT5", routedViaMaster: false, blockReason: null,
  master: null, safetyMode: "paper_only", liveLocked: true,
};

let routing: unknown = SHARED_OK;

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const body = String(url).includes("/api/me/routing-status") ? routing : { setupReason: SETUP_REASON };
    return { ok: true, status: 200, json: async () => body } as Response;
  }));
}

function renderReason() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RubySetupReason signal={{ symbol: "EURUSD", recommendedAction: "BUY", bias: "BUY" }} />
    </QueryClientProvider>,
  );
  return client;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("RubySetupReason master-bridge note", () => {
  it("names the DEMO master bridge, never a live bridge, when shared routing is OK", async () => {
    routing = SHARED_OK;
    installFetch();
    renderReason();
    const note = await screen.findByTestId("ruby-setup-master-bridge-note");
    expect(note.textContent).not.toMatch(/live bridge/i);
    expect(note.textContent).toContain("shared master demo bridge");
    expect(note.textContent).toContain("Live trading is locked");
  });

  it("does not claim orders route through the master when routing is blocked", async () => {
    routing = SHARED_BLOCKED;
    installFetch();
    renderReason();
    const note = await screen.findByTestId("ruby-setup-master-bridge-note");
    expect(note.textContent).not.toMatch(/orders route through/i);
    expect(note.textContent).toContain("blocked");
  });

  it("disappears after a switch to the user's own MT5 once routing status is invalidated", async () => {
    routing = SHARED_OK;
    installFetch();
    const client = renderReason();
    await screen.findByTestId("ruby-setup-master-bridge-note");
    routing = USER_OWNED;
    // What My Account's Bridge Preference mutation invalidates on success.
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["me", "routing-status"] });
    });
    await waitFor(() => expect(screen.queryByTestId("ruby-setup-master-bridge-note")).toBeNull());
  });
});
