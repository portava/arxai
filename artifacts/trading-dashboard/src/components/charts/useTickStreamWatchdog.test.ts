// THEME C3.4 — the chart must notice a dead tick-stream and reconnect.
//
// BEFORE
//   `es.onerror` was a no-op with the comment "the browser auto-reconnects an
//   EventSource; nothing to do". That covers only errors the browser actually
//   surfaces. The case that bites surfaces nothing at all: a proxy idle-timeout,
//   a sleeping tab, or a network change leaves the connection nominally OPEN
//   while it silently stops delivering. No error fires, no retry happens, and
//   the chart sits frozen indefinitely while still presenting itself as live.
//
// CONTRACT LOCKED HERE
//   - Silence past the window bumps `epoch` (the reconnect signal) and raises
//     `stalled`.
//   - Any frame of any type resets the clock, so a healthy stream never churns.
//   - A stream that stays dead retries ONCE PER WINDOW, not once per check.
//   - The timer is mount-scoped: it must not be rebuilt by the reconnect it
//     triggers, which would reset its own clock.
//
// The hook is tested directly rather than through ARXNativeChart: the logic is
// entirely here. A controlled clock checks exact silence boundaries without
// making assertions depend on machine load or scheduler delays.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  useTickStreamWatchdog,
  STREAM_SILENCE_MS,
  STREAM_WATCHDOG_TICK_MS,
} from "./useTickStreamWatchdog";

// Small deterministic timings. Ratio mirrors production (checks well inside
// the window); advancing fake time exercises the actual interval and Date clock.
const SILENCE_MS = 60;
const TICK_MS = 10;
const OPTS = { silenceMs: SILENCE_MS, tickMs: TICK_MS };

const wait = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-26T12:00:00Z"));
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("C3.4 — production timings", () => {
  it("tolerates two missed 15s server heartbeats before acting", () => {
    expect(STREAM_SILENCE_MS).toBe(30_000);
  });

  it("checks well inside the window it guards", () => {
    expect(STREAM_WATCHDOG_TICK_MS).toBeLessThan(STREAM_SILENCE_MS / 2);
  });
});

describe("C3.4 — silence detection", () => {
  it("starts healthy", () => {
    const { result } = renderHook(() => useTickStreamWatchdog(OPTS));
    expect(result.current.epoch).toBe(0);
    expect(result.current.stalled).toBe(false);
  });

  it("bumps the epoch and reports stalled after the silence window", async () => {
    const { result } = renderHook(() => useTickStreamWatchdog(OPTS));
    await act(async () => {
      await wait(SILENCE_MS + TICK_MS * 3);
    });
    expect(result.current.epoch).toBeGreaterThanOrEqual(1);
    expect(result.current.stalled).toBe(true);
  });

  it("does NOT reconnect while frames keep arriving", async () => {
    const { result } = renderHook(() => useTickStreamWatchdog(OPTS));
    // Heartbeat well inside the window, across more than two full windows.
    for (let i = 0; i < 12; i++) {
      await act(async () => {
        await wait(SILENCE_MS / 3);
        result.current.noteFrame();
      });
    }
    expect(result.current.epoch).toBe(0);
    expect(result.current.stalled).toBe(false);
  });

  it("recovers to healthy when frames resume after a stall", async () => {
    const { result } = renderHook(() => useTickStreamWatchdog(OPTS));
    await act(async () => {
      await wait(SILENCE_MS + TICK_MS * 3);
    });
    expect(result.current.stalled).toBe(true);

    const epochAfterStall = result.current.epoch;
    for (let i = 0; i < 6; i++) {
      await act(async () => {
        await wait(SILENCE_MS / 3);
        result.current.noteFrame();
      });
    }
    expect(result.current.stalled).toBe(false);
    expect(result.current.epoch).toBe(epochAfterStall);
  });

  it("retries once per silence window, not once per check", async () => {
    const { result } = renderHook(() => useTickStreamWatchdog(OPTS));
    const windows = 3;
    await act(async () => {
      await wait(SILENCE_MS * windows + TICK_MS * 3);
    });
    // Three silence windows produce exactly three retries, not one per check.
    expect(result.current.epoch).toBe(windows);
  });
});

describe("inactive watchdog (no stream exists)", () => {
  it("never reports stalled or asks for a reconnect while nothing is watched", async () => {
    const { result } = renderHook(() => useTickStreamWatchdog({ ...OPTS, active: false }));
    await act(async () => {
      await wait(SILENCE_MS * 3);
    });
    expect(result.current.stalled).toBe(false);
    expect(result.current.epoch).toBe(0);
  });

  it("withdraws a stall verdict when the stream stops being watched", async () => {
    const { result, rerender } = renderHook(
      ({ active }: { active: boolean }) => useTickStreamWatchdog({ ...OPTS, active }),
      { initialProps: { active: true } },
    );
    await act(async () => {
      await wait(SILENCE_MS + TICK_MS * 3);
    });
    expect(result.current.stalled).toBe(true);
    rerender({ active: false });
    expect(result.current.stalled).toBe(false);
  });
});

