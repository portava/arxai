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

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

/** Two missed 15s server heartbeats. */
export const STREAM_SILENCE_MS = 30_000;
/** How often the watchdog checks — well below the window it guards. */
export const STREAM_WATCHDOG_TICK_MS = 5_000;

export interface TickStreamWatchdogOptions {
  /** Only monitor a source that can actually subscribe to this transport. */
  enabled?: boolean;
  /** Source-bound subscription identity; changes start a fresh silence window. */
  streamKey?: string;
  /** Silence tolerated before forcing a reconnect. */
  silenceMs?: number;
  /** Watchdog check cadence. */
  tickMs?: number;
  /**
   * Whether a stream is actually being watched. Defaults to true. When false
   * (the chart's candle source has no tick stream, or there is no feed at all)
   * the silence clock does not run and `stalled` stays false: a stream that was
   * never opened cannot be "reconnecting", and saying so would describe a
   * failure that is not happening.
   */
  active?: boolean;
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
  /** Call right after a new EventSource is constructed. Restarts the silence clock; never clears a stall. */
  noteStreamOpened: () => void;
}

/**
 * Watch an SSE stream for silence and ask for a reconnect when it stops.
 *
 * The interval is source-scoped and independent of the retry epoch: a watchdog that triggers a reconnect must not be torn down and
 * rebuilt by that same reconnect, which would reset its own clock and let a
 * dead stream retry once per check instead of once per window.
 */
export function useTickStreamWatchdog(
  opts: TickStreamWatchdogOptions = {},
): TickStreamWatchdog {
  const silenceMs = opts.silenceMs ?? STREAM_SILENCE_MS;
  const tickMs = opts.tickMs ?? STREAM_WATCHDOG_TICK_MS;
  // `active` (Truth line) and `enabled` (source-bound watchdog) mean the same
  // thing: is a stream actually being watched. Either one false turns it off.
  const enabled = (opts.enabled ?? true) && (opts.active ?? true);
  const streamKey = opts.streamKey ?? "default";
  const binding = useMemo(() => ({ enabled, streamKey }), [enabled, streamKey]);
  const bindingRef = useRef(binding);
  useLayoutEffect(() => { bindingRef.current = binding; }, [binding]);
  const [epoch, setEpoch] = useState(0);
  const [status, setStatus] = useState({ binding, stalled: false });
  const lastFrameAtRef = useRef<number>(Date.now());

  const noteFrame = useCallback(() => {
    const current = bindingRef.current;
    if (!current.enabled) return;
    lastFrameAtRef.current = Date.now();
    // Only clear when actually set, so a healthy stream does not re-render on
    // every frame (a chatty feed delivers several per second).
    setStatus(prev => prev.binding === current && !prev.stalled ? prev : {binding: current, stalled: false});
  }, []);

  const noteError = useCallback(() => {
    const current = bindingRef.current;
    if (!current.enabled) return;
    setStatus(prev => prev.binding === current && prev.stalled ? prev : {binding: current, stalled: true});
  }, []);

  const noteStreamOpened = useCallback(() => {
    const current = bindingRef.current;
    if (!current.enabled) return;
    // A fresh stream starts its own silence clock. It does NOT clear a stall:
    // constructing a replacement EventSource proves nothing about delivery,
    // so the chart keeps saying "Reconnecting" until a frame actually arrives
    // (noteFrame) — otherwise the watchdog's own reconnect would hide the
    // badge on a stream that is still silent. A stall recorded for a previous
    // source never shows for this one (the binding check in `stalled` below).
    lastFrameAtRef.current = Date.now();
  }, []);

  useEffect(() => {
    // Nothing is being watched: no silence clock runs, and `stalled` below
    // reads false for this binding, withdrawing any verdict about a previous
    // stream.
    if (!binding.enabled) return;
    // Watching starts now; silence before a stream existed is not a stall.
    lastFrameAtRef.current = Date.now();
    const timer = setInterval(() => {
      if (bindingRef.current !== binding) return;
      if (Date.now() - lastFrameAtRef.current < silenceMs) return;
      // Reset the clock AT the decision, so a stream that stays dead retries
      // once per silence window rather than once per watchdog tick.
      lastFrameAtRef.current = Date.now();
      setStatus({binding, stalled: true});
      setEpoch((n) => n + 1);
    }, tickMs);
    return () => clearInterval(timer);
  }, [binding, silenceMs, tickMs]);

  // A replacement source must never render the previous source's warning,
  // including the first render before passive subscription cleanup runs.
  const stalled = enabled && status.binding === binding && status.stalled;
  return { epoch, stalled, noteFrame, noteError, noteStreamOpened };
}
