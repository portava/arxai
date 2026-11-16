// useOneClickMode — the single hook every one-click surface reads.
//
// Reads the user's one-click settings + arm status (same React Query keys the
// existing ticket, badge and settings card use, so one answer is shared) and
// the unified account mode, then derives ONE view: is one-click mode ON for
// this account, can it be turned on, and with which default lot.
//
// It also owns the two actions the mode needs:
//   enable()  — live: POST /me/one-click/arm {agreed:true} (the server re-runs
//               the arm gate: bridge, master-live access, default lot);
//               demo: PUT /me/one-click {scope:"demo", enable:true}.
//   disable() — the reverse. Always allowed.
// and the two trade actions a one-click surface fires:
//   execute({side, symbol, volume, ...}) — live: instant-trade router
//               (oneClick:true, every server gate still runs); demo: the
//               demo-command chain (draft → confirm → dispatch → fill).
//   closePosition({ticket, symbol, side, volume}) — same split.
//
// Nothing here bypasses a server gate. The mode only removes the client-side
// ticket and confirmation dialogs, which is what "one-click, like MT5" means.

import { useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTradingMode } from "@/hooks/useTradingMode";
import { executeInstantTrade, type InstantTradeSource } from "@/lib/instantTradeRouter";
import {
  deriveOneClickMode,
  runDemoCommand,
  type OneClickModeView,
  type OneClickScope,
  type OneClickSettings,
  type OneClickStatus,
} from "@/lib/oneClickMode";

const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

export const ONE_CLICK_SETTINGS_KEY = ["one-click", "settings"] as const;
export const ONE_CLICK_STATUS_KEY = ["one-click-status"] as const;

export type OneClickTradeResult = {
  ok: boolean;
  /** Short status word for the toast: "sent" for live accept, demo terminal status, or error code. */
  status: string;
  reason: string | null;
  commandId: string | null;
};

export type OneClickExecuteArgs = {
  side: "BUY" | "SELL";
  symbol: string;
  volume: number;
  stopLoss?: number | null;
  takeProfit?: number | null;
  source: InstantTradeSource;
  /** Demo queue attribution (sourcePage). Defaults to ONE_CLICK_<source>. */
  sourcePage?: string;
};

export type OneClickCloseArgs = {
  ticket: string;
  symbol: string;
  side?: string | null;
  volume?: number | null;
  source: InstantTradeSource;
  sourcePage?: string;
};

