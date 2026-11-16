// Read-only provider requests. No database, bridge, order, control or email writes.
import { inspectMarketData } from "../lib/assistant/marketDataReadiness.js";

const args = process.argv.slice(2);
const symbol = args.length === 0 ? "EURUSD" : args.length === 2 && args[0] === "--symbol" ? args[1]!.toUpperCase() : "";
if (!["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF", "NZDUSD", "AAPL"].includes(symbol)) {
  process.stdout.write(JSON.stringify({ ready: false, error: "INVALID_ARGUMENTS", usage: "check:market-data [--symbol EURUSD]" }) + "\n");
  process.exit(2);
}
// Keep stdout a single safe report, including when upstream errors contain keys.
process.env.LOG_LEVEL = "silent";
process.env.NODE_ENV = "production";
let timer: ReturnType<typeof setTimeout> | undefined;
try {
  const { getMarketProvider } = await import("../lib/assistant/marketProvider.js");
  const { getMarketHttpObservations } = await import("../lib/assistant/marketHttp.js");
  const result = await Promise.race([
    inspectMarketData(getMarketProvider(), symbol),
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("PROBE_TIMEOUT")), 45_000); }),
  ]);
  if (timer) clearTimeout(timer);
  process.stdout.write(JSON.stringify({ ...result, requests: getMarketHttpObservations() }) + "\n");
  process.exit(result.ready ? 0 : 2);
} catch {
  if (timer) clearTimeout(timer);
  process.stdout.write(JSON.stringify({ ready: false, error: "PROBE_UNAVAILABLE" }) + "\n");
  process.exit(2);
}
