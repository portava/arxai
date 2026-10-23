// Chart tick-stream watchdog (Theme C3.4).
//
// WHY THIS EXISTS
//   The chart's SSE tick-stream had no failure detection at all: `es.onerror`
//   was a no-op on the reasoning that "the browser auto-reconnects an
//   EventSource". That covers only the errors the browser actually surfaces.
//   The case that bites in practice surfaces nothing: a proxy idle-timeout, a
//   sleeping tab, or a network change leaves the connection nominally OPEN
//   while it silently stops delivering. The browser sees no error, never
//   retries, and the chart sits frozen indefinitely while still presenting
//   itself as live.
//
// HOW IT DETECTS
//   The server heartbeats every 15s regardless of tick activity, so ANY frame —
//   forming_bar, feed_status, or heartbeat — proves the stream is alive.
//   Silence past two consecutive heartbeats therefore means the stream is
//   genuinely not delivering, whatever the socket claims about itself.
//
// SCOPE
//   Transport recovery and an honest status flag. This hook carries no market
//   data, applies nothing to the chart, and touches no execution path. A
//   reconnect re-opens the same URL; every honesty gate on the frames that then
//   arrive is unchanged.

import { useCallback, useEffect, useRef, useState } from "react";

/** Two missed 15s server heartbeats. */
export const STREAM_SILENCE_MS = 30_000;
/** How often the watchdog checks — well below the window it guards. */
export const STREAM_WATCHDOG_TICK_MS = 5_000;

export interface TickStreamWatchdogOptions {
  /** Silence tolerated before forcing a reconnect. */
  silenceMs?: number;
  /** Watchdog check cadence. */
  tickMs?: number;
}

export interface TickStreamWatchdog {
  /**
   * Bumped every time the watchdog decides the stream must be rebuilt. Include
   * it in the subscribe effect's dependencies; that effect's own cleanup closes
   * the dead EventSource before the replacement is opened.
   */
  epoch: number;
  /**
   * True while the stream is believed to be down — either it surfaced an error
   * or it went silent past the window. Drives the honest "reconnecting" badge
   * so a stalled chart never passes for a live one.
   */
  stalled: boolean;
  /** Call for EVERY frame received, of any type. Resets the silence clock. */
  noteFrame: () => void;
  /** Call from `es.onerror`. Records the state; the watchdog owns the retry. */
  noteError: () => void;
  /** Call right after a new EventSource is constructed. */
  noteStreamOpened: () => void;
}

/**
 * Watch an SSE stream for silence and ask for a reconnect when it stops.
 *
 * The interval is mount-scoped and deliberately independent of the stream it
 * guards: a watchdog that triggers a reconnect must not be torn down and
 * rebuilt by that same reconnect, which would reset its own clock and let a
 * dead stream retry once per check instead of once per window.
 */
export function useTickStreamWatchdog(
  opts: TickStreamWatchdogOptions = {},
): TickStreamWatchdog {
  const silenceMs = opts.silenceMs ?? STREAM_SILENCE_MS;
  const tickMs = opts.tickMs ?? STREAM_WATCHDOG_TICK_MS;

  const [epoch, setEpoch] = useState(0);
  const [stalled, setStalled] = useState(false);
  const lastFrameAtRef = useRef<number>(Date.now());

  const noteFrame = useCallback(() => {
    lastFrameAtRef.current = Date.now();
    // Only clear when actually set, so a healthy stream does not re-render on
    // every frame (a chatty feed delivers several per second).
    setStalled((prev) => (prev ? false : prev));
  }, []);

  const noteError = useCallback(() => {
    setStalled(true);
  }, []);

  const noteStreamOpened = useCallback(() => {
    // A fresh stream starts its own silence clock; any prior stall verdict
    // belonged to the connection it replaced.
    lastFrameAtRef.current = Date.now();
    setStalled((prev) => (prev ? false : prev));
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      if (Date.now() - lastFrameAtRef.current < silenceMs) return;
      // Reset the clock AT the decision, so a stream that stays dead retries
      // once per silence window rather than once per watchdog tick.
      lastFrameAtRef.current = Date.now();
      setStalled(true);
      setEpoch((n) => n + 1);
    }, tickMs);
    return () => clearInterval(timer);
  }, [silenceMs, tickMs]);

  return { epoch, stalled, noteFrame, noteError, noteStreamOpened };
}
