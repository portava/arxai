// Close-position modal: POST /positions/:id/close only queues the close to the
// broker (the position stays open until the broker confirms). The modal used
// to vanish on success as if the position were closed, said only "Close
// failed." on a refusal, and said nothing when the confirmation could not be
// built (Confirm just stayed disabled).
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ClosePositionConfirmModal } from "./ClosePositionConfirmModal";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const CONF = { requiresConfirmation: true, summary: "Close BUY EURUSD @ 1.085", blockers: [], aiExplanation: "Manual closes lock in current P&L." };

function mount(respond: (url: string) => Response) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return respond(url);
  }));
  const onDone = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={qc}><ClosePositionConfirmModal positionId={4} onDone={onDone} /></QueryClientProvider>);
  return onDone;
}

describe("ClosePositionConfirmModal truth", () => {
  it("a queued close says the position stays open until the broker confirms", async () => {
    const onDone = mount((url) => url.endsWith("/close-confirmation") ? json(CONF) : json({ id: 4, status: "OPEN", pending: { commandId: "c", close: true } }));
    await screen.findByText("Close BUY EURUSD @ 1.085");
    fireEvent.click(screen.getByText("Confirm close"));
    await waitFor(() => expect(screen.getByTestId("close-requested").textContent).toMatch(/stays open until the broker confirms/));
    expect(onDone).not.toHaveBeenCalled();
  });

  it("a refused close shows the server's reason", async () => {
    mount((url) => url.endsWith("/close-confirmation") ? json(CONF) : json({ error: "Kill switch engaged", code: "GOVERNED_QUEUE_REFUSED" }, 422));
    await screen.findByText("Close BUY EURUSD @ 1.085");
    fireEvent.click(screen.getByText("Confirm close"));
    await waitFor(() => expect(screen.getByTestId("close-failed").textContent).toMatch(/Kill switch engaged.*still open/));
  });

  it("a confirmation that could not be built says so", async () => {
    mount(() => json({ error: "Position already terminal", status: "CLOSED" }, 409));
    await waitFor(() => expect(screen.getByTestId("close-confirm-error").textContent).toMatch(/Position already terminal.*Nothing was sent/));
  });
});
