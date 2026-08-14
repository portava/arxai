import {
  DEFAULT_STALENESS_SECONDS,
  type PriceSensorPort, type PriceTick, type SensorReading,
} from "./liveInputs.types";

export interface ReadPriceSensorInput {
  port: PriceSensorPort;
  symbol: string;
  now?: Date;
  stalenessSeconds?: number;
}

export async function readPriceSensor(input: ReadPriceSensorInput): Promise<SensorReading<PriceTick>> {
  const now = input.now ?? new Date();
  const stale = input.stalenessSeconds ?? DEFAULT_STALENESS_SECONDS.price;
  const warnings: string[] = [];
  const blockers: string[] = [];

  const tick = await input.port.getLatestTick(input.symbol).catch(() => null);
  if (!tick) {
    return reading(null, { isHealthy: false, isStale: true, ageSeconds: null,
      reasons: ["no tick available"] }, warnings, ["No price tick available"], now);
  }

  const ageSeconds = Math.max(0, (now.getTime() - new Date(tick.timestamp).getTime()) / 1000);
  const isStale = ageSeconds > stale;
  if (isStale) blockers.push(`Price tick stale (${ageSeconds.toFixed(1)}s > ${stale}s)`);

  if (tick.bid <= 0 || tick.ask <= 0) blockers.push("Invalid bid/ask (≤0)");
  if (tick.ask < tick.bid) blockers.push(`Crossed quotes: bid ${tick.bid} > ask ${tick.ask}`);

  const value: PriceTick = {
    symbol: input.symbol,
    bid: tick.bid,
    ask: tick.ask,
    mid: (tick.bid + tick.ask) / 2,
    timestamp: tick.timestamp,
  };

  return reading(
    value,
    { isHealthy: blockers.length === 0, isStale, ageSeconds, reasons: blockers.length === 0 ? ["fresh"] : blockers },
    warnings, blockers, now,
  );
}

function reading(
  value: PriceTick | null, health: SensorReading<PriceTick>["health"],
  warnings: string[], blockers: string[], now: Date,
): SensorReading<PriceTick> {
  return { sensor: "price", value, health, warnings, blockers, capturedAt: now.toISOString() };
}
