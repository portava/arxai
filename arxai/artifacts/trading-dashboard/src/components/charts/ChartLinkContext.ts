import { createContext } from "react";
import type { ChartViewLink } from "@/lib/chart-engine/chartViewLink";

export const ChartLinkContext = createContext<ChartViewLink | null>(null);
