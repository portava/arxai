import { Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  CHART_LAYERS,
  allLayers,
  type ChartLayerVisibility,
  type ChartLayerId,
} from "@/lib/chart-engine/layers";
export function ChartLayersMenu({
  value,
  onChange,
  availability,
}: {
  value: ChartLayerVisibility;
  onChange: (next: ChartLayerVisibility) => void;
  availability: Partial<Record<ChartLayerId, number>>;
}) {
  const groups = [...new Set(CHART_LAYERS.map((l) => l.group))];
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          className="h-8 gap-2 border-cyan-500/40 text-cyan-200"
          data-testid="chart-layers-menu"
        >
          <Layers className="h-4 w-4" />
          Layers
          <span className="font-mono text-[10px] text-muted-foreground">
            {Object.values(value).filter(Boolean).length}/{CHART_LAYERS.length}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[320px] max-w-[calc(100vw-24px)] p-0"
      >
        <div className="border-b border-border p-3">
          <h3 className="text-sm font-semibold">Chart layers</h3>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Show or hide drawings. Analysis and trade protections stay active.
          </p>
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              className="h-7 text-xs"
              onClick={() => onChange(allLayers(true))}
            >
              Show all
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              onClick={() => onChange(allLayers(false))}
            >
              Hide all
            </Button>
          </div>
        </div>
        <div className="max-h-[min(470px,65vh)] overflow-y-auto p-3">
          {groups.map((group) => (
            <fieldset key={group} className="mb-3 last:mb-0">
              <legend className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                {group}
              </legend>
              {CHART_LAYERS.filter((l) => l.group === group).map((layer) => (
                <label
                  key={layer.id}
                  className="flex cursor-pointer items-center gap-3 rounded px-1.5 py-2 hover:bg-muted"
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-cyan-400"
                    checked={value[layer.id]}
                    onChange={(e) =>
                      onChange({ ...value, [layer.id]: e.target.checked })
                    }
                  />
                  <span className="flex-1 text-xs">{layer.label}</span>
                  <span className="text-[10px] text-muted-foreground">
                    {!value[layer.id]
                      ? "Hidden"
                      : availability[layer.id]
                        ? `${availability[layer.id]} ready`
                        : "Waiting for data"}
                  </span>
                </label>
              ))}
            </fieldset>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
