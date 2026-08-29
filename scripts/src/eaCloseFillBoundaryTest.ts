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
  explainUnknownPnl,
  isSimulatedUnpricedClose,
  PNL_FLAG_SIMULATED_CLOSE,
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

// ── explainUnknownPnl: WHY this row has no P/L ─────────────────────────────
//
// REVIEW FINDING (high): pnlStatus="UNKNOWN" is written by two unrelated
// paths. The simulated close (POST /trade-management/:id/close, flag
// SIMULATED_CLOSE_NO_PRICED_PNL) involves no EA and no broker and leaves
// reportedEaVersion null — and `eaTooOldForCloseFill(null)` is true by design,
// so the Trade Logs cell printed "EA too old to report close fill — upgrade to
// v1.28" plus a tooltip asserting "the broker did not return a usable close
// fill price" for a close that had no EA and no broker in it. These pin the
// split so the nudge cannot leak back onto simulated rows.

const simulated = explainUnknownPnl({
  dataQualityFlag: PNL_FLAG_SIMULATED_CLOSE,
  reportedEaVersion: null,
});
record(
  "simulated close never shows the EA upgrade nudge",
  simulated.showEaUpgradeHint === false && simulated.cause === "SIMULATED_CLOSE",
  `cause=${simulated.cause} showEaUpgradeHint=${simulated.showEaUpgradeHint}`,
);
record(
  "simulated close tooltip does not claim a broker close-result",
  !/broker did not return/i.test(simulated.tooltip) && /simulator/i.test(simulated.tooltip),
  JSON.stringify(simulated.tooltip),
);
record(
  "simulated close is still excluded from totals in its own words",
  /excluded from your totals/i.test(simulated.tooltip),
  JSON.stringify(simulated.tooltip),
);

// An old EA on a simulated row must STILL not be blamed — the flag wins.
const simulatedOldEa = explainUnknownPnl({
  dataQualityFlag: PNL_FLAG_SIMULATED_CLOSE,
  reportedEaVersion: "1.27",
});
record(
  "the simulated flag wins over an old EA version",
  simulatedOldEa.showEaUpgradeHint === false,
  `showEaUpgradeHint=${simulatedOldEa.showEaUpgradeHint}`,
);

// A real broker close with a missing fill keeps the existing behaviour.
const brokerOldEa = explainUnknownPnl({
  dataQualityFlag: "MISSING_CLOSE_FILL_PRICE",
  reportedEaVersion: null,
});
record(
  "broker close-fill gap with a null EA version still nudges",
  brokerOldEa.showEaUpgradeHint === true &&
    brokerOldEa.cause === "BROKER_CLOSE_FILL_MISSING",
  `cause=${brokerOldEa.cause} showEaUpgradeHint=${brokerOldEa.showEaUpgradeHint}`,
);
const brokerModernEa = explainUnknownPnl({
  dataQualityFlag: "MISSING_CLOSE_FILL_PRICE",
  reportedEaVersion: "1.28",
});
record(
  "broker close-fill gap on a modern EA does not nudge",
  brokerModernEa.showEaUpgradeHint === false,
  `showEaUpgradeHint=${brokerModernEa.showEaUpgradeHint}`,
);
record(
  "an unflagged UNKNOWN row keeps the broker explanation (unchanged default)",
  explainUnknownPnl({ reportedEaVersion: "1.27" }).cause === "BROKER_CLOSE_FILL_MISSING",
  "no dataQualityFlag",
);
record(
  "isSimulatedUnpricedClose is exact — no substring or null match",
  isSimulatedUnpricedClose(PNL_FLAG_SIMULATED_CLOSE) &&
    !isSimulatedUnpricedClose(null) &&
    !isSimulatedUnpricedClose("MISSING_CLOSE_FILL_PRICE") &&
    !isSimulatedUnpricedClose("SIMULATED_CLOSE"),
  `flag=${PNL_FLAG_SIMULATED_CLOSE}`,
);

const failed = results.filter((r) => !r.pass);
// eslint-disable-next-line no-console
console.log(`\n${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) {
  process.exit(1);
}
