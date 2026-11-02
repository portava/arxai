function evidence(symbol="EURUSD",timeframe="M5") { return {symbol,timeframe,source:"deriv_public",sourceIdentity:"a".repeat(64),lastClosedCandleAt:"2026-01-01T00:00:00.000Z",userId:7}; }
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RubyReadStoreProvider } from "./rubyReadStore";
import { RubyChartRead } from "./RubyChartRead";

vi.mock("@/hooks/useScannerTruth", () => ({ useScannerTruth: (symbol:string,timeframe:string) => ({ assessmentEvidence:evidence(symbol,timeframe), truth: { analysis: { level: "full" } }, feedStatus: null }) }));
vi.mock("@/components/charts/FeedConfidenceBadge", () => ({ FeedConfidenceBadge: () => null }));
vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => ({ name: "Eleanor" }) }));

function deferred() {
  let resolve!: (r: Response) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<Response>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const reply = (bias: string) => new Response(JSON.stringify({ chartRead: { assessmentEvidence:evidence(), symbol: "EURUSD", timeframe: "M5", gated: false, bias, readLayer: "FULL", liveSetupWithheld: false, canShowLiveTradeSetup: true } }));
const panel = (symbol = "EURUSD") => <RubyChartRead symbol={symbol} timeframe="M5" draft={null} />;
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("shared chart-read request lifecycle", () => {
  it.each([["1M", "MN1"], ["1m", "M1"], ["15m", "M15"]])("sends the selected %s interval as canonical %s", async (selected, canonical) => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      chartRead: { symbol: "EURUSD", timeframe: canonical, gated: true, headline: "Read unavailable" },
    })));
    render(<RubyReadStoreProvider><RubyChartRead symbol="EURUSD" timeframe={selected} draft={null} /></RubyReadStoreProvider>);
    fireEvent.click(screen.getByTestId("ruby-chart-read-ask"));
    await waitFor(() => expect((screen.getByTestId("ruby-chart-read-ask") as HTMLButtonElement).disabled).toBe(false));
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string).timeframe).toBe(canonical);
    expect(screen.getByTestId("ruby-chart-read-gated").textContent).toContain("Read unavailable");
    expect(screen.queryByTestId("ruby-chart-read-err")).toBeNull();
  });

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
