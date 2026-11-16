// Finite, public-market-data-only diagnostic. No account/authorize/order calls.
// Opt-in remains required; output contains timestamps/counts, never credentials.
import { DerivPublicDataClient } from "../lib/data/providers/derivPublicDataClient.js";
import { DERIV_SYNTHETIC_SYMBOLS } from "../lib/data/providers/derivProvider.js";

const client = new DerivPublicDataClient(DERIV_SYNTHETIC_SYMBOLS);
const startedAt = new Date().toISOString();
try {
  const samples = [];
  for (const symbol of ["R_75", "1HZ25V", "1HZ50V", "1HZ75V"]) {
    const tick = await client.subscribeTicks(symbol);
    const candles = await client.getCandles(symbol, 60, 5);
    const last = candles.at(-1);
    samples.push({
      symbol,
      discovered: client.isSymbolAvailable(symbol),
      tickAt: tick ? new Date(tick.epoch * 1000).toISOString() : null,
      tickAgeMs: tick ? Date.now() - tick.epoch * 1000 : null,
      positiveFiniteQuote: tick !== null && Number.isFinite(tick.quote) && tick.quote > 0,
      candleCount: candles.length,
      lastCandleOpenAt: last ? new Date(last.epoch * 1000).toISOString() : null,
      lastCandleOpenAgeMs: last ? Date.now() - last.epoch * 1000 : null,
    });
  }
  console.log(JSON.stringify({ startedAt, observedAt: new Date().toISOString(), source: "deriv_public", connected: client.isConnected(), authorized: client.isAuthorized(), accountConnected: client.getAccountIdentity() !== null, discoveredCount: client.getActiveSymbolsCount(), mapValidation: client.getLastDiscoveryValidation(), samples }, null, 2));
  if (samples.some(s => !s.positiveFiniteQuote || s.tickAgeMs === null || s.tickAgeMs < 0 || s.tickAgeMs > 30_000 || s.candleCount === 0)) process.exitCode = 1;
} catch (error) {
  console.log(JSON.stringify({ startedAt, observedAt: new Date().toISOString(), source: "deriv_public", connected: client.isConnected(), authorized: false, error: error instanceof Error && /^DERIV_PUBLIC_[A-Za-z0-9_]+$/.test(error.message) ? error.message : "DERIV_PUBLIC_PROBE_FAILED" }));
  process.exitCode = 1;
} finally {
  client.stop();
}
