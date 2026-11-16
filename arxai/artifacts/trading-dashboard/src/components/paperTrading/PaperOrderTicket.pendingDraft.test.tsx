// Demo order ticket, pending orders — "Draft saved." only when the server says
// it saved one (ok:true with a draftId). /me/pending-order-draft answers a
// refusal with HTTP 200 {ok:false, blocked:true, reason} (R:R floor, Risk
// Governor preview, unreadable limits); that is "Draft not saved" with the
// server's reason. A non-2xx answer shows the server's plain-English reason,
// not a bare code like bridge_status_unavailable.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PaperOrderTicket } from "./PaperOrderTicket";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function mount(answer: () => Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(answer));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={qc}><PaperOrderTicket accountId={1} /></QueryClientProvider>);
  fireEvent.change(screen.getByTestId("select-order-type"), { target: { value: "BUY_LIMIT" } });
  fireEvent.change(screen.getByTestId("input-entry"), { target: { value: "1.08" } });
  fireEvent.change(screen.getByTestId("input-sl"), { target: { value: "1.07" } });
  fireEvent.change(screen.getByTestId("input-tp"), { target: { value: "1.09" } });
  fireEvent.click(screen.getByTestId("button-place-order"));
}

const json = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});

describe("PaperOrderTicket pending draft truth", () => {
  it("a 200 {ok:false, blocked:true} refusal says Draft not saved with the server's reason", async () => {
    const reason = "Reward:risk 1.00 is below your minimum of 1.5.";
    mount(json(200, { ok: false, executable: false, blocked: true, checkId: "ticket_rr", reason }));
    const out = await screen.findByTestId("order-ticket-draft-result");
    expect(out.textContent).toMatch(/Draft not saved/);
    expect(out.textContent).toContain(reason);
    expect(out.textContent).not.toContain("Draft saved.");
    expect(screen.getByTestId("order-ticket").textContent).not.toContain("Draft saved.");
    expect(out.textContent).not.toMatch(/Ready to send/);
  });

  it("an unreadable-limits refusal is not shown as saved", async () => {
    mount(json(200, {
      ok: false, executable: false, blocked: true, checkId: "rg_rr_limits_unavailable",
      reason: "Your risk limits could not be read, so the reward:risk minimum cannot be checked. Draft not saved.",
    }));
    const out = await screen.findByTestId("order-ticket-draft-result");
    expect(out.textContent).not.toContain("Draft saved.");
    expect(out.textContent).toContain("Your risk limits could not be read");
  });

  it("a 500 shows the server's plain-English reason, not the bare code", async () => {
    mount(json(500, {
      ok: false, error: "bridge_status_unavailable",
      reason: "Your MT5 bridge status could not be read, so the draft was not saved. Try again.",
    }));
    const err = await screen.findByTestId("order-ticket-error");
    expect(err.textContent).toContain("Your MT5 bridge status could not be read, so the draft was not saved.");
    expect(err.textContent).not.toBe("bridge_status_unavailable");
    expect(screen.queryByTestId("order-ticket-draft-result")).toBeNull();
  });

  it("a 500 with only a code names it as a draft that was not saved", async () => {
    mount(json(500, { ok: false, error: "draft_persist_failed" }));
    const err = await screen.findByTestId("order-ticket-error");
    expect(err.textContent).not.toBe("draft_persist_failed");
    expect(err.textContent).toMatch(/not save/i);
    expect(err.textContent).toContain("draft_persist_failed");
  });

  it("an HTML 500 says the outcome could not be confirmed", async () => {
    mount(async () => new Response("<html>Bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } }));
    const err = await screen.findByTestId("order-ticket-error");
    expect(err.textContent).toContain("HTTP 502");
    expect(err.textContent).toMatch(/could not confirm/i);
  });

  it("a 200 without ok:true and a draftId does not claim a saved draft", async () => {
    mount(json(200, {}));
    const out = await screen.findByTestId("order-ticket-draft-result");
    expect(out.textContent).not.toContain("Draft saved.");
    expect(out.textContent).toMatch(/did not confirm/i);
  });

  it("a saved draft (ok:true with a draftId) says Draft saved with the server's status", async () => {
    mount(json(200, {
      ok: true, draftId: 42, executable: false, pendingStatus: "DRAFT_UNSUPPORTED",
      reason: "Draft saved. Your connected EA does not report pending-order support.",
    }));
    const out = await screen.findByTestId("order-ticket-draft-result");
    expect(out.textContent).toContain("Draft saved");
    expect(out.textContent).toContain("Not ready to send");
    expect(out.textContent).toContain("DRAFT_UNSUPPORTED");
  });
});
