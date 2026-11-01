import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RubyReadStoreProvider, useRubyReadStore } from "./rubyReadStore";

afterEach(cleanup);
const response = (symbol = "EURUSD", timeframe = "M5") => ({
  symbol, timeframe, gated: false, readLayer: "FULL", liveSetupWithheld: false,
  canShowLiveTradeSetup: true, bias: "Bullish",
});
const useStore = () => renderHook(useRubyReadStore, { wrapper: RubyReadStoreProvider });

describe("chart read selected-market binding", () => {
  it.each([
    response("GBPUSD"), response("EURUSD", "H1"),
    { ...response(), symbol: undefined }, { ...response(), timeframe: undefined },
    response("EURUSD.a"), response("EUR/USD"),
  ])("withholds a response from a different or missing market identity: %j", async read => {
    const { result } = useStore();
    await act(async () => result.current.request("EURUSD", "5m", async () => read));
    expect(result.current.get("EURUSD", "5m")?.gated).toBe(true);
    expect(result.current.get("EURUSD", "5m")?.bias).toBeUndefined();
    expect(result.current.requestState("EURUSD", "5m").error).not.toBeNull();
  });

  it("shares a response and loading state across Scanner and scalp timeframe spellings", async () => {
    const { result } = useStore(); let finish!: (value: unknown) => void;
    act(() => { void result.current.request("EURUSD", "M1", () => new Promise(resolve => { finish = resolve; })); });
    expect(result.current.requestState("EURUSD", "1m").loading).toBe(true);
    expect(result.current.get("EURUSD", "1m")?.gated).toBe(true);
    await act(async () => finish(response("EURUSD", "M1")));
    expect(result.current.get("EURUSD", "1m")?.bias).toBe("Bullish");
    expect(result.current.get("EURUSD", "M1")).toBe(result.current.get("EURUSD", "1m"));
  });

  it("cannot replace a newer alias-key request with an older completion", async () => {
    const { result } = useStore(); let finish!: (value: unknown) => void;
    act(() => { void result.current.request("EURUSD", "M5", () => new Promise(resolve => { finish = resolve; })); });
    await act(async () => result.current.request("EURUSD", "5m", async () => ({ ...response(), bias: "Bearish" })));
    await act(async () => finish(response()));
    expect(result.current.get("EURUSD", "M5")?.bias).toBe("Bearish");
  });
});
