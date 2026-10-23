import {
  DEFAULT_STALENESS_SECONDS,
  type SensorReading, type VolumeReading, type VolumeSensorPort,
} from "./liveInputs.types";

const DEAD_MARKET_RATIO = 0.2;   // <20% of average → dead market

export interface ReadVolumeSensorInput {
  port: VolumeSensorPort;
  symbol: string;
  windowSeconds?: number;
  now?: Date;
  stalenessSeconds?: number;
}

export async function readVolumeSensor(input: ReadVolumeSensorInput): Promise<SensorReading<VolumeReading>> {
  const now = input.now ?? new Date();
  const win = input.windowSeconds ?? 30;
  const stale = input.stalenessSeconds ?? DEFAULT_STALENESS_SECONDS.volume;
  const warnings: string[] = [];
  const blockers: string[] = [];

  const [recent, avg] = await Promise.all([
    input.port.getRecentTickCount(input.symbol, win).catch(() => null),
    input.port.getAverageTicksPerSecond(input.symbol).catch(() => null),
  ]);

  if (!recent) {
    return {
      sensor: "volume", value: null,
      health: { isHealthy: false, isStale: true, ageSeconds: null, reasons: ["no tick data"] },
      warnings, blockers: [`No tick activity data for ${input.symbol}`],
      capturedAt: now.toISOString(),
    };
  }

  const ageSeconds = Math.max(0, (now.getTime() - new Date(recent.observedAt).getTime()) / 1000);
  const isStale = ageSeconds > stale;
  if (isStale) blockers.push(`Tick data stale (${ageSeconds.toFixed(1)}s > ${stale}s)`);

  const ticksPerSecondNow = win > 0 ? recent.ticks / win : 0;
  const ticksPerSecondAvg = avg ?? ticksPerSecondNow;
  const ratio = ticksPerSecondAvg > 0 ? ticksPerSecondNow / ticksPerSecondAvg : 1;
  const isDeadMarket = ratio < DEAD_MARKET_RATIO && ticksPerSecondAvg > 0;

  if (isDeadMarket) {
    blockers.push(`Dead market: ${ticksPerSecondNow.toFixed(2)} tps vs avg ${ticksPerSecondAvg.toFixed(2)} (${(ratio * 100).toFixed(0)}%)`);
  } else if (ratio < 0.5 && ticksPerSecondAvg > 0) {
    warnings.push(`Low activity: ${(ratio * 100).toFixed(0)}% of average tick rate`);
  }
  if (avg == null) warnings.push("No tick-rate baseline — cannot compare to average");

  const value: VolumeReading = {
    symbol: input.symbol,
    ticksPerSecondNow, ticksPerSecondAvg,
    windowSeconds: win, isDeadMarket,
  };

  return {
    sensor: "volume", value,
    health: { isHealthy: blockers.length === 0, isStale, ageSeconds,
              reasons: blockers.length === 0 ? ["active"] : blockers },
    warnings, blockers, capturedAt: now.toISOString(),
  };
}
