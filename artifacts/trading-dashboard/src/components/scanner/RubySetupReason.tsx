import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { RubyReasoningBlock } from "@/components/ruby/RubyReasoningBlock";
import { buildReasoningFromSetupReason } from "@/lib/rubyReasoningBlock";
import { useAssistantName } from "@/lib/assistant-name";

const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

export type SignalContext = {
  symbol: string;
  timeframe?: string;
  recommendedAction: string;
  bias: string;
  confidenceScore?: number;
  riskScore?: number;
  entrySniperScore?: number;
  reasonForTrade?: string;
  reasonToAvoid?: string;
  setupType?: string;
  entry?: number;
  stopLoss?: number;
  takeProfit?: number;
  statusBadge?: string;
  /**
   * Risk-based lot the producing engine computed from broker truth, or null
   * when it deliberately refused to size (insufficient margin, flame kill,
   * risk below the minimum lot). Consumers must treat null as "no size
   * computed" and fall back to their own conservative default — never invent
   * one (Theme D1).
   */
  suggestedLot?: number | null;
};

export type SetupReason = {
  bias: "BUY" | "SELL" | "NEUTRAL";
  hedge: string;
  why: string;
  risk: string;
  invalidation: string;
  possibleTpArea: string;
  suggestedStopArea: string;
  confidenceLabel: string;
  confidenceScore: number;
  cautions: string[];
  disclaimer: string;
};

// Ruby's Setup Reason — small, hedged explanation surfaced inside scanner
// cards and the trade modal. Deterministic server response (no LLM call),
// so it's fast, free, and never claims a "guaranteed trade".
export function RubySetupReason({ signal, dense = false }: { signal: SignalContext; dense?: boolean }) {
  const { name } = useAssistantName();
  const [reason, setReason] = useState<SetupReason | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setReason(null);
    setErr(null);
    (async () => {
      try {
        const r = await fetch(`${BASE}/api/me/assistant/explain-signal`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(signal),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as { setupReason: SetupReason };
        if (!cancelled) setReason(j.setupReason);
      } catch (e) {
        if (!cancelled) setErr(String((e as Error).message ?? e));
      }
    })();
    return () => { cancelled = true; };
  }, [
    signal.symbol, signal.timeframe, signal.recommendedAction, signal.bias,
    signal.confidenceScore, signal.riskScore, signal.entrySniperScore,
    signal.setupType, signal.reasonForTrade, signal.reasonToAvoid,
    signal.entry, signal.stopLoss, signal.takeProfit, signal.statusBadge,
  ]);

  const tone =
    reason?.bias === "BUY" ? "border-emerald-500/40 bg-emerald-500/5" :
    reason?.bias === "SELL" ? "border-rose-500/40 bg-rose-500/5" :
    "border-slate-500/40 bg-slate-500/5";

  return (
    <div className={`rounded border ${tone} p-2 text-[11px] leading-snug space-y-1`} data-testid="ruby-setup-reason">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-fuchsia-300">
        <Sparkles className="h-3 w-3" />
        {name}'s Setup Reason
      </div>
      {!reason && !err && <div className="text-muted-foreground italic">{name} is reading the setup…</div>}
      {err && <div className="text-rose-400">{name} couldn't load this setup ({err}).</div>}
      {reason && (
        <>
          {/* Standardized, always-visible Ruby Reasoning Block — same labeled
              format as every other surface. Never behind a collapse. */}
          <RubyReasoningBlock
            data={buildReasoningFromSetupReason({
              reason,
              symbol: signal.symbol,
              patternLabel: signal.setupType ?? null,
              // The setup-reason payload carries no news/economic-calendar read,
              // so this surface honestly states the calendar is unavailable here
              // (the NEWS_UNAVAILABLE_NOTE contract) rather than implying it was
              // checked.
              newsUnavailable: true,
            })}
            dense={dense}
            testid="ruby-setup-reason-reasoning"
          />
          <div className="text-[10px] text-muted-foreground italic pt-0.5">{reason.disclaimer}</div>
          <MasterBridgeNote />
        </>
      )}
    </div>
  );
}

// Ruby copy — Centralized Master MT5 Bridge (Slice 1+2).
// One line on where orders from this ticket would route, taken from
// /api/me/routing-status. That route resolves DEMO routing and always reports
// live as locked (safetyMode paper_only), so the note names the shared master
// DEMO bridge — never a live one. Blocked routing (ok:false) is said to be
// blocked rather than described as a working route. Nothing is shown for
// user-owned routing or when the status could not be read. The query key is
// invalidated by My Account's Bridge Preference switch, so the note follows a
// switch instead of keeping the answer from when it first mounted.
export const ROUTING_STATUS_QUERY_KEY = ["me", "routing-status"] as const;

type RoutingStatus = {
  ok?: boolean;
  effectiveRoutingMode?: string;
  liveLocked?: boolean;
};

function MasterBridgeNote() {
  const q = useQuery<RoutingStatus | null>({
    queryKey: ROUTING_STATUS_QUERY_KEY,
    queryFn: async () => {
      const r = await fetch(`${BASE}/api/me/routing-status`, { credentials: "include" });
      if (!r.ok) return null;
      return (await r.json()) as RoutingStatus;
    },
    staleTime: 15_000,
  });
  const j = q.data;
  if (!j || j.effectiveRoutingMode !== "SHARED_MASTER_MT5") return null;
  return (
    <div
      className="text-[10px] text-amber-300/80 italic pt-1 border-t border-slate-700/40"
      data-testid="ruby-setup-master-bridge-note"
      data-routing-ok={j.ok === true ? "true" : "false"}
    >
      {j.ok === true
        ? `Demo orders from this ticket route through the platform's shared master demo bridge, not your own MT5.${j.liveLocked === false ? "" : " Live trading is locked on this route."} Risk limits apply per your account settings.`
        : "Your account is set to the shared master demo bridge, but that routing is blocked right now, so orders from this ticket cannot route through it."}
    </div>
  );
}
