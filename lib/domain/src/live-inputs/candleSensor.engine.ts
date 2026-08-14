import {
  DEFAULT_STALENESS_SECONDS,
  type Candle, type CandleSensorPort, type CandleStreamHealth, type SensorReading,
} from "./liveInputs.types";

const TF_SECONDS: Record<string, number> = {
  M1: 60, M5: 300, M15: 900, M30: 1800,
  H1: 3600, H4: 14400, D1: 86400,
};

export interface ReadCandleSensorInput {
  port: CandleSensorPort;
  symbol: string;
  timeframe: string;
  count: number;
  now?: Date;
  stalenessSeconds?: number;
}

export async function readCandleSensor(input: ReadCandleSensorInput): Promise<SensorReading<CandleStreamHealth>> {
  const now = input.now ?? new Date();
  const tfSec = TF_SECONDS[input.timeframe] ?? DEFAULT_STALENESS_SECONDS.candles;
  const stale = input.stalenessSeconds ?? Math.max(tfSec * 1.5, 30);
  const warnings: string[] = [];
  const blockers: string[] = [];

  const candles: Candle[] = await input.port.getRecentCandles(input.symbol, input.timeframe, input.count).catch(() => []);

  const latest = candles.length > 0 ? candles[candles.length - 1] : null;
  let ageSeconds: number | null = null;
  if (latest) ageSeconds = Math.max(0, (now.getTime() - new Date(latest.timestamp).getTime()) / 1000);

  // Gap detection — compare consecutive timestamps to expected timeframe step
  let gapsDetected = 0;
  for (let i = 1; i < candles.length; i++) {
    const dt = (new Date(candles[i].timestamp).getTime() - new Date(candles[i - 1].timestamp).getTime()) / 1000;
    if (dt > tfSec * 1.5) gapsDetected++;
  }
  if (gapsDetected > 0) warnings.push(`${gapsDetected} timeframe gaps in stream`);

  // OHLC integrity — high ≥ open/close/low, low ≤ open/close/high
  let ohlcViolations = 0;
  for (const c of candles) {
    if (c.high < Math.max(c.open, c.close, c.low) || c.low > Math.min(c.open, c.close, c.high)) {
      ohlcViolations++;
    }
  }
  if (ohlcViolations > 0) blockers.push(`${ohlcViolations} OHLC integrity violations`);

  if (candles.length === 0) blockers.push(`No candles returned for ${input.symbol} ${input.timeframe}`);
  else if (candles.length < input.count / 2) {
    warnings.push(`Only ${candles.length}/${input.count} candles available`);
  }

  const isStale = (ageSeconds ?? Number.POSITIVE_INFINITY) > stale;
  if (isStale) blockers.push(`Latest candle stale (${ageSeconds?.toFixed(1)}s > ${stale}s)`);

  const value: CandleStreamHealth = {
    symbol: input.symbol, timeframe: input.timeframe,
    count: candles.length, latest, gapsDetected, ohlcViolations,
  };

  return {
    sensor: "candles", value,
    health: { isHealthy: blockers.length === 0, isStale, ageSeconds,
              reasons: blockers.length === 0 ? ["healthy"] : blockers },
    warnings, blockers, capturedAt: now.toISOString(),
  };
}
