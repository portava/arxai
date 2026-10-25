// Limits in force, layer by layer: the platform ceiling, the operator's
// account limits for this trader, the trader's own settings, and the
// effective value the Risk Governor applies to every order (strictest wins).
// Read-only; it reads GET /api/me/risk-limits/layers, which takes the
// effective values from the governor's own resolver.
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

type Winner = "platform" | "account" | "user" | "default" | "none" | "derived" | "disabled";
interface LayerRow {
  key: string; label: string; unit: "lots" | "%" | "USD" | "x" | "count";
  platform: number | null; account: number | null; user: number | null; effective: number | null;
  source: string; winner: Winner;
}
interface LayersResponse {
  rows: LayerRow[];
  restrictions: { requireStopLoss: boolean; liveAllowed: boolean; allowedSymbols: string[] | null; allowedDirection: "BUY" | "SELL" | null };
}

export const RISK_LIMIT_LAYERS_QUERY_KEY = ["me", "risk-limits", "layers"] as const;

const WINNER_LABEL: Record<Winner, string> = {
  platform: "Platform", account: "Account", user: "You", default: "Default",
  none: "No limit", derived: "Derived", disabled: "Off",
};

function fmt(v: number | null, unit: LayerRow["unit"]): string {
  if (v == null) return "—";
  if (unit === "USD") return `$${v.toLocaleString()}`;
  if (unit === "%") return `${v}%`;
  if (unit === "x") return `${v}x`;
  return String(v);
}

export function RiskLimitLayersPanel() {
  const { data, isLoading, isError } = useQuery<LayersResponse>({
    queryKey: RISK_LIMIT_LAYERS_QUERY_KEY,
    queryFn: async () => {
      const r = await fetch("/api/me/risk-limits/layers", { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
  });

  return (
    <Card className="border-border/50 mb-4" data-testid="risk-limit-layers">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Limits in force</CardTitle>
        <CardDescription className="text-xs">
          Every order is checked against the strictest of the platform ceiling, your account limits set by an
          operator, and your own settings. You can tighten a limit here; you cannot loosen one set above you.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading && <Skeleton className="h-40 w-full" />}
        {isError && <p className="text-xs text-destructive">Could not load your limits. Orders are still checked by the Risk Governor.</p>}
        {data && (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-muted-foreground">
                  <tr className="border-b border-border/50">
                    <th className="text-left font-medium py-1.5 pr-2">Limit</th>
                    <th className="text-right font-medium py-1.5 px-2">Platform</th>
                    <th className="text-right font-medium py-1.5 px-2">Account</th>
                    <th className="text-right font-medium py-1.5 px-2">You</th>
                    <th className="text-right font-medium py-1.5 px-2">In force</th>
                    <th className="text-right font-medium py-1.5 pl-2">Set by</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.key} className="border-b border-border/30" data-testid={`limit-row-${r.key}`}>
                      <td className="py-1.5 pr-2">{r.label}{r.unit === "USD" ? " ($)" : ""}</td>
                      <td className={cn("text-right px-2 tabular-nums", r.winner === "platform" && "font-semibold")}>{fmt(r.platform, r.unit)}</td>
                      <td className={cn("text-right px-2 tabular-nums", r.winner === "account" && "font-semibold")}>{fmt(r.account, r.unit)}</td>
                      <td className={cn("text-right px-2 tabular-nums", r.winner === "user" && "font-semibold")}>{fmt(r.user, r.unit)}</td>
                      <td className="text-right px-2 tabular-nums font-semibold">{fmt(r.effective, r.unit)}</td>
                      <td className="text-right pl-2" title={r.source}>
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0">{WINNER_LABEL[r.winner]}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-muted-foreground mt-2">
              Stop loss {data.restrictions.requireStopLoss ? "required" : "optional"} ·
              {" "}{data.restrictions.liveAllowed ? "live accounts allowed" : "limited to demo by an operator"}
              {data.restrictions.allowedDirection ? ` · ${data.restrictions.allowedDirection} only` : ""}
              {data.restrictions.allowedSymbols ? ` · instruments: ${data.restrictions.allowedSymbols.join(", ")}` : ""}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
