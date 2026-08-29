import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TrendingUp, TrendingDown, Layers } from "lucide-react";
import { PnLValue } from "./PnLValue";
import { EmptyState } from "./EmptyState";
import { cn } from "@/lib/utils";

export interface ExposureRow {
  symbol: string;
  netLot: number;     // positive = net long, negative = net short
  exposureUsd: number; // notional exposure in USD
  pnl: number;
}

interface Props {
  rows: ExposureRow[];
  totalExposure?: number;
  className?: string;
  loading?: boolean;
}

export function ExposureCard({ rows, totalExposure, className, loading }: Props) {
  const maxAbs = Math.max(1, ...rows.map((r) => Math.abs(r.exposureUsd)));
  const netLong = rows.filter((r) => r.netLot > 0).reduce((s, r) => s + r.exposureUsd, 0);
  const netShort = rows.filter((r) => r.netLot < 0).reduce((s, r) => s + Math.abs(r.exposureUsd), 0);
  const total = totalExposure ?? netLong + netShort;
  const longPct = total > 0 ? (netLong / total) * 100 : 0;

  return (
    <Card className={cn("border-card-border", className)}>
      <CardHeader className="pb-3 border-b border-border">
        <CardTitle className="text-sm font-semibold uppercase tracking-wider flex items-center gap-2">
          <Layers size={14} className="text-primary" />
          Market Exposure
        </CardTitle>
      </CardHeader>
      <CardContent className="p-4 space-y-4">
        {/* Long / Short split bar */}
        <div>
          <div className="flex items-center justify-between text-xs mb-1.5">
            <span className="flex items-center gap-1 text-success font-mono">
              <TrendingUp size={12} /> Long ${netLong.toFixed(0)}
            </span>
            <span className="flex items-center gap-1 text-danger font-mono">
              Short ${netShort.toFixed(0)} <TrendingDown size={12} />
            </span>
          </div>
          <div className="h-2 rounded-full overflow-hidden bg-muted/40 flex">
            <div className="bg-success transition-all duration-500" style={{ width: `${longPct}%` }} />
            <div className="bg-danger transition-all duration-500" style={{ width: `${100 - longPct}%` }} />
          </div>
          <div className="text-[11px] text-muted-foreground mt-1 text-center font-mono">
            Total exposure ${total.toFixed(0)}
          </div>
        </div>

        {/* Per-symbol bars */}
        <div className="space-y-1.5">
          {loading ? (
            <div className="space-y-2">{[0, 1, 2].map((i) => <div key={i} className="h-7 rounded bg-muted/30 animate-pulse" />)}</div>
          ) : rows.length === 0 ? (
            <EmptyState title="No open exposure" description="No active positions in any symbol." />
          ) : (
            rows.map((r) => {
              const isLong = r.netLot > 0;
              const widthPct = (Math.abs(r.exposureUsd) / maxAbs) * 100;
              return (
                <div key={r.symbol} className="flex items-center gap-2">
                  <span className="font-mono text-xs w-20 truncate">{r.symbol}</span>
                  <div className="flex-1 h-5 relative bg-muted/30 rounded overflow-hidden">
                    <div
                      className={cn("h-full transition-all duration-500", isLong ? "bg-success/70" : "bg-danger/70")}
                      style={{ width: `${widthPct}%` }}
                    />
                    <span className={cn("absolute inset-0 flex items-center px-2 text-[10px] font-mono", isLong ? "text-success" : "text-danger")}>
                      {isLong ? "LONG" : "SHORT"} {Math.abs(r.netLot).toFixed(2)} lot
                    </span>
                  </div>
                  <PnLValue value={r.pnl} size="sm" className="w-20 text-right shrink-0" />
                </div>
              );
            })
          )}
        </div>
      </CardContent>
    </Card>
  );
}
