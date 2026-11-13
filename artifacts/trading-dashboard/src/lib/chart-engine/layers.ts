import type { ChartOverlay } from "@/lib/chart-overlays";
export const CHART_LAYERS = [
  { id: "trendlines", label: "Smart trendlines", group: "Market structure" },
  { id: "channels", label: "Channel boundaries", group: "Market structure" },
  { id: "breaks", label: "Break markers", group: "Market structure" },
  { id: "retests", label: "Retest markers", group: "Market structure" },
  { id: "reclaims", label: "Reclaim markers", group: "Market structure" },
  {
    id: "structureEvents",
    label: "Failure & momentum markers",
    group: "Market structure",
  },
  { id: "scanner", label: "Scanner entry / SL / TP", group: "AI & setups" },
  { id: "fvg", label: "Fair value gaps", group: "AI & setups" },
  { id: "ruby", label: "AI support / resistance zones", group: "AI & setups" },
  { id: "setups", label: "Setup risk / reward drawings", group: "AI & setups" },
  { id: "agents", label: "Agent overlays", group: "AI & setups" },
  {
    id: "bullish",
    label: "Bullish scenario",
    group: "Illustrative scenarios · M1",
  },
  {
    id: "bearish",
    label: "Bearish scenario",
    group: "Illustrative scenarios · M1",
  },
  {
    id: "neither",
    label: "Neither-confirmed scenario",
    group: "Illustrative scenarios · M1",
  },
  {
    id: "positions",
    label: "Position entry / SL / TP",
    group: "Positions & personal drawings",
  },
  {
    id: "pending",
    label: "Pending order levels",
    group: "Positions & personal drawings",
  },
  {
    id: "pnl",
    label: "Position P/L labels",
    group: "Positions & personal drawings",
  },
  {
    id: "drawings",
    label: "My drawings",
    group: "Positions & personal drawings",
  },
] as const;
export type ChartLayerId = (typeof CHART_LAYERS)[number]["id"];
export type ChartLayerVisibility = Record<ChartLayerId, boolean>;
export function allLayers(visible: boolean): ChartLayerVisibility {
  return Object.fromEntries(
    CHART_LAYERS.map((x) => [x.id, visible]),
  ) as ChartLayerVisibility;
}
export function overlayLayer(o: ChartOverlay): ChartLayerId {
  if (o.metadata?.strategy === "HTF_TREND_FVG_PULLBACK") return "fvg";
  return (
    {
      position: "positions",
      pending: "pending",
      plan: "setups",
      preview: "setups",
      signal: "scanner",
      ruby: "ruby",
      agent: "agents",
    } as const
  )[o.source];
}
export function visibleOverlays(
  overlays: ChartOverlay[],
  layers: ChartLayerVisibility,
) {
  return overlays.filter((o) => layers[overlayLayer(o)]);
}
export function structureMarkerLayer(kind: string): ChartLayerId {
  return (
    ({ break: "breaks", retest: "retests", reclaim: "reclaims" } as const)[
      kind as "break" | "retest" | "reclaim"
    ] ?? "structureEvents"
  );
}
export const SCENARIO_LAYERS = {
  UP_FIRST: "bullish",
  DOWN_FIRST: "bearish",
  NEITHER: "neither",
} as const;
