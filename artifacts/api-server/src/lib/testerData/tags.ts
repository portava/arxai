// Build TT — shared tags for tester demo-seed rows.
//
// The seeder (routes/testerData.ts) stamps every fabricated row with these
// tags so (a) the matching "clear" endpoint can delete exactly what it wrote
// and (b) analytics surfaces can exclude fabricated rows from anything they
// present as the trader's own history. Keeping the strings in one module is
// what makes "seed" and "clear" provably symmetric.

/** Marker written into `vault_events.kind` and embedded in seeded labels. */
export const TESTER_TAG = "TESTER_DEMO_SEED";

/** Prefix of `trade_journal.strategy` for every seeded journal row. */
export const TESTER_SEED_STRATEGY_PREFIX = `[${TESTER_TAG}]`;

/** Full strategy value written by the seeder. */
export const TESTER_SEED_STRATEGY = `${TESTER_SEED_STRATEGY_PREFIX} DEMO_SIMULATOR`;

/** `live_intents.intent_id` prefix for every seeded intent. */
export const TESTER_SEED_INTENT_PREFIX = "intent_seed_";
