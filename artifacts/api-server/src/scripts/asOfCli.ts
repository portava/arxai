// Capability #35 — as-of reconstruction CLI.
//
// Usage:
//   pnpm --filter @workspace/api-server run as-of -- "2026-08-28T14:30:00Z"
//   pnpm --filter @workspace/api-server run as-of -- 1756391400000
//
// READ-ONLY: performs SELECTs only and prints the reconstructed view as JSON.
// Sections that cannot be reconstructed as-of print { available: false,
// reason } — the tool never fills a gap with a guess.

import { reconstructSystemAsOf } from "../lib/timeTravel/asOfReconstruction.js";

async function main(): Promise<number> {
  const arg = process.argv[2];
  if (!arg) {
    console.error("usage: as-of <ISO-8601 timestamp | epoch ms>");
    return 2;
  }
  const asOfMs = /^\d+$/.test(arg) ? Number(arg) : Date.parse(arg);
  if (!Number.isFinite(asOfMs)) {
    console.error(`could not parse '${arg}' as ISO-8601 or epoch ms`);
    return 2;
  }
  if (asOfMs > Date.now()) {
    console.error("as-of reconstruction is historical only — the future is not reconstructible");
    return 2;
  }
  const view = await reconstructSystemAsOf(asOfMs);
  console.log(JSON.stringify(view, null, 2));
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("as-of reconstruction failed:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
