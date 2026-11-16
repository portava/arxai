/**
 * Capture live venue evidence from Deriv. READ-ONLY.
 *
 *   pnpm --filter @workspace/api-server run capture:deriv-evidence -- \
 *     --authorize=CAPTURE-READ-ONLY-VENUE-EVIDENCE --out=./evidence.json
 *
 * Contacts the live venue with the configured PAT and sends only operations
 * that CANNOT create or close a position: quotes, metadata queries, and
 * deliberately malformed requests whose rejections are the evidence.
 *
 * IT CANNOT PLACE AN ORDER. buy/sell are refused by an independent gate, and
 * the demo-execution tier is not implemented.
 *
 * Refuses without the exact authorization string, refuses a non-demo account,
 * and refuses to write an artifact that contains credential material.
 */

import { writeFileSync } from "node:fs";
import { captureVenueEvidence } from "../lib/deriv/newApi/evidenceCapture.js";
import {
  EVIDENCE_AUTHORIZATION, EVIDENCE_TIERS, EvidenceRefusal, serializeArtifact,
} from "../lib/deriv/newApi/liveEvidence.js";
import { generateFixtures, renderFixtureModule } from "../lib/deriv/newApi/evidenceToFixture.js";

async function main(): Promise<void> {
  const authorization = process.argv.find((a) => a.startsWith("--authorize="))?.split("=")[1];
  const out = process.argv.find((a) => a.startsWith("--out="))?.split("=")[1];
  const emitFixtures = process.argv.includes("--emit-fixtures");

  console.log("Deriv live-evidence capture (READ-ONLY)");
  console.log("Sends no buy and no sell. Demo accounts only.\n");

  if (authorization !== EVIDENCE_AUTHORIZATION.READ_ONLY) {
    console.error("REFUSED: this contacts the live venue and requires explicit operator intent.");
    console.error(`Re-run with --authorize=${EVIDENCE_AUTHORIZATION.READ_ONLY}`);
    process.exitCode = 1;
    return;
  }

  let artifact;
  try {
    artifact = await captureVenueEvidence({
      tier: EVIDENCE_TIERS.READ_ONLY, authorization,
    });
  } catch (e) {
    console.error(e instanceof EvidenceRefusal
      ? `REFUSED: ${e.message}`
      : `capture aborted: ${e instanceof Error ? e.constructor.name : "unknown"}`);
    process.exitCode = 1;
    return;
  }

  for (const p of artifact.probes) {
    console.log(`  [${p.outcome.padEnd(15)}] ${p.name.padEnd(34)}`
      + ` deriv:${p.derivErrorCode ?? "-"} wireWritten:${p.wireWritten ?? "unstated"}`
      + ` keys:[${p.replyKeys.join(",")}]`);
  }

  console.log("\n  Questions:");
  for (const q of artifact.questions) {
    console.log(`    ${q.id} ${q.answered ? "ANSWERED " : "UNANSWERED"} — ${q.answer ?? ""}`);
  }

  if (out) {
    writeFileSync(out, serializeArtifact(artifact), "utf8");
    console.log(`\n  Evidence written to ${out}`);
  } else {
    console.log("\n  (no --out given; artifact not written)");
  }

  if (emitFixtures) {
    const fixtures = generateFixtures(artifact);
    console.log(`\n  ${fixtures.length} fixture(s) generated from captured frames:\n`);
    console.log(renderFixtureModule(artifact, fixtures));
  }
}

main().catch((e: unknown) => {
  console.error(`capture aborted: ${e instanceof Error ? e.constructor.name : "unknown"}`);
  process.exitCode = 1;
});
