/**
 * RECOVERY: close one known open DEMO position by contract id.
 *
 *   pnpm --filter @workspace/api-server run close:deriv-demo-position -- \
 *     --contract-id=12345 --authorize=CLOSE-ONE-DEMO-POSITION
 *
 * Exists because the demo-trade harness can strand a position: if the socket
 * drops after the buy, it correctly refuses to guess and reports the contract
 * id instead. This closes THAT contract, and nothing else.
 *
 * It sells, so it commits capital and requires explicit authorization. It
 * refuses real-money accounts, refuses to close a contract that is already
 * settled, and closes exactly one id — the one named on the command line.
 * It never discovers positions to close on its own: an operator supplies the
 * id, so this can never become a bulk position-flattener.
 */

import { resolveNewApiConfig } from "../lib/deriv/newApi/restClient.js";
import { fetchAccounts, selectDemoAccount, isDemoAccount, isRealAccount } from "../lib/deriv/newApi/accounts.js";
import { NewDerivTransport, canSendTradingRequest } from "../lib/deriv/newApi/transport.js";
import { DerivNewApiError } from "../lib/deriv/newApi/errors.js";
import { mapOpenContractRequest, mapSellRequest, normalizeOpenContract, numeric } from "../lib/deriv/newApi/wire.js";

export const CLOSE_AUTHORIZATION = "CLOSE-ONE-DEMO-POSITION";

async function main(): Promise<void> {
  const auth = process.argv.find((a) => a.startsWith("--authorize="))?.split("=")[1];
  const idArg = process.argv.find((a) => a.startsWith("--contract-id="))?.split("=")[1];
  const contractId = Number(idArg);

  console.log("Deriv DEMO position close (recovery)");
  if (auth !== CLOSE_AUTHORIZATION) {
    console.error(`REFUSED: this sells a position. Re-run with --authorize=${CLOSE_AUTHORIZATION}`);
    process.exitCode = 1;
    return;
  }
  if (!Number.isInteger(contractId) || contractId <= 0) {
    console.error("REFUSED: --contract-id must be a positive integer");
    process.exitCode = 1;
    return;
  }

  const config = resolveNewApiConfig();
  if (typeof config === "string") { console.error(`cannot run: ${config}`); process.exitCode = 1; return; }

  const accounts = await fetchAccounts(config);
  const selected = selectDemoAccount(accounts, process.env["DERIV_DEMO_ACCOUNT_ID"] ?? null);
  if (selected instanceof DerivNewApiError) {
    console.error(`REFUSED: ${selected.code}`);
    process.exitCode = 1;
    return;
  }
  const account = selected.account;
  if (isRealAccount(account) || !isDemoAccount(account)) {
    console.error("REFUSED: account is not provably demo");
    process.exitCode = 1;
    return;
  }
  console.log(`  demo account confirmed (...${account.accountId.slice(-4)})`);

  const transport = new NewDerivTransport(config);
  try {
    await transport.connect(account.accountId);
    if (!canSendTradingRequest(transport.getState())) {
      console.error(`REFUSED: transport is ${transport.getState()}`);
      process.exitCode = 1;
      return;
    }

    // Read BEFORE selling: closing an already-settled contract is a no-op at
    // best and a confusing error at worst, and the operator should be told the
    // position was already gone rather than left wondering.
    const readReq = mapOpenContractRequest(contractId);
    if (readReq instanceof DerivNewApiError) { console.error(readReq.code); process.exitCode = 1; return; }
    const before = normalizeOpenContract(await transport.send(readReq as unknown as Record<string, unknown>));
    if (before instanceof DerivNewApiError) {
      console.error(`could not read contract ${contractId}: ${before.detail ?? before.code}`);
      process.exitCode = 1;
      return;
    }
    if (before.contractId !== contractId) {
      console.error(`REFUSED: venue replied about contract ${before.contractId}, not ${contractId}`);
      process.exitCode = 1;
      return;
    }
    if (before.isSettled) {
      console.log(`  contract ${contractId} is ALREADY settled — nothing to close.`);
      console.log(`  profit as reported: ${before.profit ?? "unstated"}`);
      return;
    }
    console.log(`  contract ${contractId} is OPEN (profit ${before.profit ?? "unstated"}) — closing`);

    const sellReq = mapSellRequest(contractId, 0);   // 0 = sell at market
    if (sellReq instanceof DerivNewApiError) { console.error(sellReq.code); process.exitCode = 1; return; }
    const sold = await transport.send(sellReq as unknown as Record<string, unknown>);
    const s = ((sold as { sold?: unknown }).sold ?? (sold as { sell?: unknown }).sell) as Record<string, unknown> | undefined;
    const proceeds = numeric(s?.["sold_for"]) ?? numeric(s?.["amount"]);

    // Confirm from the venue, not from the sell reply.
    const after = normalizeOpenContract(await transport.send(readReq as unknown as Record<string, unknown>));
    const settled = !(after instanceof DerivNewApiError) && after.contractId === contractId && after.isSettled;
    if (!settled) {
      console.error(`  NOT CONFIRMED CLOSED — contract ${contractId} may still be open. Check Deriv.`);
      process.exitCode = 1;
      return;
    }
    console.log(`  contract ${contractId} CONFIRMED settled. proceeds ${proceeds ?? "unstated"}`);
    if (!(after instanceof DerivNewApiError)) {
      console.log(`  realized P/L as reported by Deriv: ${after.profit ?? "unstated"}`);
    }
  } finally {
    transport.close();
  }
}

main().catch((e: unknown) => {
  console.error(`close aborted: ${e instanceof Error ? e.constructor.name : "unknown"}`);
  console.error("The position may still be open — verify in the Deriv interface.");
  process.exitCode = 1;
});
