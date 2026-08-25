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

interface ProbeResult { line: string; body: string | null; ok: boolean }

async function probe(p: Probe, config: { appId: string; token: string }): Promise<ProbeResult> {
  try {
    const res = await derivRestRequest<unknown>({
      method: "GET", path: DERIV_ACCOUNTS_PATH, config,
      authMode: p.authMode, captureBody: true,
    });
    return { line: `HTTP ${res.status} OK`, body: null, ok: true };
  } catch (e) {
    if (e instanceof DerivNewApiError) {
      return {
        line: [
          `HTTP ${e.httpStatus ?? "-"}`,
          `deriv:${e.derivCode ?? "none"}`,
          `challenge:${e.authChallenge ?? "none"}`,
          `body:${e.bodyShape ?? "none"}`,
        ].join("  "),
        body: e.bodySnippet,
        ok: false,
      };
    }
    return { line: "non-protocol failure (message withheld)", body: null, ok: false };
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

  const results: Record<string, ProbeResult> = {};
  for (const p of PROBES) {
    const out = await probe(p, config);
    results[p.authMode] = out;
    console.log(`  ${p.name}  ${out.line}`);
    if (out.body) console.log(`               ↳ says: ${JSON.stringify(out.body)}`);
    console.log(`               ↳ ${p.note}`);
  }

  console.log("\nReading:");
  const both = results["both"]!;
  const appOnly = results["app-id-only"]!;
  const bearerOnly = results["bearer-only"]!;

  if (both.ok) {
    console.log("  Credentials accepted — rerun certification.");
    return;
  }

  // Compare the FULL result, body shape included. The first version of this
  // heuristic split the line on "body:" and compared only the part before it,
  // which discarded the one field that actually differs — so three visibly
  // different responses were declared identical. Never exclude the
  // discriminating signal from the discriminator.
  const identicalToNoCredential = both.line === appOnly.line && both.body === appOnly.body;

  if (identicalToNoCredential) {
    console.log("  The response is byte-identical with and without a credential, so the");
    console.log("  token is not being evaluated. Suspect the App ID: unregistered, not");
    console.log("  enabled for this API, or not linked to the token's account.");
  } else {
    console.log("  The response CHANGES when the credential is sent, so it is being read");
    console.log("  and refused. The App ID is reaching the service.");
  }
  if (!bearerOnly.ok && bearerOnly.line !== both.line) {
    console.log("  Omitting Deriv-App-ID also changes the response, so that header is");
    console.log("  being honoured too.");
  }
  console.log("");
  console.log("  The venue's own messages above supersede this inference — read them");
  console.log("  first. They are redacted and truncated, never raw.");
}

main().catch((e: unknown) => {
  console.error(`diagnosis aborted: ${e instanceof Error ? e.constructor.name : "unknown error"}`);
  process.exitCode = 1;
});
