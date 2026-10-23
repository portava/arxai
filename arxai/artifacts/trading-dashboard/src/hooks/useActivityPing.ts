// Phase 24 — Frontend activity / presence tracking.
//
// SAFETY:
//   * Default + fallback status is UNKNOWN. The backend treats UNKNOWN as a
//     hard block for protective auto-close execution.
//   * The hook NEVER fabricates activity. If the tab is hidden, blurred for
//     too long, or we cannot verify user input recently, status returns to
//     UNKNOWN and the backend is NOT pinged with a stale heartbeat.
//   * Activity is sent per-session via the authenticated POST /me/activity-ping
//     endpoint. The endpoint scopes by req.authUser.id — one user's activity
//     cannot leak to another.
//   * No localStorage persistence — sessions across tabs / users are isolated.

import { useEffect, useRef, useState } from "react";

export type ActivityStatus = "ACTIVE" | "IDLE" | "AWAY" | "UNKNOWN";

interface UseActivityPingOptions {
  /** Min interval between pings to the backend (ms). Default 60_000. */
  pingIntervalMs?: number;
  /** Idle threshold — no user input for this long → IDLE (ms). Default 60_000. */
  idleThresholdMs?: number;
  /** Away threshold — no input or tab hidden for this long → AWAY (ms). Default 300_000 (5 min). */
  awayThresholdMs?: number;
  /** Base URL prefix for the API (defaults to BASE_URL). */
  apiBase?: string;
  /** Disable the hook entirely (e.g. when not authed). */
  enabled?: boolean;
}

export function useActivityPing(opts: UseActivityPingOptions = {}): ActivityStatus {
  const {
    pingIntervalMs = 60_000,
    idleThresholdMs = 60_000,
    awayThresholdMs = 300_000,
    apiBase = import.meta.env.BASE_URL ?? "/",
    enabled = true,
  } = opts;

  const [status, setStatus] = useState<ActivityStatus>("UNKNOWN");
  const lastInputAtRef = useRef<number | null>(null);
  const lastPingAtRef = useRef<number>(0);
  const lastPingedStatusRef = useRef<ActivityStatus | null>(null);

  useEffect(() => {
    if (!enabled) return;

    const base = apiBase.replace(/\/+$/, "");
    const url = `${base}/api/me/activity-ping`;

    const computeStatus = (): ActivityStatus => {
      if (typeof document !== "undefined" && document.hidden) {
        // Tab hidden: AWAY immediately; UNKNOWN if hidden > away threshold AND
        // no recent input. We treat hidden as AWAY at minimum (never ACTIVE).
        const last = lastInputAtRef.current;
        if (last == null) return "UNKNOWN";
        const sinceLast = Date.now() - last;
        if (sinceLast >= awayThresholdMs) return "UNKNOWN";
        return "AWAY";
      }
      const last = lastInputAtRef.current;
      if (last == null) return "UNKNOWN";
      const sinceLast = Date.now() - last;
      if (sinceLast >= awayThresholdMs) return "UNKNOWN";
      if (sinceLast >= idleThresholdMs) return "IDLE";
      return "ACTIVE";
    };

    const sendPing = async (next: ActivityStatus) => {
      // NEVER send a ping for UNKNOWN / AWAY / IDLE — those mean "no fresh
      // activity to assert". The backend's lack of a recent heartbeat is what
      // surfaces UNKNOWN / INACTIVE there. We only assert presence on ACTIVE.
      if (next !== "ACTIVE") return;
      const now = Date.now();
      if (now - lastPingAtRef.current < pingIntervalMs) return;
      lastPingAtRef.current = now;
      try {
        await fetch(url, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kinds: ["app"] }),
        });
      } catch {
        // Network failure should not flip the user's status — backend will
        // naturally treat them as stale → UNKNOWN.
      }
    };

    const refresh = () => {
      const next = computeStatus();
      setStatus((prev) => (prev === next ? prev : next));
      if (next !== lastPingedStatusRef.current || next === "ACTIVE") {
        lastPingedStatusRef.current = next;
        void sendPing(next);
      }
    };

    const onInput = () => {
      lastInputAtRef.current = Date.now();
      refresh();
    };
    const onVisibility = () => {
      if (document.hidden) {
        // Force re-evaluation; do NOT bump last input.
        refresh();
      } else {
        // Coming back to the tab is itself an activity signal.
        onInput();
      }
    };
    const onBlur = () => refresh();

    const inputEvents: Array<keyof WindowEventMap> = ["mousemove", "keydown", "pointerdown", "wheel", "touchstart"];
    inputEvents.forEach((e) => window.addEventListener(e, onInput, { passive: true }));
    window.addEventListener("focus", onInput);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibility);

    // Tick every 15s to demote ACTIVE→IDLE→AWAY→UNKNOWN as time passes.
    const tick = window.setInterval(refresh, 15_000);

    // First load: explicitly UNKNOWN until the user proves presence.
    refresh();

    return () => {
      inputEvents.forEach((e) => window.removeEventListener(e, onInput));
      window.removeEventListener("focus", onInput);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(tick);
    };
  }, [enabled, apiBase, pingIntervalMs, idleThresholdMs, awayThresholdMs]);

  return status;
}