describe("C3.4 — stream lifecycle signals", () => {
  it("noteError marks stalled without forcing a reconnect on its own", () => {
    const { result } = renderHook(() => useTickStreamWatchdog(OPTS));
    act(() => {
      result.current.noteError();
    });
    expect(result.current.stalled).toBe(true);
    // The browser owns retry for surfaced errors; the watchdog owns the silent
    // case. onerror must not race an extra reconnect of its own.
    expect(result.current.epoch).toBe(0);
  });

  it("noteStreamOpened restarts the clock but keeps the stall until the new stream delivers", async () => {
    const { result } = renderHook(() => useTickStreamWatchdog(OPTS));
    await act(async () => { await wait(SILENCE_MS * 2 / 3); });
    act(() => {
      result.current.noteError();
    });
    expect(result.current.stalled).toBe(true);

    // Reopening a socket proves nothing: a stream that has delivered no frame
    // yet is still "reconnecting", not live (truth upgrade, 2026-10-28).
    act(() => {
      result.current.noteStreamOpened();
    });
    expect(result.current.stalled).toBe(true);

    // Pass the original deadline, but remain inside the restarted window.
    await act(async () => { await wait(SILENCE_MS - 1); });
    expect(result.current.epoch).toBe(0);
    await act(async () => { await wait(1); });
    expect(result.current.epoch).toBe(1);
    expect(result.current.stalled).toBe(true);
  });

  it("a silent stream reopened by the watchdog still reads stalled until a frame arrives", async () => {
    const { result } = renderHook(() => useTickStreamWatchdog(OPTS));
    await act(async () => { await wait(SILENCE_MS + TICK_MS * 3); });
    expect(result.current.epoch).toBeGreaterThanOrEqual(1);
    expect(result.current.stalled).toBe(true);
    // The subscribe effect re-runs on the epoch bump and opens a new stream.
    act(() => {
      result.current.noteStreamOpened();
    });
    expect(result.current.stalled).toBe(true);
    act(() => {
      result.current.noteFrame();
    });
    expect(result.current.stalled).toBe(false);
  });

  it("stops watching after unmount", async () => {
    const { result, unmount } = renderHook(() => useTickStreamWatchdog(OPTS));
    const before = result.current.epoch;
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    await wait(SILENCE_MS * 3);
    expect(result.current.epoch).toBe(before);
  });

  it("keeps callback identities stable across renders", () => {
    const { result, rerender } = renderHook(() => useTickStreamWatchdog(OPTS));
    const first = {
      noteFrame: result.current.noteFrame,
      noteError: result.current.noteError,
      noteStreamOpened: result.current.noteStreamOpened,
    };
    rerender();
    expect(result.current.noteFrame).toBe(first.noteFrame);
    expect(result.current.noteError).toBe(first.noteError);
    expect(result.current.noteStreamOpened).toBe(first.noteStreamOpened);
  });
});

// A hook nothing calls protects nothing. The chart's SSE effect cannot be
// driven under a faked clock (rendering the full chart with fake timers hangs),
// so the wiring itself is pinned at the source level instead.
describe("C3.4 — ARXNativeChart is wired to the watchdog", () => {
  const chartSrc = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "./ARXNativeChart.tsx"),
    "utf8",
  );

  it("uses the watchdog hook", () => {
    expect(chartSrc).toMatch(/useTickStreamWatchdog\(/);
  });

  it("resets the clock on every received frame", () => {
    expect(chartSrc).toMatch(/streamWatchdog\.noteFrame\(\)/);
  });

  it("records a surfaced stream error", () => {
    expect(chartSrc).toMatch(/streamWatchdog\.noteError\(\)/);
    expect(chartSrc).not.toMatch(
      /es\.onerror\s*=\s*\(\)\s*=>\s*\{\s*(\/\/[^\n]*\n\s*)*\}/,
      "es.onerror must not be a no-op again",
    );
  });

  it("starts a fresh clock when a stream is opened", () => {
    expect(chartSrc).toMatch(/streamWatchdog\.noteStreamOpened\(\)/);
  });

  it("rebuilds the EventSource when the watchdog bumps the epoch", () => {
    expect(chartSrc).toMatch(
      /\[resolvedSymbol,\s*timeframe,\s*streamWatchdog\.epoch,\s*tickSource,\s*chartContext\]/,
      "the reconnect signal and source context must be dependencies of the subscribe effect",
    );
  });
});
