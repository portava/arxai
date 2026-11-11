// The pinned REAL-MARKETS fixture (scripts/fixtures/real-markets-v1/): deep M15
// and H1 history for real markets only (FX, metals, stock indices), for the
// session and volatility research.
//
// Same manifest format and verification as the intraday fixture
// (intradayHistoryFixture.ts): every file re-hashes to the manifest, the dataset
// hash re-derives, and it must equal the hash pinned in code. Produced only by
// fetchMarketsHistoryFixture.ts, by hand. CI only re-verifies.
//
// The directory deliberately does NOT start with "real-history-": the
// calibration bootstrap auto-discovers those, and this deep set is adopted there
// only on purpose, not by accident.
//
// Nothing here generates data.

import { join } from "node:path";
import { loadVerifiedIntradayFixture, type IntradayFixtureManifest, type LoadedIntradayInstrument } from "./intradayHistoryFixture.js";

export const MARKETS_FIXTURE_DIR_NAME = "real-markets-v1";
export const MARKETS_MANIFEST_VERSION = "arx-real-markets-fixture-v1";

/** Pinned after the one fetch; any change to the data must change this on purpose. */
export const PINNED_MARKETS_DATASET_HASH = "1aaef5d9707bc93b5b80e503407f1386192c220ef992195b84c66d7b87a65d53";

export function loadVerifiedMarketsFixture(fixturesRoot: string, pinned: string = PINNED_MARKETS_DATASET_HASH): { manifest: IntradayFixtureManifest; instruments: LoadedIntradayInstrument[] } {
  return loadVerifiedIntradayFixture(join(fixturesRoot, MARKETS_FIXTURE_DIR_NAME), pinned, MARKETS_MANIFEST_VERSION);
}
