/**
 * diagnoseDerivPublicFeed — is the Deriv synthetic feed actually serving?
 *
 *   pnpm --filter @workspace/api-server run diagnose:deriv-public-feed
 *   pnpm --filter @workspace/api-server run diagnose:deriv-public-feed -- --symbol=V75 --timeframe=M5
 *
 * WHY THIS EXISTS. Every other way of answering "are candles flowing?" needed
 * a signed-in browser: /api/chart/candles and /api/market-data/deriv/status
 * both require a user session, so curl gets AUTH_REQUIRED. This opens the same
 * socket the server opens, in-process, and reports what came back — no browser,
 * no session, no server.
 *
 * It also isolates the question. A blank chart has several possible causes and
 * they need different fixes:
 *   - the SERVER is stale (it runs the compiled dist bundle, so a git pull is
 *     inert until `pnpm run build` AND a restart) — this script reads the
 *     SOURCE, so a green result here plus a blank chart means exactly that;
 *   - the venue or the network is refusing — this script fails and says why;
 *   - the symbol has no Deriv mapping — reported as SYMBOL_UNAVAILABLE.
 *
 * READ-ONLY at the venue: it opens a public, credential-free session
 * (Ruling 15: new-mode credentials never reach the legacy transport) and asks
 * for historical candles. It sends no token, places no order, and cannot.
 */

import { getDerivWsClient } from "../lib/data/providers/derivWsClient.js";
import { getDerivCandles, getDerivFeedStatus } from "../lib/data/providers/derivProvider.js";

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const symbol = arg("symbol", "V75_1S");
const timeframe = arg("timeframe", "M5");
const WAIT_MS = 20_000;

async function main(): Promise<void> {
  console.log(`DERIV PUBLIC FEED DIAGNOSTIC — ${symbol} ${timeframe}`);

  const client = getDerivWsClient();
  const mode = client.getMode();
  console.log(`  api mode          ${mode}`);
  if (mode === "none") {
    console.error("  REFUSED: no Deriv API mode resolves — DERIV_APP_ID is unset or unrecognised.");
    process.exitCode = 1;
    return;
  }

  client.ensureConnection();
  const deadline = Date.now() + WAIT_MS;
  let status = getDerivFeedStatus();
  while (!status.connected && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    status = getDerivFeedStatus();
  }

  console.log(`  connected         ${status.connected}`);
  console.log(`  publicDataOnly    ${status.publicDataOnly}   (true = credential-free session, authorize withheld BY DESIGN)`);
  console.log(`  authorized        ${status.authorized}   (false is CORRECT on a public session — not a credential failure)`);
  console.log(`  readiness         ${status.feedReadinessState}`);
  console.log(`  active symbols    ${status.activeSymbolCount}`);
  if (status.errorMessage) console.log(`  error             ${status.errorMessage}`);

  if (!status.connected) {
    console.error(`\n  NOT CONNECTED after ${WAIT_MS / 1000}s. The venue or the network refused; the reason is above.`);
    process.exitCode = 1;
    return;
  }

  const res = await getDerivCandles(symbol, timeframe, 3);
  if (!res.ok || res.candles.length === 0) {
    console.error(`\n  NO CANDLES for ${symbol} — reason: ${res.reason ?? "unstated"}`);
    process.exitCode = 1;
    return;
  }

  const newest = res.candles[res.candles.length - 1]!;
  console.log(`\n  CANDLES OK — ${res.candles.length} bars for ${res.symbol} (venue id ${res.derivSymbol}, ${res.granularitySeconds}s)`);
  console.log(`  newest bar        ${new Date(newest.epoch * 1000).toISOString()}  O ${newest.open} H ${newest.high} L ${newest.low} C ${newest.close}`);
  console.log(
    "\n  The FEED is healthy. If a chart is still blank, the running server is\n" +
    "  serving a stale build: this reads source, the server runs dist/index.mjs.\n" +
    "  Rebuild AND restart — `pnpm --filter @workspace/api-server run build`,\n" +
    "  then Stop -> Run. A restart alone does not pick up a git pull.",
  );
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error("diagnostic failed:", e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
