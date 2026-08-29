import React, { useState } from "react";
import { Link } from "wouter";
import {
  Plus, X, Radar, Bell, AlertOctagon,
  Target, FlaskConical, Brain, Bot, Eye, ListChecks, Shield, Heart,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useViewMode } from "@/hooks/useViewMode";
import { useProductRole } from "@/hooks/useProductRole";
import { useTraderTier } from "@/hooks/useTraderTier";

export function FloatingActionPanel() {
  const [open, setOpen] = useState(false);
  const { effectiveIsAdmin: isAdmin } = useViewMode();
  const { isInvestor } = useProductRole();
  const { isApprovedTrader } = useTraderTier();
  // Execution quick actions are reserved for APPROVED (live / shared-bridge)
  // traders and admins (Task #768). A pending/unapproved trader (or one
  // whose approval is still loading) sees ONLY the always-available Emergency
  // Kill Switch — never a trade or scanner control.
  const canExecute = isAdmin || isApprovedTrader;
  const close = () => setOpen(false);

  // INVESTOR accounts are view-only — no quick trade/bot actions at all.
  if (isInvestor) return null;

  return (
    <>
      {open && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40 animate-in fade-in duration-150" onClick={() => setOpen(false)} />
      )}
      <div className="fixed bottom-20 md:bottom-6 right-4 md:right-6 z-50 flex flex-col items-end gap-2">
        {open && (
          <div className="flex flex-col items-end gap-2 animate-in fade-in slide-in-from-bottom-2 duration-200 max-h-[75vh] overflow-y-auto pr-1">
            {/* App Shell 2.0 — spec Quick Action Center. Each shortcut routes
                to a safe surface; none execute real broker orders. Trader-safe
                actions show for every (non-investor) session; advanced / operator
                / tester surfaces are gated behind admin so a normal user never
                sees admin tools or `/admin/*` links here. */}
            {canExecute && (
              <>
                <FabAction label="Trade Command Room"   icon={Target}       href="/trade-command-room"      onClick={close} />
                <FabAction label="Run Scanner"          icon={Radar}        href="/market-scanner"          onClick={close} />
                <FabAction label="AI Trade Idea"        icon={Brain}        href="/ai-command-center"       onClick={close} />
                <FabAction label="Risk Command"         icon={Shield}       href="/risk-command-center"     onClick={close} />
                <FabAction label="Alerts"               icon={Bell}         href="/alerts"                  onClick={close} />
              </>
            )}
            {isAdmin && (
              <>
                <FabAction label="Start Demo Test"   icon={FlaskConical} href="/demo-trading"             onClick={close} />
                <FabAction label="Autopilot Observe" icon={Bot}          href="/autopilot-control-center" onClick={close} />
                <FabAction label="Self-Trade AI"     icon={Bot}          href="/self-trade-ai"            onClick={close} />
                <FabAction label="Shadow Mode"       icon={Eye}          href="/testing-lab?tab=shadow"              onClick={close} />
                <FabAction label="Live Intent Queue" icon={ListChecks}   href="/live-intent-queue"        onClick={close} />
                <FabAction label="System Health"     icon={Heart}        href="/admin/system-health"      onClick={close} />
              </>
            )}
            {/* No Start/Pause/Stop Bot control here: PATCH /api/bot/status only
                flips botSettingsTable.isRunning, which no engine reads — the
                toggle was a placebo toast, not a real control. */}
            <FabAction label="Emergency Kill Switch" icon={AlertOctagon} href="/emergency" onClick={close} tone="danger" />
          </div>
        )}
        <Button
          size="icon"
          onClick={() => setOpen(!open)}
          className={cn(
            "h-12 w-12 rounded-full shadow-2xl shadow-black/40 transition-all",
            open ? "bg-muted text-foreground rotate-45" : "bg-primary text-primary-foreground hover:scale-105"
          )}
          aria-label={open ? "Close quick actions" : "Open quick actions"}
          data-testid="fab-toggle"
        >
          {open ? <X size={20} /> : <Plus size={20} />}
        </Button>
      </div>
    </>
  );
}

function FabAction({
  label, icon: Icon, onClick, href, tone = "neutral",
}: { label: string; icon: React.ComponentType<{ size?: number }>; onClick?: () => void; href?: string; tone?: "neutral" | "info" | "warning" | "danger" }) {
  const toneClass = {
    neutral: "bg-card text-foreground hover:bg-muted",
    info: "bg-cyan-500/15 text-cyan-300 hover:bg-cyan-500/25 border-cyan-500/30",
    warning: "bg-amber-500/15 text-amber-300 hover:bg-amber-500/25 border-amber-500/30",
    danger: "bg-red-500/15 text-red-300 hover:bg-red-500/25 border-red-500/30",
  }[tone];

  const inner = (
    <Button
      size="sm"
      onClick={onClick}
      className={cn("h-10 pl-3 pr-4 gap-2 rounded-full border border-border shadow-lg backdrop-blur-md", toneClass)}
      data-testid={`fab-action-${label.toLowerCase().replace(/\s+/g, "-")}`}
    >
      <Icon size={14} />
      <span className="text-xs font-semibold">{label}</span>
    </Button>
  );

  return href ? <Link href={href}>{inner}</Link> : inner;
}
