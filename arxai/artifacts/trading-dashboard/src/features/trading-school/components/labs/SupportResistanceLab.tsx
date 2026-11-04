/**
 * SupportResistanceLab — tap/click the practice chart to place horizontal
 * zones, then check them against the scenario's predefined zones with a pip
 * tolerance (pure gradeZones helper). Shows which zones were hit or missed and
 * any stray levels. Practice data only.
 */
import { useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { cn } from "@/lib/utils";
import { ZONE_SCENARIO } from "../../data/labs";
import { gradeZones } from "../../lib/labMath";
import { PracticeChart, type ChartGeom } from "../PracticeChart";
import { CheckCircle2, XCircle, RotateCcw, Target, Plus } from "lucide-react";

const CHART_H = 320;

export function SupportResistanceLab({ onChecked }: { onChecked?: (passed: boolean) => void }) {
  const s = ZONE_SCENARIO;
  const tolerance = s.tolerancePips * s.pipSize;
  const [placed, setPlaced] = useState<number[]>([]);
  const [checked, setChecked] = useState(false);
  const [manual, setManual] = useState("");
  const svgRef = useRef<SVGSVGElement>(null);
  const geomRef = useRef<ChartGeom | null>(null);

  const grade = useMemo(() => gradeZones(placed, s.targets, tolerance), [placed, s.targets, tolerance]);
  const full = placed.length >= s.maxPlacements;

  const round = (p: number) => Number((Math.round(p / s.pipSize) * s.pipSize).toFixed(s.digits));

  const addLevel = (p: number) => {
    if (full || !Number.isFinite(p) || p < s.priceMin || p > s.priceMax) return;
    setPlaced((cur) => [...cur, round(p)]);
    setChecked(false);
  };
  const removeLevel = (i: number) => {
    setPlaced((cur) => cur.filter((_, j) => j !== i));
    setChecked(false);
  };

  const onChartClick = (e: ReactMouseEvent<SVGRectElement>) => {
    const svg = svgRef.current;
    const g = geomRef.current;
    if (!svg || !g) return;
    const rect = svg.getBoundingClientRect();
    if (rect.height <= 0) return;
    addLevel(g.price(((e.clientY - rect.top) / rect.height) * g.height));
  };

  const check = () => { setChecked(true); onChecked?.(grade.passed); };
  const reset = () => { setPlaced([]); setChecked(false); };

  const extraSet = new Set(grade.extras);

  const overlay = (g: ChartGeom) => {
    geomRef.current = g;
    const band = (price: number) => ({ y: g.y(price + tolerance), h: g.y(price - tolerance) - g.y(price + tolerance) });
    return (
      <g>
        <rect data-testid="sr-hit-area" x={0} y={g.top} width={g.plotW} height={g.bottom - g.top} fill="transparent"
          style={{ cursor: full ? "not-allowed" : "crosshair" }} onClick={onChartClick} />
        {checked && s.targets.map((t) => {
          const b = band(t.price);
          const hit = grade.hitIds.includes(t.id);
          const color = hit ? "var(--color-success)" : "var(--color-danger)";
          return (
            <g key={t.id} pointerEvents="none">
              <rect x={0} y={b.y} width={g.plotW} height={b.h} fill="none" stroke={color} strokeWidth={2} strokeDasharray="6 4" />
              <text x={g.plotW - 6} y={b.y - 4} fontSize={12} textAnchor="end" fill={color}>{hit ? "hit" : "missed"}: {t.id}</text>
            </g>
          );
        })}
        {placed.map((p, i) => {
          const b = band(p);
          const stray = checked && extraSet.has(p);
          const color = stray ? "var(--color-warning)" : "var(--color-primary)";
          return (
            <g key={`${p}-${i}`} data-testid={`sr-zone-${i}`} style={{ cursor: "pointer" }}
              onClick={(e) => { e.stopPropagation(); removeLevel(i); }}>
              <rect x={0} y={b.y} width={g.plotW} height={b.h} fill={color} opacity={0.22} />
              <line x1={0} x2={g.plotW} y1={g.y(p)} y2={g.y(p)} stroke={color} strokeWidth={2} />
              <text x={6} y={g.y(p) - 6} fontSize={12} fill={color}>{p.toFixed(s.digits)} (tap to remove)</text>
            </g>
          );
        })}
      </g>
    );
  };

  return (
    <div className="space-y-3" data-testid="lab-sr-body">
      <div className="rounded-2xl border border-border bg-card p-4 space-y-2">
        <div className="text-xs font-semibold uppercase tracking-wide text-txt-secondary">{s.title}</div>
        <p className="text-sm text-txt-secondary">{s.brief}</p>
        <div className="rounded-xl border border-border bg-background/40 p-2">
          <PracticeChart ref={svgRef} candles={s.candles} min={s.priceMin} max={s.priceMax} digits={s.digits}
            height={CHART_H} ariaLabel="Practice chart — tap to place support and resistance zones" overlay={overlay} />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-txt-muted">
          <span>{placed.length}/{s.maxPlacements} zones placed · each zone counts within ±{s.tolerancePips} pips</span>
        </div>
        <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); addLevel(parseFloat(manual)); setManual(""); }}>
          <input type="number" inputMode="decimal" step={s.pipSize} placeholder="Price, e.g. 1.1000" value={manual}
            data-testid="sr-manual-input" onChange={(e) => setManual(e.target.value)}
            className="min-w-0 flex-1 rounded-lg border border-border bg-background/40 px-3 py-1.5 text-sm text-foreground focus:border-primary/40 focus:outline-none" />
          <button type="submit" disabled={full} data-testid="sr-manual-add"
            className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-border bg-background/40 px-3 py-1.5 text-xs font-semibold text-foreground hover:border-primary/40 disabled:opacity-50">
            <Plus className="h-3.5 w-3.5" /> Add zone
          </button>
        </form>
      </div>

      <div className="flex flex-wrap gap-2">
        <button onClick={check} disabled={placed.length === 0} data-testid="sr-check"
          className={cn("inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-semibold",
            placed.length === 0 ? "cursor-not-allowed border border-border bg-background/40 text-txt-muted" : "bg-primary text-white hover:bg-primary/90")}>
          <Target className="h-4 w-4" /> Check my zones
        </button>
        <button onClick={reset} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background/40 px-4 py-2 text-sm font-semibold text-foreground hover:border-primary/40">
          <RotateCcw className="h-4 w-4" /> Clear
        </button>
      </div>

      {checked && (
        <div className={cn("rounded-2xl border p-4 space-y-2", grade.passed ? "border-success/40 bg-success/10" : "border-warning/40 bg-warning/10")} data-testid="sr-grade">
          <div className={cn("text-sm font-semibold", grade.passed ? "text-success" : "text-warning")}>
            {grade.hitIds.length}/{s.targets.length} zones found{grade.extras.length > 0 ? ` · ${grade.extras.length} extra` : ""}
          </div>
          <ul className="space-y-1.5">
            {s.targets.map((t) => {
              const hit = grade.hitIds.includes(t.id);
              return (
                <li key={t.id} className="flex items-start gap-2 text-xs">
                  {hit ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />}
                  <span className="text-txt-secondary"><span className="font-semibold text-foreground">{t.label}</span> — {hit ? "found." : "missed. Look for where price turned more than once."}</span>
                </li>
              );
            })}
            {grade.extras.length > 0 && (
              <li className="text-xs text-warning">
                Extra levels ({grade.extras.map((x) => x.toFixed(s.digits)).join(", ")}) did not line up with a clear reaction. Fewer, cleaner zones are easier to trade.
              </li>
            )}
          </ul>
          <p className="text-[11px] text-txt-muted">The dashed boxes on the chart show the reference zones for this practice chart.</p>
        </div>
      )}
    </div>
  );
}
