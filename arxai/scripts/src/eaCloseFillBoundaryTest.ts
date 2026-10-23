// Pure unit test for the shared EA-close-fill boundary.
//
// The Trade Logs page and the Live Test Cycle panel both show an
// "EA too old to report close fill — upgrade to v1.28" nudge for UNKNOWN-P/L
// rows closed by an EA older than v1.28. Both UI sites now import the SAME
// pure `eaTooOldForCloseFill` so the boundary cannot silently drift between
// them. These assertions pin the major/minor boundary (major 1, minor < 28)
// and the null/empty/garbage fallbacks (treated as "too old").

import {
  eaTooOldForCloseFill,
  EA_CLOSE_FILL_MIN_MAJOR,
  EA_CLOSE_FILL_MIN_MINOR,
} from "@workspace/domain/safety-contracts/eaCloseFill";

type Result = { name: string; pass: boolean; detail: string };
const results: Result[] = [];
function record(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail });
  // eslint-disable-next-line no-console
  console.log(`${pass ? "PASS" : "FAIL"}  ${name} — ${detail}`);
}

function expect(name: string, version: string | null | undefined, want: boolean) {
  const got = eaTooOldForCloseFill(version);
  record(name, got === want, `version=${JSON.stringify(version)} expected=${want} got=${got}`);
}

// Boundary constants are the documented contract.
record(
  "boundary constants are 1.28",
  EA_CLOSE_FILL_MIN_MAJOR === 1 && EA_CLOSE_FILL_MIN_MINOR === 28,
  `major=${EA_CLOSE_FILL_MIN_MAJOR} minor=${EA_CLOSE_FILL_MIN_MINOR}`,
);

// Missing / unparseable versions are treated as "too old" — the nudge shows.
expect("null is too old", null, true);
expect("undefined is too old", undefined, true);
expect("empty string is too old", "", true);
expect("garbage is too old", "not-a-version", true);
expect("only-major is too old", "1", true);

// Below the boundary — too old, nudge shows.
expect("0.9 is too old", "0.9", true);
expect("1.26 is too old", "1.26", true);
expect("1.27 is too old", "1.27", true);
expect("1.0 is too old", "1.0", true);

// At or above the boundary — modern enough, nudge hidden.
expect("1.28 is modern", "1.28", false);
expect("1.29 is modern", "1.29", false);
expect("1.30 is modern", "1.30", false);
expect("2.0 is modern", "2.0", false);
expect("10.0 is modern", "10.0", false);

// Extra text around the version is tolerated (matches first x.y).
expect("EA version=1.27 is too old", "EA version=1.27", true);
expect("EA version=1.28 is modern", "EA version=1.28", false);

const failed = results.filter((r) => !r.pass);
// eslint-disable-next-line no-console
console.log(`\n${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) {
  process.exit(1);
}
