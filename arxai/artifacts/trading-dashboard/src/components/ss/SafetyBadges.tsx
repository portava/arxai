import { Badge } from "@/components/ui/badge";
import { Lock, ShieldOff, Eye, Beaker } from "lucide-react";
import { cn } from "@/lib/utils";

export function PaperOnlyBadge({ className }: { className?: string }) {
  return (
    <Badge variant="outline" className={cn("bg-blue-500/15 text-blue-600 border-blue-500/30 font-semibold", className)} aria-label="Demo trading only"
      data-arx-id="badge-paper-only" data-arx-label="DEMO ONLY" data-arx-type="badge" data-arx-help-topic="badge-paper-only">
      <Lock className="h-3 w-3 mr-1" aria-hidden="true" />DEMO ONLY
    </Badge>
  );
}

export function LiveDisabledBadge({ className }: { className?: string }) {
  return (
    <Badge variant="outline" className={cn("bg-red-500/15 text-red-600 border-red-500/30 font-semibold", className)} aria-label="Live trading is disabled"
      data-arx-id="badge-live-trading-disabled" data-arx-label="LIVE DISABLED" data-arx-type="badge" data-arx-help-topic="badge-live-trading-disabled">
      <ShieldOff className="h-3 w-3 mr-1" aria-hidden="true" />LIVE DISABLED
    </Badge>
  );
}

export function ReadOnlyBadge({ className }: { className?: string }) {
  return (
    <Badge variant="outline" className={cn("bg-amber-500/15 text-amber-600 border-amber-500/30 font-semibold", className)} aria-label="Read only"
      data-arx-id="badge-broker-readonly" data-arx-label="READ ONLY" data-arx-type="badge" data-arx-help-topic="badge-broker-readonly">
      <Eye className="h-3 w-3 mr-1" aria-hidden="true" />READ ONLY
    </Badge>
  );
}

export function ReplayOnlyBadge({ className }: { className?: string }) {
  return (
    <Badge variant="outline" className={cn("bg-purple-500/15 text-purple-600 border-purple-500/30 font-semibold", className)} aria-label="Replay simulation only"
      data-arx-id="badge-simulator-mode" data-arx-label="REPLAY ONLY" data-arx-type="badge" data-arx-help-topic="badge-simulator-mode">
      <Beaker className="h-3 w-3 mr-1" aria-hidden="true" />REPLAY ONLY
    </Badge>
  );
}

export function SafetyBadgeRow({ readOnly = false, replayOnly = false, className }: { readOnly?: boolean; replayOnly?: boolean; className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      <PaperOnlyBadge />
      <LiveDisabledBadge />
      {readOnly && <ReadOnlyBadge />}
      {replayOnly && <ReplayOnlyBadge />}
    </div>
  );
}
