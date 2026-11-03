import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("performance telemetry document lifecycle", () => {
  const originalWindow = window;
  const originalDocument = document;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  });

  afterEach(() => {
    vi.stubGlobal("window", originalWindow);
    vi.stubGlobal("document", originalDocument);
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps active measurements and retires its interval and listeners after document replacement", async () => {
    const ownerWindow = window;
    const addEventListener = vi.spyOn(ownerWindow, "addEventListener");
    const removeEventListener = vi.spyOn(ownerWindow, "removeEventListener");
    const setInterval = vi.spyOn(ownerWindow, "setInterval");
    const clearInterval = vi.spyOn(ownerWindow, "clearInterval");
    let clock = 100;
    vi.spyOn(performance, "now").mockImplementation(() => clock);

    const perf = await import("./perf");
    const intervalId = setInterval.mock.results[0]?.value;

    expect(setInterval).toHaveBeenCalledWith(expect.any(Function), 5000);
    expect(addEventListener).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    expect(addEventListener).toHaveBeenCalledWith("pagehide", expect.any(Function));

    const actionId = perf.markActionStart("scanner.openTradeModal", { page: "market-scanner" });
    clock = 110;
    perf.markUiFeedback(actionId);
    clock = 120;
    perf.markApiStart(actionId, "GET /api/scanner");
    clock = 125;
    perf.markApiEnd(actionId, "GET /api/scanner");
    perf.markFeedTiming(actionId, "market-data", "EURUSD", 7);
    perf.markDbTiming(actionId, "scanner", 9);
    perf.markCacheHit(actionId, true);
    clock = 130;
    perf.markRenderComplete(actionId);
    clock = 140;
    const row = perf.markActionEnd(actionId);

    expect(row).toMatchObject({
      action: "scanner.openTradeModal",
      page: "market-scanner",
      totalMs: 40,
      uiFeedbackMs: 10,
      frontendRenderMs: 30,
      apiMs: 5,
      feedMs: 7,
      dbMs: 9,
      cacheHit: true,
      viewport: "desktop",
    });
    expect(removeEventListener).not.toHaveBeenCalled();

    perf.setPerfTransportEnabled(true);
    perf.reportSlowAction(row!);
    await vi.advanceTimersByTimeAsync(4999);
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(1);

    vi.stubGlobal("document", { defaultView: ownerWindow } as Document);
    await vi.advanceTimersByTimeAsync(5000);

    expect(clearInterval).toHaveBeenCalledWith(intervalId);
    expect(removeEventListener).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    expect(removeEventListener).toHaveBeenCalledWith("pagehide", expect.any(Function));
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
