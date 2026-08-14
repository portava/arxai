import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChartOverlay } from "@/lib/chart-overlays";
import {
  type SetupPreview,
  type SetupPreviewStatus,
  type DrawSetupResponse,
  deriveStatus,
  isExpired,
} from "@/lib/setup-preview";
import {
  setupPreviewToCommands,
  aiChartCommandsToOverlays,
} from "@/lib/ai-chart-commands";

// useChartSetupPreview — Task #374 AI/Ruby "draw a setup" client controller.
//
// Asks the READ-ONLY server endpoint (`POST /api/me/assistant/draw-setup`) to
// produce a SETUP PREVIEW for the symbol/timeframe on screen, then maps it —
// through the bounded AiChartCommand contract — into pure `source:"preview"`
// ChartOverlay rows the existing renderer already understands.
//
// HONESTY / SAFETY:
//   - A preview is a DRAWING, never an order. This hook can never place, modify,
//     or close a trade; it only fetches + holds ephemeral preview state.
//   - User-initiated ONLY: a draw happens when `requestDraw()` is called, never
//     per candle/tick. A short throttle blocks accidental rapid re-requests.
//   - SUPPRESSED when the chart feed is not AI-confirmed (`aiUsable=false`):
//     overlays go empty and a reason surfaces — no drawing on an unverified feed.
//   - Lifecycle (preview → user_confirmed/discarded, or → stale on expiry) is
//     ephemeral client state; it never persists and never touches order tables.
//   - Any fetch failure draws NOTHING and never throws into the chart.

const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
const u = (p: string) => `${BASE}${p}`;

/** Minimum gap between user-initiated draws (defence against rapid clicks). */
const DRAW_THROTTLE_MS = 4_000;

export type SetupPreviewRequestStatus =
  | "idle"
  | "loading"
  | "ok"
  | "suppressed"
  | "error";

export interface UseChartSetupPreviewArgs {
  symbol: string;
  timeframe: string;
  /** Level-3 feed verdict for the on-screen chart. When false, draws are suppressed. */
  aiUsable: boolean;
}

export interface UseChartSetupPreview {
  preview: SetupPreview | null;
  status: SetupPreviewRequestStatus;
  /** Lifecycle status of the held preview (preview/user_confirmed/discarded/stale). */
  lifecycle: SetupPreviewStatus;
  error: string | null;
  overlays: ChartOverlay[];
  /** True when a held preview has aged past its server expiry. */
  expired: boolean;
  requestDraw: (side?: "BUY" | "SELL") => void;
  confirm: () => void;
  discard: () => void;
  clear: () => void;
}

export function useChartSetupPreview(
  args: UseChartSetupPreviewArgs,
): UseChartSetupPreview {
  const { symbol, timeframe, aiUsable } = args;
  const [preview, setPreview] = useState<SetupPreview | null>(null);
  const [status, setStatus] = useState<SetupPreviewRequestStatus>("idle");
  const [lifecycle, setLifecycle] = useState<SetupPreviewStatus>("preview");
  const [error, setError] = useState<string | null>(null);
  const [, forceTick] = useState(0);

  const lastDrawAt = useRef(0);
  const inFlight = useRef(false);
  const reqSeq = useRef(0);

  // Reset everything when the symbol or timeframe changes — a drawing is only
  // ever valid for the exact chart it was produced against.
  useEffect(() => {
    setPreview(null);
    setStatus(aiUsable ? "idle" : "suppressed");
    setLifecycle("preview");
    setError(null);
    reqSeq.current += 1; // invalidate any in-flight response for the old chart
  }, [symbol, timeframe, aiUsable]);

  // Re-evaluate expiry on an interval while a live preview is held, so the UI
  // flips to "stale" without a user action. Cleared once nothing is pending.
  useEffect(() => {
    if (!preview) return;
    if (lifecycle === "user_confirmed" || lifecycle === "discarded") return;
    const id = window.setInterval(() => {
      if (isExpired(preview)) forceTick((n) => n + 1);
    }, 1_000);
    return () => window.clearInterval(id);
  }, [preview, lifecycle]);

  const requestDraw = useCallback(
    (side?: "BUY" | "SELL") => {
      if (!aiUsable) {
        setStatus("suppressed");
        setError("Chart feed isn't confirmed yet — I won't draw a setup on an unverified chart.");
        return;
      }
      const now = Date.now();
      if (inFlight.current) return;
      if (now - lastDrawAt.current < DRAW_THROTTLE_MS) return;
      lastDrawAt.current = now;
      inFlight.current = true;
      const mySeq = ++reqSeq.current;
      setStatus("loading");
      setError(null);
      void (async () => {
        try {
          const r = await fetch(u("/api/me/assistant/draw-setup"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ symbol, timeframe, aiUsable, side: side ?? null }),
          });
          if (!r.ok) throw new Error(`draw-setup ${r.status}`);
          const body = (await r.json()) as DrawSetupResponse;
          // Ignore a stale response if the chart changed mid-flight.
          if (mySeq !== reqSeq.current) return;
          if (!body?.setupPreview) throw new Error("empty preview");
          setPreview(body.setupPreview);
          setLifecycle("preview");
          setStatus("ok");
        } catch (e) {
          if (mySeq !== reqSeq.current) return;
          setStatus("error");
          setError(e instanceof Error ? e.message : "Could not draw a setup right now.");
          setPreview(null);
        } finally {
          // Always release the in-flight guard. Only one request is ever in
          // flight at a time (requestDraw bails at the top while inFlight), so
          // clearing unconditionally is safe — and clearing it conditionally on
          // mySeq===reqSeq.current would leak the guard forever whenever the
          // chart (symbol/timeframe) changed mid-request, deadlocking all
          // future draws. The stale-response guards above still discard the
          // state updates from an out-of-date request.
          inFlight.current = false;
        }
      })();
    },
    [aiUsable, symbol, timeframe],
  );

  const confirm = useCallback(() => setLifecycle("user_confirmed"), []);
  const discard = useCallback(() => {
    setLifecycle("discarded");
    setPreview(null);
  }, []);
  const clear = useCallback(() => {
    setPreview(null);
    setLifecycle("preview");
    setStatus(aiUsable ? "idle" : "suppressed");
    setError(null);
    reqSeq.current += 1;
  }, [aiUsable]);

  // Effective lifecycle accounts for expiry (preview → stale) without mutating
  // a confirmed/discarded status.
  const effectiveLifecycle = preview
    ? deriveStatus(preview, lifecycle)
    : lifecycle;
  const expired = preview ? isExpired(preview) : false;

  // Overlays: suppressed feed, no preview, a discarded/stale drawing → none.
  const overlays = useMemo<ChartOverlay[]>(() => {
    if (!aiUsable) return [];
    if (!preview) return [];
    if (effectiveLifecycle === "discarded" || effectiveLifecycle === "stale") return [];
    return aiChartCommandsToOverlays(setupPreviewToCommands(preview));
  }, [aiUsable, preview, effectiveLifecycle]);

  return {
    preview,
    status,
    lifecycle: effectiveLifecycle,
    error,
    overlays,
    expired,
    requestDraw,
    confirm,
    discard,
    clear,
  };
}
