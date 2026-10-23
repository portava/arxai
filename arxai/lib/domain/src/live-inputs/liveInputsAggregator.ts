import type {
  AccountRiskSensorPort, CandleSensorPort, LiveInputsSnapshot,
  Mt5LatencySensorPort, NewsSensorPort, OpenTradesSensorPort,
  PriceSensorPort, SensorReading, SpreadSensorPort,
  UserBehaviorSensorPort, VolumeSensorPort,
} from "./liveInputs.types";

import { readPriceSensor        } from "./priceSensor.engine";
import { readCandleSensor       } from "./candleSensor.engine";
import { readSpreadSensor       } from "./spreadSensor.engine";
import { readVolumeSensor       } from "./volumeSensor.engine";
import { readSessionSensor      } from "./sessionSensor.engine";
import { readNewsSensor         } from "./newsSensor.engine";
import { readMt5LatencySensor   } from "./mt5LatencySensor.engine";
import { readAccountRiskSensor  } from "./accountRiskSensor.engine";
import { readOpenTradesSensor   } from "./openTradesSensor.engine";
import { readUserBehaviorSensor } from "./userBehaviorSensor.engine";

export interface LiveInputsPorts {
  price:        PriceSensorPort;
  candles:      CandleSensorPort;
  spread:       SpreadSensorPort;
  volume:       VolumeSensorPort;
  news:         NewsSensorPort;
  mt5Latency:   Mt5LatencySensorPort;
  accountRisk:  AccountRiskSensorPort;
  openTrades:   OpenTradesSensorPort;
  userBehavior: UserBehaviorSensorPort;
}

export interface ReadLiveInputsInput {
  ports: LiveInputsPorts;
  symbol: string;
  candleTimeframe: string;
  candleCount: number;
  newsCurrencies: string[];
  maxOpenTrades?: number;
  symbolConcentrationLimit?: number;
  now?: Date;
}

// Reads every sensor in parallel, rolls up healthy/blocked status.
// Sensors are isolated — one sensor failing does not poison the others.
export async function readLiveInputs(input: ReadLiveInputsInput): Promise<LiveInputsSnapshot> {
  const now = input.now ?? new Date();

  const [
    price, candles, spread, volume, news,
    mt5Latency, accountRisk, openTrades, userBehavior,
  ] = await Promise.all([
    readPriceSensor       ({ port: input.ports.price,        symbol: input.symbol,                                                                           now }),
    readCandleSensor      ({ port: input.ports.candles,      symbol: input.symbol, timeframe: input.candleTimeframe, count: input.candleCount,               now }),
    readSpreadSensor      ({ port: input.ports.spread,       symbol: input.symbol,                                                                           now }),
    readVolumeSensor      ({ port: input.ports.volume,       symbol: input.symbol,                                                                           now }),
    readNewsSensor        ({ port: input.ports.news,         currencies: input.newsCurrencies,                                                               now }),
    readMt5LatencySensor  ({ port: input.ports.mt5Latency,                                                                                                   now }),
    readAccountRiskSensor ({ port: input.ports.accountRisk,                                                                                                  now }),
    readOpenTradesSensor  ({ port: input.ports.openTrades,   maxOpenTrades: input.maxOpenTrades, symbolConcentrationLimit: input.symbolConcentrationLimit,   now }),
    readUserBehaviorSensor({ port: input.ports.userBehavior,                                                                                                 now }),
  ]);

  const session = readSessionSensor({ now });   // sync — clock-derived

  const readings = {
    price, candles, spread, volume, session, news,
    mt5Latency, accountRisk, openTrades, userBehavior,
  };

  const allReadings: SensorReading<unknown>[] = Object.values(readings);
  const allHealthy = allReadings.every((r) => r.health.isHealthy);
  const blockers = allReadings.flatMap((r) => r.blockers.map((b) => `[${r.sensor}] ${b}`));
  const warnings = allReadings.flatMap((r) => r.warnings.map((w) => `[${r.sensor}] ${w}`));

  return { capturedAt: now.toISOString(), readings, allHealthy, blockers, warnings };
}
