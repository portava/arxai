import { logger } from "../../logger.js";
import { getDerivWsClient } from "./derivWsClient.js";
import { DERIV_SYNTHETIC_SYMBOLS } from "./derivProvider.js";
import { startDerivFormingBridge } from "../chart/derivFormingBridge.js";
import { mapWithConcurrency } from "../../marketScanner.js";

const KEEP_ALIVE_INTERVAL_MS = 20_000;
const PER_SYMBOL_COOLDOWN_MS = 15_000;
const KEEP_ALIVE_CONCURRENCY = 4;
const KEEP_ALIVE_CANDLE_GRANULARITY = 60;
const KEEP_ALIVE_CANDLE_COUNT = 3;

let started = false;
let cycleInFlight = false;
const lastRefreshBySymbol = new Map<string, number>();

function derivConfigured(): boolean {
  return Boolean(process.env.DERIV_APP_ID && process.env.DERIV_APP_ID.trim());
}

async function runKeepAliveCycle(): Promise<void> {
  if (cycleInFlight) return;
  if (!derivConfigured()) return;
  cycleInFlight = true;
  try {
    const client = getDerivWsClient();
    client.ensureConnection();
    const now = Date.now();
    const due = DERIV_SYNTHETIC_SYMBOLS.filter((s) => {
      const last = lastRefreshBySymbol.get(s.derivId) ?? 0;
      return now - last >= PER_SYMBOL_COOLDOWN_MS;
    });
    if (due.length === 0) return;
    await mapWithConcurrency(due, KEEP_ALIVE_CONCURRENCY, async (s) => {
      try {
        await client.subscribeTicks(s.derivId);
        await client.getCandles(s.derivId, KEEP_ALIVE_CANDLE_GRANULARITY, KEEP_ALIVE_CANDLE_COUNT);
        lastRefreshBySymbol.set(s.derivId, Date.now());
      } catch (err) {
        logger.warn({ err: String(err), symbol: s.derivId }, "Deriv keep-alive symbol refresh failed (non-fatal)");
      }
    });
  } catch (err) {
    logger.warn({ err: String(err) }, "Deriv keep-alive cycle failed (non-fatal)");
  } finally {
    cycleInFlight = false;
  }
}

export function startDerivKeepAlive(): void {
  if (started) return;
  started = true;
  // Feed the chart's forming-bar composer from the SAME tick stream this keeps
  // alive, so a Deriv-fed chart's tip advances on real ticks instead of waiting
  // a whole interval for the next closed candle (Theme C3.1). Display-only;
  // idempotent; failure here must never stop the keep-alive itself.
  try {
    startDerivFormingBridge();
  } catch (err) {
    logger.warn({ err: String(err) }, "Deriv forming-bar bridge start failed (non-fatal)");
  }
  void runKeepAliveCycle();
  const timer = setInterval(() => {
    void runKeepAliveCycle();
  }, KEEP_ALIVE_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
}
