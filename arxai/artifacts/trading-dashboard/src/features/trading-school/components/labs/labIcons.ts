/** Icon per Practice Lab id (shared by the labs list and the lab page). */
import type { LucideIcon } from "lucide-react";
import {
  Calculator, Scale, Globe2, Crosshair, CandlestickChart, Layers, Activity, Flame, Brain, ClipboardList,
} from "lucide-react";

export const LAB_ICONS: Record<string, LucideIcon> = {
  "lab-risk-calculator": Calculator,
  "lab-market-basics": Scale,
  "lab-products": Globe2,
  "lab-entry-sl-tp": Crosshair,
  "lab-candle-reading": CandlestickChart,
  "lab-support-resistance": Layers,
  "lab-indicators": Activity,
  "lab-scalp-flame": Flame,
  "lab-psychology": Brain,
  "lab-trade-plan": ClipboardList,
};
