/**
 * Diagnose a Deriv new-API credential rejection WITHOUT inspecting the token.
 *
 *   pnpm --filter @workspace/api-server run diagnose:deriv-new-api
 *
 * The owner's standing constraint is that the token is never printed, logged,
 * echoed, or INSPECTED — so this deliberately does not test its prefix, shape,
 * or content. Instead it varies WHICH HEADER IS PRESENT across three probes
 * and reads the venue's reaction. That distinguishes an App-ID rejection from
 * a token rejection using only status codes and response metadata.
 *
 * Read-only: GET only, no trade, no account mutation.
 */

import { resolveNewApiConfig, derivRestRequest, describeConfig } from "../lib/deriv/newApi/restClient.js";
import { DERIV_ACCOUNTS_PATH } from "../lib/deriv/newApi/accounts.js";
import { DerivNewApiError } from "../lib/deriv/newApi/errors.js";

type Probe = { name: string; authMode: "both" | "app-id-only" | "bearer-only"; note: string };

const PROBES: Probe[] = [
  { name: "both headers", authMode: "both", note: "the real request certification makes" },
  { name: "App-ID only ", authMode: "app-id-only", note: "no credential sent — isolates the App ID" },
  { name: "Bearer only ", authMode: "bearer-only", note: "no App-ID sent — isolates the header requirement" },
];

async function probe(p: Probe, config: { appId: string; token: string }): Promise<string> {
  try {
    const res = await derivRestRequest<unknown>({
      method: "GET", path: DERIV_ACCOUNTS_PATH, config, authMode: p.authMode,
    });
    return `HTTP ${res.status} OK`;
  } catch (e) {
    if (e instanceof DerivNewApiError) {
      return [
        `HTTP ${e.httpStatus ?? "-"}`,
        `deriv:${e.derivCode ?? "none"}`,
        `challenge:${e.authChallenge ?? "none"}`,
        `body:${e.bodyShape ?? "none"}`,
      ].join("  ");
    }
    return "non-protocol failure (message withheld)";
  }
}

async function main(): Promise<void> {
  const config = resolveNewApiConfig();
  if (typeof config === "string") {
    console.error(`cannot diagnose: ${config}`);
    process.exitCode = 1;
    return;
  }
  const d = describeConfig();
  console.log("Deriv new-API credential diagnosis (read-only, GET only)");
  console.log(`mode=${d.mode}  appId=present  token=present(len ${d.patLength})`);
  console.log("The token is never inspected — only which headers are sent varies.\n");

  const results: Record<string, string> = {};
  for (const p of PROBES) {
    const out = await probe(p, config);
    results[p.authMode] = out;
    console.log(`  ${p.name}  ${out}`);
    console.log(`               ↳ ${p.note}`);
  }

  console.log("\nReading:");
  const both = results["both"] ?? "";
  const appOnly = results["app-id-only"] ?? "";
  const bearerOnly = results["bearer-only"] ?? "";

  if (both.startsWith("HTTP 200")) {
    console.log("  Credentials accepted — rerun certification.");
    return;
  }
  // If sending NO credential produces the same response as sending one, the
  // request is being rejected before the token is ever evaluated.
  const sameAsNoCredential = both.split("body:")[0] === appOnly.split("body:")[0];
  if (sameAsNoCredential) {
    console.log("  The response is IDENTICAL with and without a credential, so the");
    console.log("  token is not being evaluated at all. Suspect the App ID: unregistered,");
    console.log("  not enabled for this API, or not linked to the token's account.");
  } else {
    console.log("  Sending the credential changes the response, so the App ID is being");
    console.log("  accepted and the TOKEN is what is refused. Suspect wrong token type");
    console.log("  (legacy API token vs PAT/OAuth) or a missing `trade` scope.");
  }
  if (bearerOnly.startsWith("HTTP 200")) {
    console.log("  The Deriv-App-ID header is optional on this endpoint.");
  }
  console.log("\n  A 401 whose body is 0B / non-JSON is an edge rejection: Deriv's");
  console.log("  application errors carry a JSON error.code, so an empty body means");
  console.log("  the request never reached the application layer.");
}

main().catch((e: unknown) => {
  console.error(`diagnosis aborted: ${e instanceof Error ? e.constructor.name : "unknown error"}`);
  process.exitCode = 1;
});
