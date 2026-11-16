import {
  DEFAULT_STALENESS_SECONDS,
  type OpenPosition, type OpenTradesReading, type OpenTradesSensorPort, type SensorReading,
} from "./liveInputs.types";

export interface ReadOpenTradesSensorInput {
  port: OpenTradesSensorPort;
  maxOpenTrades?: number;
  symbolConcentrationLimit?: number;     // max positions per symbol
  now?: Date;
  stalenessSeconds?: number;
}

export async function readOpenTradesSensor(input: ReadOpenTradesSensorInput): Promise<SensorReading<OpenTradesReading>> {
  const now = input.now ?? new Date();
  const stale = input.stalenessSeconds ?? DEFAULT_STALENESS_SECONDS.openTrades;
  const warnings: string[] = [];
  const blockers: string[] = [];

  const snap = await input.port.getOpenPositions().catch(() => null);
  if (!snap) {
    return {
      sensor: "openTrades", value: null,
      health: { isHealthy: false, isStale: true, ageSeconds: null, reasons: ["no positions snapshot"] },
      warnings, blockers: ["No open-positions snapshot available"],
      capturedAt: now.toISOString(),
    };
  }

  const ageSeconds = Math.max(0, (now.getTime() - new Date(snap.observedAt).getTime()) / 1000);
  const isStale = ageSeconds > stale;
  if (isStale) blockers.push(`Positions snapshot stale (${ageSeconds.toFixed(1)}s > ${stale}s)`);

  const positions: OpenPosition[] = snap.positions;
  const totalCount = positions.length;
  const totalVolume = positions.reduce((s, p) => s + p.volume, 0);
  const totalUnrealizedPnL = positions.reduce((s, p) => s + p.unrealizedPnL, 0);
  const symbolConcentration: Record<string, number> = {};
  let netDirectional = 0;
  for (const p of positions) {
    symbolConcentration[p.symbol] = (symbolConcentration[p.symbol] ?? 0) + 1;
    netDirectional += p.direction === "BUY" ? p.volume : -p.volume;
  }

  if (input.maxOpenTrades != null && totalCount >= input.maxOpenTrades) {
    blockers.push(`Open trades ${totalCount} ≥ cap ${input.maxOpenTrades}`);
  }
  if (input.symbolConcentrationLimit != null) {
    for (const [sym, n] of Object.entries(symbolConcentration)) {
      if (n >= input.symbolConcentrationLimit) {
        blockers.push(`${sym} has ${n} open positions ≥ cap ${input.symbolConcentrationLimit}`);
      } else if (n >= input.symbolConcentrationLimit - 1) {
        warnings.push(`${sym} concentration approaching cap (${n}/${input.symbolConcentrationLimit})`);
      }
    }
  }

  const value: OpenTradesReading = {
    positions, totalCount, totalVolume, totalUnrealizedPnL,
    symbolConcentration, netDirectional,
  };

  return {
    sensor: "openTrades", value,
    health: { isHealthy: blockers.length === 0, isStale, ageSeconds,
              reasons: blockers.length === 0 ? [`${totalCount} open`] : blockers },
    warnings, blockers, capturedAt: now.toISOString(),
  };
}
