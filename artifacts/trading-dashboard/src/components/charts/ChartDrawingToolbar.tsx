import { useEffect, useRef, useState, type RefObject } from "react";
import {
  MousePointer2,
  TrendingUp,
  Minus,
  Square,
  Layers,
  Undo2,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import type { ChartEngineAdapter } from "@/lib/chart-engine";
import {
  validDrawings,
  type DrawingTool,
  type ChartDrawing,
} from "@/lib/chart-engine/drawings";
const tools = [
  { id: "cursor", label: "Pan", icon: MousePointer2 },
  { id: "trend", label: "Trend line", icon: TrendingUp },
  { id: "horizontal", label: "Horizontal", icon: Minus },
  { id: "rectangle", label: "Rectangle", icon: Square },
  { id: "fibonacci", label: "Fibonacci", icon: Layers },
] as const;
export function ChartDrawingToolbar({
  adapterRef,
  epoch,
  symbol,
  timeframe,
  disabled = false,
  onDraw,
  onCountChange,
}: {
  adapterRef: RefObject<ChartEngineAdapter | null>;
  epoch: number;
  symbol: string;
  timeframe: string;
  disabled?: boolean;
  onDraw?: () => void;
  onCountChange?: (count: number) => void;
}) {
  const { user } = useCurrentUser();
  const [tool, setTool] = useState<DrawingTool>("cursor");
  const [count, setCount] = useState(0);
  const [canUndo, setCanUndo] = useState(false);
  const memory = useRef(new Map<string, ChartDrawing[]>());
  useEffect(() => {
    const adapter = adapterRef.current;
    if (!adapter) return;
    const key = `arx.chart.drawings.v1:${user?.id ?? "session"}:${symbol}:${timeframe}`;
    let drawings = memory.current.get(key) ?? [];
    if (user)
      try {
        drawings = validDrawings(JSON.parse(localStorage.getItem(key) ?? "[]"));
      } catch {
        /* keep session annotations when storage is unavailable */
      }
    adapter.onDrawingsChange?.((next, undo) => {
      memory.current.set(key, next);
      setCount(next.length);
      onCountChange?.(next.length);
      setCanUndo(undo);
      if (user)
        try {
          localStorage.setItem(key, JSON.stringify(next));
        } catch {
          /* private storage */
        }
    });
    adapter.setDrawings?.(drawings);
    adapter.setDrawingTool?.("cursor");
    setTool("cursor");
    return () => adapter.onDrawingsChange?.(null);
  }, [adapterRef, epoch, symbol, timeframe, user?.id, onCountChange]);
  function choose(next: DrawingTool) {
    if (next !== "cursor") onDraw?.();
    setTool(next);
    adapterRef.current?.setDrawingTool?.(next);
  }
  return (
    <div
      className="border-y border-border bg-card/70 px-3 py-2"
      data-testid="chart-drawing-toolbar"
    >
      <div
        className="flex flex-wrap items-center gap-1"
        role="toolbar"
        aria-label="Chart drawing tools"
      >
        {tools.map(({ id, label, icon: Icon }) => (
          <Button
            key={id}
            type="button"
            size="sm"
            variant={tool === id ? "secondary" : "ghost"}
            aria-pressed={tool === id}
            disabled={disabled}
            onClick={() => choose(id)}
            className="h-8 gap-1.5 px-2 text-xs"
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </Button>
        ))}
        <span className="mx-1 h-5 border-l border-border" />
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-8 gap-1.5 px-2 text-xs"
          disabled={!canUndo}
          onClick={() => adapterRef.current?.undoDrawing?.()}
        >
          <Undo2 className="h-3.5 w-3.5" />
          Undo
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-8 gap-1.5 px-2 text-xs"
          disabled={!count}
          onClick={() => adapterRef.current?.clearDrawings?.()}
        >
          <Trash2 className="h-3.5 w-3.5" />
          Clear{count ? ` (${count})` : ""}
        </Button>
      </div>
      {tool !== "cursor" && (
        <p className="mt-1.5 text-[11px] text-muted-foreground" role="status">
          {tool === "horizontal"
            ? "Click a price level."
            : "Click two points on the chart."}{" "}
          Keyboard: focus the chart, use arrows and Enter. Escape cancels.
          Annotations save on this device.
        </p>
      )}
    </div>
  );
}
