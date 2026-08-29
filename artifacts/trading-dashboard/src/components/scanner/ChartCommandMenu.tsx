// ChartCommandMenu — role-aware right-click / long-press command menu for the
// Scanner chart (Chart Brain v2 Task 6).
//
// SAFETY:
//  - This menu NEVER places a trade. The trade-oriented entries only ask the
//    parent to start a DRAFT (the existing drag-to-shape draft) or adjust a
//    draft level; the actual order still routes through the Global Instant Trade
//    Router and its full 16-gate evaluator. Plan = draft only.
//  - Trade/plan entries render ONLY when the account can actually trade
//    (`canTrade`). Draft-level entries render only when a draft exists
//    (`hasDraft`). No dead buttons: an entry that cannot act is never shown.
//  - Ruby reads, decision receipts and agent-disagreement entries call EXISTING
//    read-only endpoints. They can never move price, fire a trade, or read
//    another user's data.
//  - Replay (review/learning) renders only in review mode (`isReviewMode`).
//  - Mark-level, watch-zone and price-alert entries create per-user, read-only
//    annotations — decision-support artifacts only.

import { useEffect, useRef } from "react";
import { useAssistantName } from "@/lib/assistant-name";
import {
  ArrowDownToLine,
  ArrowUpToLine,
  Bell,
  Minus,
  TrendingUp,
  TrendingDown,
  Sparkles,
  HelpCircle,
  Lightbulb,
  ShieldAlert,
  Users,
  ReceiptText,
  Eye,
  Crosshair,
  Target,
  History,
} from "lucide-react";

export type ChartCommandAnchor = { x: number; y: number; price: number };

export type RubyChartIntent =
  | "analyze"
  | "is-this-a-buy"
  | "why-not-now"
  | "what-changes-my-mind"
  | "what-invalidates"
  | "agent-consensus";

interface ChartCommandMenuProps {
  anchor: ChartCommandAnchor;
  canTrade: boolean;
  hasDraft: boolean;
  isReviewMode: boolean;
  fmt: (n: number) => string;
  busy: boolean;
  onPlan: (side: "BUY" | "SELL", price: number) => void;
  onMarkLevel: (kind: "SUPPORT" | "RESISTANCE", price: number) => void;
  onWatchZone: (price: number) => void;
  onPriceAlert: (direction: "above" | "below", price: number) => void;
  onSetDraftLevel: (kind: "SL" | "TP", price: number) => void;
  onAskRuby: (intent: RubyChartIntent, price: number) => void;
  onShowReceipt: () => void;
  onReplay: () => void;
  onClose: () => void;
}

