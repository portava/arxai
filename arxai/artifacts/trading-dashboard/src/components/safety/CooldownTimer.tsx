import React from "react";
import { Clock } from "lucide-react";
import { cn } from "@/lib/utils";

function formatRemaining(ms: number): string {
  if (ms <= 0) return "expired";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function CooldownTimer({ endTimeIso, className }: { endTimeIso: string; className?: string }) {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const end = new Date(endTimeIso).getTime();
  const remaining = end - now;
  return (
    <div className={cn("inline-flex items-center gap-1.5 text-xs text-slate-300", className)}>
      <Clock size={12} />
      <span>cooldown: {formatRemaining(remaining)}</span>
    </div>
  );
}
