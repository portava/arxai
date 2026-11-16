// Environment badge — spec-mandated environment label colors.
// Never claims FUTURE_MT5_LIVE is "active" while MT5 is deferred.
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type EnvLabel =
  | "PAPER" | "DEMO_SIMULATOR" | "LIVE_TESTER_INTENT"
  | "SHADOW" | "FORWARD_TEST"
  | "FUTURE_MT5_DEMO" | "FUTURE_MT5_LIVE";

const TONE: Record<EnvLabel, string> = {
  PAPER:               "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  DEMO_SIMULATOR:      "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  LIVE_TESTER_INTENT:  "bg-amber-500/15 text-amber-300 border-amber-500/30",
  SHADOW:              "bg-sky-500/15 text-sky-300 border-sky-500/30",
  FORWARD_TEST:        "bg-sky-500/15 text-sky-300 border-sky-500/30",
  FUTURE_MT5_DEMO:     "bg-zinc-500/15 text-zinc-300 border-zinc-500/30",
  FUTURE_MT5_LIVE:     "bg-zinc-500/15 text-zinc-300 border-zinc-500/30",
};

export function EnvironmentBadge({ env, className }: { env: EnvLabel; className?: string }) {
  return <Badge variant="outline" className={cn("font-mono text-[10px] uppercase tracking-wide", TONE[env], className)}>{env}</Badge>;
}
