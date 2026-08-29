// Environment badge — spec-mandated environment label colors.
// Never claims FUTURE_MT5_LIVE is "active" while MT5 is deferred.
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type EnvLabel =
  | "PAPER" | "DEMO_SIMULATOR" | "LIVE_TESTER_INTENT"
  | "SHADOW" | "FORWARD_TEST"
  | "FUTURE_MT5_DEMO" | "FUTURE_MT5_LIVE";

const TONE: Record<EnvLabel, string> = {
  PAPER:               "bg-success/15 text-success border-success/30",
  DEMO_SIMULATOR:      "bg-success/15 text-success border-success/30",
  LIVE_TESTER_INTENT:  "bg-warning/15 text-warning border-warning/30",
  SHADOW:              "bg-ruby/15 text-ruby border-ruby/30",
  FORWARD_TEST:        "bg-ruby/15 text-ruby border-ruby/30",
  FUTURE_MT5_DEMO:     "bg-muted text-txt-secondary border-border/30",
  FUTURE_MT5_LIVE:     "bg-muted text-txt-secondary border-border/30",
};

export function EnvironmentBadge({ env, className }: { env: EnvLabel; className?: string }) {
  return <Badge variant="outline" className={cn("font-mono text-[10px] uppercase tracking-wide", TONE[env], className)}>{env}</Badge>;
}