export interface UseOneClickModeResult {
  mode: OneClickModeView;
  settings: OneClickSettings | null;
  status: OneClickStatus | null;
  /** True while enable/disable is in flight. */
  switching: boolean;
  /** Ticket or `${side}-${symbol}` currently executing, else null. */
  busyKey: string | null;
  enable: () => Promise<{ ok: boolean; error: string | null }>;
  disable: () => Promise<{ ok: boolean; error: string | null }>;
  execute: (args: OneClickExecuteArgs) => Promise<OneClickTradeResult>;
  closePosition: (args: OneClickCloseArgs) => Promise<OneClickTradeResult>;
  refresh: () => Promise<void>;
}

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}${path}`, { credentials: "include" });
  if (!r.ok) throw new Error(`${path} failed: ${r.status}`);
  return (await r.json()) as T;
}

async function postJson(path: string, body: unknown, method: "POST" | "PUT" = "POST"): Promise<{ ok: boolean; error: string | null; data: Record<string, unknown> }> {
  const r = await fetch(`${BASE}${path}`, {
    method, credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  let data: Record<string, unknown> = {};
  try { data = (await r.json()) as Record<string, unknown>; } catch { /* no body */ }
  const ok = r.ok && data.ok !== false;
  const error = ok ? null : String(data.blockReason ?? data.error ?? data.reason ?? `HTTP ${r.status}`);
  return { ok, error, data };
}

export function useOneClickMode(): UseOneClickModeResult {
  const qc = useQueryClient();
  const trading = useTradingMode();
  const [switching, setSwitching] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const settingsQ = useQuery<OneClickSettings>({
    queryKey: [...ONE_CLICK_SETTINGS_KEY],
    queryFn: () => getJson<OneClickSettings>("/api/me/one-click"),
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
  const statusQ = useQuery<OneClickStatus>({
    queryKey: [...ONE_CLICK_STATUS_KEY],
    queryFn: () => getJson<OneClickStatus>("/api/me/one-click/status"),
    staleTime: 15_000,
    refetchInterval: 30_000,
    // Status is a live-arm concept; demo users only need settings.
    enabled: trading.isLiveShared,
  });

  const mode = useMemo(
    () => deriveOneClickMode({
      settings: settingsQ.data ?? null,
      status: statusQ.data ?? null,
      isLiveShared: trading.isLiveShared,
      isDemo: trading.isDemo,
      loading: trading.isLoading || settingsQ.isLoading || (trading.isLiveShared && statusQ.isLoading),
    }),
    [settingsQ.data, statusQ.data, settingsQ.isLoading, statusQ.isLoading, trading.isLiveShared, trading.isDemo, trading.isLoading],
  );

  const refresh = useCallback(async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: [...ONE_CLICK_SETTINGS_KEY] }),
      qc.invalidateQueries({ queryKey: [...ONE_CLICK_STATUS_KEY] }),
    ]);
  }, [qc]);

  const flip = useCallback(async (scope: OneClickScope, enable: boolean) => {
    setSwitching(true);
    try {
      if (scope === "live") {
        if (enable) {
          const r = await postJson("/api/me/one-click/arm", { agreed: true });
          return { ok: r.ok, error: r.error };
        }
        const a = await postJson("/api/me/one-click/disarm", {});
        // The live flag can also keep the router open; clear it too so OFF means OFF.
        const b = await postJson("/api/me/one-click", { scope: "live", enable: false }, "PUT");
        return { ok: a.ok && b.ok, error: a.error ?? b.error };
      }
      const r = await postJson("/api/me/one-click", { scope: "demo", enable }, "PUT");
      return { ok: r.ok, error: r.error };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    } finally {
      setSwitching(false);
      void refresh();
    }
  }, [refresh]);

  const enable = useCallback(async () => {
    if (!mode.scope) return { ok: false, error: mode.blockReason ?? "One-click is not available for this account mode." };
    return flip(mode.scope, true);
  }, [flip, mode.scope, mode.blockReason]);

  const disable = useCallback(async () => {
    if (!mode.scope) return { ok: true, error: null };
    return flip(mode.scope, false);
  }, [flip, mode.scope]);

  const execute = useCallback(async (args: OneClickExecuteArgs): Promise<OneClickTradeResult> => {
    const scope = mode.scope;
    if (!scope || !mode.on) {
      return { ok: false, status: "ONE_CLICK_OFF", reason: "One-click mode is off. Turn it on first.", commandId: null };
    }
    const key = `${args.side}-${args.symbol}`;
    setBusyKey(key);
    try {
      if (scope === "live") {
        const res = await executeInstantTrade({
          source: args.source,
          action: args.side,
          accountMode: "live",
          symbol: args.symbol,
          volume: args.volume,
          orderType: args.side === "BUY" ? "MARKET_BUY" : "MARKET_SELL",
          stopLoss: args.stopLoss ?? null,
          takeProfit: args.takeProfit ?? null,
          oneClick: true,
        });
        return {
          ok: res.ok,
          status: res.ok ? "sent" : (res.primaryReason || res.error || "REJECTED"),
          reason: res.ok ? null : (res.primaryReason || res.error || null),
          commandId: res.commandId ?? null,
        };
      }
      const sourcePage = args.sourcePage ?? `ONE_CLICK_${args.source.toUpperCase()}`;
      const out = await runDemoCommand(BASE, "PLACE_MARKET_ORDER", {
        symbol: args.symbol,
        volume: args.volume,
        side: args.side,
        orderType: args.side === "BUY" ? "MARKET_BUY" : "MARKET_SELL",
        stopLoss: args.stopLoss ?? null,
        takeProfit: args.takeProfit ?? null,
        notes: null,
        idempotencyKey: `oneclick-${args.symbol}-${args.side}-${Date.now()}`,
        source: sourcePage,
        sourcePage,
      });
      return out;
    } catch (e) {
      return { ok: false, status: "ERROR", reason: (e as Error).message, commandId: null };
    } finally {
      setBusyKey(null);
    }
  }, [mode.on, mode.scope]);

  const closePosition = useCallback(async (args: OneClickCloseArgs): Promise<OneClickTradeResult> => {
    const scope = mode.scope;
    if (!scope) {
      return { ok: false, status: "NO_SCOPE", reason: "Trading is not available for this account mode.", commandId: null };
    }
    setBusyKey(args.ticket);
    try {
      if (scope === "live") {
        const res = await executeInstantTrade({
          source: args.source,
          action: "CLOSE",
          accountMode: "live",
          positionId: args.ticket,
          oneClick: true,
        });
        return {
          ok: res.ok,
          status: res.ok ? "sent" : (res.primaryReason || res.error || "REJECTED"),
          reason: res.ok ? null : (res.primaryReason || res.error || null),
          commandId: res.commandId ?? null,
        };
      }
      const sourcePage = args.sourcePage ?? `ONE_CLICK_${args.source.toUpperCase()}_CLOSE`;
      return await runDemoCommand(BASE, "CLOSE_POSITION", {
        symbol: args.symbol,
        side: args.side ?? undefined,
        volume: args.volume ?? undefined,
        brokerTicket: args.ticket,
        ticket: args.ticket,
        positionTicket: args.ticket,
        source: sourcePage,
        sourcePage,
        idempotencyKey: `oneclick-close-${args.ticket}-${Date.now()}`,
      });
    } catch (e) {
      return { ok: false, status: "ERROR", reason: (e as Error).message, commandId: null };
    } finally {
      setBusyKey(null);
    }
  }, [mode.scope]);

  return {
    mode,
    settings: settingsQ.data ?? null,
    status: statusQ.data ?? null,
    switching,
    busyKey,
    enable,
    disable,
    execute,
    closePosition,
    refresh,
  };
}
