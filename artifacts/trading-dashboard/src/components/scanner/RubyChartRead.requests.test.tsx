import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RubyReadStoreProvider } from "./rubyReadStore";
import { RubyChartRead } from "./RubyChartRead";

vi.mock("@/hooks/useScannerTruth", () => ({ useScannerTruth: () => ({ truth: { analysis: { level: "full" } }, feedStatus: null }) }));
vi.mock("@/components/charts/FeedConfidenceBadge", () => ({ FeedConfidenceBadge: () => null }));
vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => ({ name: "Eleanor" }) }));

function deferred() {
  let resolve!: (r: Response) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<Response>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const reply = (bias: string) => new Response(JSON.stringify({ chartRead: { gated: false, bias, readLayer: "FULL", liveSetupWithheld: false, canShowLiveTradeSetup: true } }));
const panel = (symbol = "EURUSD") => <RubyChartRead symbol={symbol} timeframe="M5" draft={null} />;
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("shared chart-read request lifecycle", () => {
  it("withdraws the previous direction during refresh and after a failed refresh", async () => {
    const pending = deferred();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(reply("Bullish")).mockReturnValueOnce(pending.promise);
    render(<RubyReadStoreProvider>{panel()}</RubyReadStoreProvider>);
    fireEvent.click(screen.getByTestId("ruby-chart-read-ask"));
    expect((await screen.findByTestId("ruby-chart-read-bias")).textContent).toBe("Bullish");
    fireEvent.click(screen.getByTestId("ruby-chart-read-ask"));
    expect(screen.queryByTestId("ruby-chart-read-bias")).toBeNull();
    await act(async () => pending.reject(new Error("offline")));
    expect(screen.getByTestId("ruby-chart-read-err")).toBeTruthy();
    expect(screen.queryByTestId("ruby-chart-read-bias")).toBeNull();
  });

  it("shares in-flight state between the chart and scalp panels", async () => {
    const pending = deferred();
    const fetch = vi.spyOn(globalThis, "fetch").mockReturnValue(pending.promise);
    render(<RubyReadStoreProvider>{panel()}{panel()}</RubyReadStoreProvider>);
    fireEvent.click(screen.getAllByTestId("ruby-chart-read-ask")[0]);
    expect(screen.getAllByTestId("ruby-chart-read-ask").every(b => (b as HTMLButtonElement).disabled)).toBe(true);
    fireEvent.click(screen.getAllByTestId("ruby-chart-read-ask")[1]);
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(reply("Bearish")));
    expect(screen.getAllByTestId("ruby-chart-read-bias").map(b => b.textContent)).toEqual(["Bearish", "Bearish"]);
  });

  it("does not transfer a request failure to a different selected market", async () => {
    const pending = deferred();
    vi.spyOn(globalThis, "fetch").mockReturnValue(pending.promise);
    const view = render(<RubyReadStoreProvider>{panel()}</RubyReadStoreProvider>);
    fireEvent.click(screen.getByTestId("ruby-chart-read-ask"));
    view.rerender(<RubyReadStoreProvider>{panel("GBPUSD")}</RubyReadStoreProvider>);
    expect((screen.getByTestId("ruby-chart-read-ask") as HTMLButtonElement).disabled).toBe(false);
    await act(async () => pending.reject(new Error("EURUSD unavailable")));
    expect(screen.queryByTestId("ruby-chart-read-err")).toBeNull();
    view.rerender(<RubyReadStoreProvider>{panel()}</RubyReadStoreProvider>);
    await waitFor(() => expect(screen.getByTestId("ruby-chart-read-err")).toBeTruthy());
  });
});
