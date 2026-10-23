import { type CognitiveLoadState, clamp01 } from "./cognitive.types";

// ═══════════════════════════════════════════════════════════════════════════
// Cognitive Load (trader/system state) — composite over multiple drivers:
//   • openPositionsCount        normalised by softMaxOpen (default 5)
//   • activeAlertsCount         normalised by softMaxAlerts (default 6)
//   • screensWatched            normalised by softMaxScreens (default 4)
//   • multitaskingFraction01    raw input
//   • inputRatePerMin           normalised by softMaxRate (default 30)
//
// load01 = mean(contributions), each clamped. Pure.
// ═══════════════════════════════════════════════════════════════════════════

export interface CogLoadInput {
  openPositionsCount: number;
  activeAlertsCount: number;
  screensWatched: number;
  multitaskingFraction01: number;
  inputRatePerMin: number;
  softMaxOpen?: number;
  softMaxAlerts?: number;
  softMaxScreens?: number;
  softMaxRate?: number;
}

export function computeCognitiveLoad(input: CogLoadInput): CognitiveLoadState {
  const reasons: string[] = [];
  const contrib: Record<string, number> = {
    openPositions: clamp01(input.openPositionsCount / (input.softMaxOpen ?? 5)),
    activeAlerts:  clamp01(input.activeAlertsCount  / (input.softMaxAlerts ?? 6)),
    screens:       clamp01(input.screensWatched     / (input.softMaxScreens ?? 4)),
    multitasking:  clamp01(input.multitaskingFraction01),
    inputRate:     clamp01(input.inputRatePerMin    / (input.softMaxRate ?? 30)),
  };
  const keys = Object.keys(contrib);
  const load01 = clamp01(keys.reduce((s, k) => s + (contrib[k] ?? 0), 0) / keys.length);
  reasons.push(`load ${load01.toFixed(2)} from ${keys.length} drivers`);
  return { load01, driverContributions: contrib, reasons };
}
