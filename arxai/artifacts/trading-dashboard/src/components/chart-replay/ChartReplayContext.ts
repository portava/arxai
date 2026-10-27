import { createContext } from "react";
import type { ChartCandlesResponse } from "@workspace/api-client-react";
import type { ChartPreferences } from "@/lib/chart-engine/chartWorkspace";
export const ChartReplayContext = createContext<{ open(data:ChartCandlesResponse | undefined, preferences:ChartPreferences, expected:{symbol:string;timeframe:string}): string | null } | null>(null);
