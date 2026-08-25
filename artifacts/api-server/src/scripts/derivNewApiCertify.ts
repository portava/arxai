/**
 * Read-only certification of the Deriv new-API transport (spec Phase 14).
 *
 *   pnpm --filter @workspace/api-server run certify:deriv-new-api
 *
 * Makes REAL network calls to Deriv using the configured PAT. It places NO
 * trade: every payload passes an allow-list that refuses buy, sell, and
 * anything not explicitly permitted.
 *
 * Deliberately NOT in the `ci` chain — CI must not depend on a third party
 * being reachable, and a certification that runs automatically stops being a
 * decision someone made.
 *
 * Output is sanitized: no token, no OTP URL, no headers, no full account id,
 * no balance figure.
 */

import { runReadOnlyCertification } from "../lib/deriv/newApi/certify.js";

async function main(): Promise<void> {
  const symbol = process.argv.find((a) => a.startsWith("--symbol="))?.split("=")[1];
  const currency = process.argv.find((a) => a.startsWith("--currency="))?.split("=")[1];

  console.log("Deriv new-API read-only certification");
  console.log("No trade is placed. Buy/sell are refused by the allow-list.\n");

  const report = await runReadOnlyCertification({ symbol, currency });

  for (const s of report.steps) {
    const mark = s.status === "PASS" ? "PASS" : s.status === "FAIL" ? "FAIL" : "SKIP";
    console.log(
      `  [${mark}] ${String(s.step).padStart(2)} ${s.name.padEnd(18)} ${s.detail}`
      + (s.errorCode ? `  (${s.errorCode})` : ""),
    );
  }

  console.log("");
  if (report.passed) {
    console.log(`CERTIFIED read-only: ${report.steps.length}/${report.steps.length} steps passed.`);
    console.log("This certifies the transport, NOT live trading. Order placement is");
    console.log("uncertified until the separate demo-trade certification is run.");
    return;
  }
  console.log(`NOT CERTIFIED — halted at step ${report.haltedAt ?? "?"}.`);
  // Non-zero exit: a partial run must not read as success to any caller that
  // only checks the status code.
  process.exitCode = 1;
}

main().catch((e: unknown) => {
  // The message is withheld on purpose: an arbitrary thrown value can carry
  // request context, and request context here contains the Authorization
  // header. The constructor name is enough to route an investigation.
  console.error(`certification aborted: ${e instanceof Error ? e.constructor.name : "unknown error"}`);
  process.exitCode = 1;
});