export function ChartCommandMenu({
  anchor,
  canTrade,
  hasDraft,
  isReviewMode,
  fmt,
  busy,
  onPlan,
  onMarkLevel,
  onWatchZone,
  onPriceAlert,
  onSetDraftLevel,
  onAskRuby,
  onShowReceipt,
  onReplay,
  onClose,
}: ChartCommandMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const { name } = useAssistantName();

  // Dismiss on outside-click / Escape so the menu never lingers as a dead
  // overlay over the chart.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const Item = ({
    icon,
    label,
    onClick,
    tone,
  }: {
    icon: React.ReactNode;
    label: string;
    onClick: () => void;
    tone?: string;
  }) => (
    <button
      type="button"
      disabled={busy}
      className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted disabled:opacity-50 ${tone ?? "text-foreground"}`}
      onClick={() => {
        onClick();
        onClose();
      }}
    >
      {icon}
      <span>{label}</span>
    </button>
  );

  const Divider = () => <div className="my-1 h-px bg-muted" />;

  return (
    <div
      ref={ref}
      data-testid="scanner-chart-command-menu"
      className="absolute z-30 max-h-[80vh] w-56 overflow-y-auto rounded-md border border-border bg-background/95 p-1 shadow-xl backdrop-blur"
      style={{
        left: Math.max(4, Math.min(anchor.x, 9999)),
        top: Math.max(4, anchor.y),
      }}
    >
      <div className="px-2 py-1 font-mono text-[10px] text-txt-muted">
        @ {fmt(anchor.price)}
      </div>

      {/* ── Plan (draft only; canTrade) ─────────────────────────────────── */}
      {canTrade ? (
        <>
          <Item
            icon={<TrendingUp className="h-3.5 w-3.5 text-primary" />}
            label="Plan Buy here"
            tone="text-primary"
            onClick={() => onPlan("BUY", anchor.price)}
          />
          <Item
            icon={<TrendingDown className="h-3.5 w-3.5 text-premium" />}
            label="Plan Sell here"
            tone="text-premium"
            onClick={() => onPlan("SELL", anchor.price)}
          />
          {hasDraft ? (
            <>
              <Item
                icon={<Crosshair className="h-3.5 w-3.5 text-danger" />}
                label="Set invalidation (SL) here"
                onClick={() => onSetDraftLevel("SL", anchor.price)}
              />
              <Item
                icon={<Target className="h-3.5 w-3.5 text-success" />}
                label="Set take-profit here"
                onClick={() => onSetDraftLevel("TP", anchor.price)}
              />
            </>
          ) : null}
          <Divider />
        </>
      ) : null}

      {/* ── Ask Ruby (read-only) ────────────────────────────────────────── */}
      <Item
        icon={<Sparkles className="h-3.5 w-3.5 text-premium" />}
        label={`Ask ${name} about this candle`}
        tone="text-premium"
        onClick={() => onAskRuby("analyze", anchor.price)}
      />
      <Item
        icon={<Lightbulb className="h-3.5 w-3.5 text-warning" />}
        label="Explain this candle"
        onClick={() => onAskRuby("is-this-a-buy", anchor.price)}
      />
      <Item
        icon={<HelpCircle className="h-3.5 w-3.5 text-ruby" />}
        label="Why not now?"
        onClick={() => onAskRuby("why-not-now", anchor.price)}
      />
      <Item
        icon={<Lightbulb className="h-3.5 w-3.5 text-ruby" />}
        label={`What would change ${name}'s mind?`}
        onClick={() => onAskRuby("what-changes-my-mind", anchor.price)}
      />
      <Item
        icon={<ShieldAlert className="h-3.5 w-3.5 text-danger" />}
        label="What invalidates this?"
        onClick={() => onAskRuby("what-invalidates", anchor.price)}
      />
      <Item
        icon={<Users className="h-3.5 w-3.5 text-primary" />}
        label="Show agent disagreement"
        onClick={() => onAskRuby("agent-consensus", anchor.price)}
      />
      <Item
        icon={<ReceiptText className="h-3.5 w-3.5 text-ruby" />}
        label="Save decision receipt"
        onClick={() => onShowReceipt()}
      />

      <Divider />

      {/* ── Annotations (per-user, read-only) ───────────────────────────── */}
      <Item
        icon={<ArrowDownToLine className="h-3.5 w-3.5 text-success" />}
        label="Mark support here"
        onClick={() => onMarkLevel("SUPPORT", anchor.price)}
      />
      <Item
        icon={<ArrowUpToLine className="h-3.5 w-3.5 text-danger" />}
        label="Mark resistance here"
        onClick={() => onMarkLevel("RESISTANCE", anchor.price)}
      />
      <Item
        icon={<Eye className="h-3.5 w-3.5 text-ruby" />}
        label="Create watch zone here"
        onClick={() => onWatchZone(anchor.price)}
      />
      <Divider />
      <Item
        icon={<Bell className="h-3.5 w-3.5 text-warning" />}
        label="Alert when price ↑ crosses"
        onClick={() => onPriceAlert("above", anchor.price)}
      />
      <Item
        icon={<Minus className="h-3.5 w-3.5 text-warning" />}
        label="Alert when price ↓ crosses"
        onClick={() => onPriceAlert("below", anchor.price)}
      />

      {/* ── Replay (review/learning only) ───────────────────────────────── */}
      {isReviewMode ? (
        <>
          <Divider />
          <Item
            icon={<History className="h-3.5 w-3.5 text-txt-secondary" />}
            label="Replay from here"
            onClick={() => onReplay()}
          />
        </>
      ) : null}
    </div>
  );
}

export default ChartCommandMenu;
