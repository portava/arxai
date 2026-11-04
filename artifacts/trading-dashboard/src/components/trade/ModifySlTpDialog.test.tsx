// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const toast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));
const modifyPosition = vi.fn(async () => ({ ok: true, status: "sent", reason: null, commandId: "m1", via: "instant" as const }));
vi.mock("@/lib/tradeActions", async (orig) => ({ ...(await orig<typeof import("@/lib/tradeActions")>()), modifyPosition: (...a: unknown[]) => modifyPosition(...(a as [])) }));

import { ModifySlTpButton, ModifySlTpDialog, type ModifyTarget } from "./ModifySlTpDialog";

const buy: ModifyTarget = { scope: "live", ticket: "123", symbol: "EURUSD", side: "BUY", entryPrice: 1.1000, currentPrice: 1.1010, stopLoss: 1.0950, takeProfit: null };

afterEach(() => { cleanup(); modifyPosition.mockClear(); });

describe("ModifySlTpDialog", () => {
  it("pre-fills the current levels and refuses an unchanged submit", () => {
    render(<ModifySlTpDialog open onOpenChange={() => {}} target={buy} source="chart" />);
    expect((screen.getByTestId("modify-sl") as HTMLInputElement).value).toBe("1.095");
    expect((screen.getByTestId("modify-submit") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("modify-error").textContent).toMatch(/Change the Stop Loss or Take Profit first/);
  });
  it("applies the MT5 side rule against the current price (Buy: SL below, TP above)", () => {
    render(<ModifySlTpDialog open onOpenChange={() => {}} target={buy} source="chart" />);
    fireEvent.change(screen.getByTestId("modify-sl"), { target: { value: "1.1020" } });
    expect(screen.getByTestId("modify-error").textContent).toMatch(/Stop Loss must be below/);
    fireEvent.change(screen.getByTestId("modify-sl"), { target: { value: "1.0970" } });
    fireEvent.change(screen.getByTestId("modify-tp"), { target: { value: "1.1005" } });
    expect(screen.getByTestId("modify-error").textContent).toMatch(/Take Profit must be above/);
    fireEvent.change(screen.getByTestId("modify-tp"), { target: { value: "1.1100" } });
    expect((screen.getByTestId("modify-submit") as HTMLButtonElement).disabled).toBe(false);
  });
  it("sends the new levels through modifyPosition and closes", async () => {
    const onOpenChange = vi.fn(); const onModified = vi.fn();
    render(<ModifySlTpDialog open onOpenChange={onOpenChange} target={{ ...buy, side: "SELL", stopLoss: null }} source="position_card" onModified={onModified} />);
    fireEvent.change(screen.getByTestId("modify-sl"), { target: { value: "1.1050" } });
    fireEvent.click(screen.getByTestId("modify-submit"));
    await waitFor(() => expect(modifyPosition).toHaveBeenCalledTimes(1));
    expect(modifyPosition.mock.calls[0]![0]).toMatchObject({ scope: "live", ticket: "123", side: "SELL", newStopLoss: 1.105, newTakeProfit: null, source: "position_card" });
    await waitFor(() => expect(onModified).toHaveBeenCalled());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
  it("shows a refusal from the gated route", async () => {
    modifyPosition.mockResolvedValueOnce({ ok: false, status: "STOP_LOSS_WRONG_SIDE", reason: "STOP_LOSS_WRONG_SIDE", commandId: null, via: "instant" });
    render(<ModifySlTpDialog open onOpenChange={() => {}} target={buy} source="chart" />);
    fireEvent.change(screen.getByTestId("modify-sl"), { target: { value: "1.0980" } });
    fireEvent.click(screen.getByTestId("modify-submit"));
    await waitFor(() => expect(screen.getByTestId("modify-error").textContent).toBeTruthy());
  });
  it("the row button opens the dialog", () => {
    render(<ModifySlTpButton target={buy} source="chart" />);
    expect(screen.queryByTestId("modify-sltp")).toBeNull();
    fireEvent.click(screen.getByTestId("modify-sltp-open-123"));
    expect(screen.getByTestId("modify-sltp")).toBeTruthy();
  });
});
