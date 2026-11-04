// Demo order ticket — the "current price" field is whatever the user typed: no
// quote is read, it has no source or time, and the server fills at a real quote
// that may differ. It must not be labelled live or "current market", and the
// checks and entry it drives must say they use the typed reference price.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PaperOrderTicket } from "./PaperOrderTicket";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function mount() {
  vi.stubGlobal("fetch", vi.fn());
  const qc = new QueryClient();
  render(<QueryClientProvider client={qc}><PaperOrderTicket accountId={1} /></QueryClientProvider>);
  return screen.getByTestId("order-ticket");
}

describe("PaperOrderTicket typed reference price", () => {
  it("the field is not labelled live", () => {
    const ticket = mount();
    expect(ticket.textContent).not.toMatch(/Current price \(live\)/);
    expect(screen.getByTestId("input-reference-price")).toBeTruthy();
    expect(ticket.textContent).toMatch(/typed/i);
  });

  it("a pending-order direction check names the typed reference price, not the market", () => {
    mount();
    fireEvent.change(screen.getByTestId("select-order-type"), { target: { value: "BUY_LIMIT" } });
    fireEvent.change(screen.getByTestId("input-reference-price"), { target: { value: "1.08" } });
    fireEvent.change(screen.getByTestId("input-entry"), { target: { value: "1.09" } });
    const err = screen.getByTestId("error-0");
    expect(err.textContent).not.toMatch(/current market/i);
    expect(err.textContent).toMatch(/reference price/i);
  });

  it("a market order's entry preview says it is the typed price, not the fill", () => {
    mount();
    fireEvent.change(screen.getByTestId("input-reference-price"), { target: { value: "1.085" } });
    const entry = screen.getByTestId("entry-preview-label");
    expect(entry.textContent).not.toBe("Effective entry");
    expect(entry.textContent).toMatch(/typed/i);
  });
});
