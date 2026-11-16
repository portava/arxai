import {
  DEFAULT_STALENESS_SECONDS,
  type SensorReading, type SpreadReading, type SpreadSensorPort,
} from "./liveInputs.types";

const BLOWOUT_RATIO  = 3.0;   // ≥ 3× normal → block
const ELEVATED_RATIO = 1.5;   // ≥ 1.5× normal → warn

export interface ReadSpreadSensorInput {
  port: SpreadSensorPort;
  symbol: string;
  now?: Date;
  stalenessSeconds?: number;
}

export async function readSpreadSensor(input: ReadSpreadSensorInput): Promise<SensorReading<SpreadReading>> {
  const now = input.now ?? new Date();
  const stale = input.stalenessSeconds ?? DEFAULT_STALENESS_SECONDS.spread;
  const warnings: string[] = [];
  const blockers: string[] = [];

  const [current, avg] = await Promise.all([
    input.port.getCurrentSpread(input.symbol).catch(() => null),
    input.port.getAverageSpreadPips(input.symbol).catch(() => null),
  ]);

  if (!current) {
    return empty(input.symbol, now, ["no current spread reading"]);
  }
  if (current.pips < 0) blockers.push(`Negative spread (${current.pips})`);

  const ageSeconds = Math.max(0, (now.getTime() - new Date(current.timestamp).getTime()) / 1000);
  const isStale = ageSeconds > stale;
  if (isStale) blockers.push(`Spread stale (${ageSeconds.toFixed(1)}s > ${stale}s)`);

  const averagePips = avg && avg > 0 ? avg : current.pips;
  const ratio = averagePips > 0 ? current.pips / averagePips : 1;

  if (ratio >= BLOWOUT_RATIO) {
    blockers.push(`Spread blowout: ${current.pips.toFixed(2)}p is ${ratio.toFixed(1)}× average ${averagePips.toFixed(2)}p`);
  } else if (ratio >= ELEVATED_RATIO) {
    warnings.push(`Spread elevated: ${current.pips.toFixed(2)}p is ${ratio.toFixed(1)}× average ${averagePips.toFixed(2)}p`);
  }
  if (avg == null) warnings.push("No average spread baseline — using current as baseline");

  const value: SpreadReading = {
    symbol: input.symbol, currentPips: current.pips, averagePips, ratio,
  };

  return {
    sensor: "spread", value,
    health: { isHealthy: blockers.length === 0, isStale, ageSeconds,
              reasons: blockers.length === 0 ? ["normal"] : blockers },
    warnings, blockers, capturedAt: now.toISOString(),
  };
}

function empty(symbol: string, now: Date, reasons: string[]): SensorReading<SpreadReading> {
  return {
    sensor: "spread", value: null,
    health: { isHealthy: false, isStale: true, ageSeconds: null, reasons },
    warnings: [], blockers: [`No spread reading for ${symbol}`],
    capturedAt: now.toISOString(),
  };
}
