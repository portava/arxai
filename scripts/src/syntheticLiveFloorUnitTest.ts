// DB-free unit test for the Deriv-synthetic LIVE-confirmation floor (Task #550).
//
// The live-fire harness (`syntheticLiveFloorQa.ts`, Task #542) proves the same
// floor end-to-end, but it needs a live DB, a real Deriv master connection, and
// QA_ALLOW_DB_MUTATION=true, so it CANNOT run inside `pnpm run ci` / `ci:guards`.
// That left the floor with no automated pre-commit guard.
//
// This test exercises the SAME floor with NO database, NO real master
// connection, and NO QA_ALLOW_DB_MUTATION. It drives:
//
//   1. the REAL per-symbol feed-status seam (`getDerivSymbolFeedStatus`) by
//      stubbing the Deriv WS tick cache — the documented test-only seam the
//      live-fire harness and derivSymbolFeedStatus.test.ts both use — to
//      deterministically present / withhold a live tick, and
//   2. the REAL shared floor contract (`evaluateSyntheticLiveFloor`) that BOTH
//      live chokepoints (createLiveDraft preflight + dispatchLiveCommand
//      re-check) now call, so the test pins the actual decision both paths use.
//
// It asserts the floor returns SYNTHETIC_FEED_NOT_LIVE_CONFIRMED for a
// non-ticking synthetic and does NOT fire (ALLOWED) for a ticking one — never
// weakening the gate.
//
// Per-symbol coverage (CASE 8) is driven from the canonical
// DERIV_SYNTHETIC_SYMBOLS list, so EVERY synthetic — the base volatility
// indices, the 1-second variants, Boom, Crash, Step, and the Jump indices — is
// pinned to its correct Deriv WS id and exercised against the real per-symbol
// feed-status seam, and any future symbol added to that list is automatically
// covered (or fails the completeness check loudly).

// The Deriv app-id must be "configured" BEFORE the provider import so the WS
// feed-status helper reports CONNECTING/LIVE_FEED honestly rather than
// UNCONFIGURED. Keep the AUTH_FAILED branch out of play (no token).
const ORIGINAL_DERIV_APP_ID = process.env.DERIV_APP_ID;
const ORIGINAL_DERIV_TOKEN = process.env.DERIV_API_TOKEN;
process.env.DERIV_APP_ID = ORIGINAL_DERIV_APP_ID && ORIGINAL_DERIV_APP_ID.trim()
  ? ORIGINAL_DERIV_APP_ID
  : "test-app-id";
delete process.env.DERIV_API_TOKEN;

type CheckResult = { id: number; name: string; ok: boolean; detail: string };
const results: CheckResult[] = [];
function record(id: number, name: string, ok: boolean, detail = ""): void {
  results.push({ id, name, ok, detail });
}

const SYMBOL = "V75";

async function main(): Promise<void> {
  // Pure floor contract (no IO) + the real feed-status seam (no DB). Dynamic
  // imports keep the provider singletons the SAME instances the stub mutates.
  const { evaluateSyntheticLiveFloor } =
    await import("@workspace/domain/safety-contracts/syntheticLiveFloor");
  const { getDerivSymbolFeedStatus, resolveDerivSymbol, isDerivSyntheticSymbol, DERIV_SYNTHETIC_SYMBOLS } =
    await import("../../artifacts/api-server/src/lib/data/providers/derivProvider.js");
  const { getDerivWsClient } =
    await import("../../artifacts/api-server/src/lib/data/providers/derivWsClient.js");
  const { resolveSymbolFeedVerdict } =
    await import("../../artifacts/api-server/src/lib/data/symbolFeedVerdict.js");

  // ── Deriv WS tick-cache stub (documented test-only seam) ────────────────
  // Force a fully-connected client with NO real socket, then seed/clear THIS
  // symbol's per-symbol tick to flip getDerivSymbolFeedStatus(SYMBOL).hasRecentTick.
  const wsClient = getDerivWsClient() as unknown as {
    ensureConnection: () => void;
    connected: boolean;
    activeSymbolsCount: number | null;
    authorized: boolean;
    lastAuthorizeError: string | null;
    lastTickAt: number | null;
    lastTickBySymbol: Map<string, { symbol: string; epoch: number; quote: number }>;
  };
  wsClient.ensureConnection = () => {};
  wsClient.connected = true;
  wsClient.activeSymbolsCount = 14;
  wsClient.authorized = false;
  wsClient.lastAuthorizeError = null;
  wsClient.lastTickAt = null;
  wsClient.lastTickBySymbol = new Map();

  const resolved = resolveDerivSymbol(SYMBOL);
  record(1, `${SYMBOL} resolves to a known Deriv synthetic instrument`,
    resolved != null, JSON.stringify(resolved));
  if (!resolved) {
    finish();
    return;
  }
  const derivId = resolved.derivId;
  const seedTick = () =>
    wsClient.lastTickBySymbol.set(derivId, { symbol: derivId, epoch: Math.floor(Date.now() / 1000), quote: 100 });
  const clearTick = () => wsClient.lastTickBySymbol.clear();

  // The owner-unrestricted profile on a Deriv broker that broker truth does NOT
  // block — the only profile the relaxation can apply to. The ONLY thing that
  // varies between the "blocked" and "allowed" cases below is the live tick.
  const ownerDerivBase = {
    isSyntheticOrDataOnly: true,
    isOwnerUnrestricted: true,
    brokerIsDeriv: true,
    brokerTruthBlocks: false,
  };

  // ── CASE 1 — un-ticking synthetic is refused (the safety floor) ─────────
  clearTick();
  const noTick = getDerivSymbolFeedStatus(SYMBOL).hasRecentTick;
  record(2, "feed-status seam reports NOT live with no tick", noTick === false, String(noTick));
  const blockedVerdict = evaluateSyntheticLiveFloor({ ...ownerDerivBase, feedVerdict: noTick ? "LIVE" : "AWAITING" });
  record(3, "un-ticking synthetic → SYNTHETIC_FEED_NOT_LIVE_CONFIRMED",
    blockedVerdict === "SYNTHETIC_FEED_NOT_LIVE_CONFIRMED", blockedVerdict);

  // ── CASE 2 — ticking synthetic is NOT floor-blocked (accuracy) ──────────
  seedTick();
  const freshTick = getDerivSymbolFeedStatus(SYMBOL).hasRecentTick;
  record(4, "feed-status seam reports LIVE with a fresh tick", freshTick === true, String(freshTick));
  const allowedVerdict = evaluateSyntheticLiveFloor({ ...ownerDerivBase, feedVerdict: freshTick ? "LIVE" : "AWAITING" });
  record(5, "ticking synthetic is NOT blocked by the synthetic floor (ALLOWED)",
    allowedVerdict === "ALLOWED", allowedVerdict);

  // ── CASE 3 — a stale tick (outside the freshness window) is refused ─────
  // Prove the freshness window, not mere tick presence, drives the verdict.
  wsClient.lastTickBySymbol.set(derivId, {
    symbol: derivId,
    epoch: Math.floor((Date.now() - 120_000) / 1000), // 120s ago, window is 30s
    quote: 100,
  });
  const staleTick = getDerivSymbolFeedStatus(SYMBOL).hasRecentTick;
  record(6, "feed-status seam reports NOT live with a stale (>30s) tick",
    staleTick === false, String(staleTick));
  const staleVerdict = evaluateSyntheticLiveFloor({ ...ownerDerivBase, feedVerdict: staleTick ? "LIVE" : "AWAITING" });
  record(7, "stale-tick synthetic → SYNTHETIC_FEED_NOT_LIVE_CONFIRMED",
    staleVerdict === "SYNTHETIC_FEED_NOT_LIVE_CONFIRMED", staleVerdict);

  // ── CASE 4 — a normal (non-owner) user always hits the hard data-only floor,
  // even with a fresh live tick. The relaxation is owner-unrestricted ONLY.
  seedTick();
  const normalUserVerdict = evaluateSyntheticLiveFloor({
    isSyntheticOrDataOnly: true,
    isOwnerUnrestricted: false,
    brokerIsDeriv: true,
    brokerTruthBlocks: false,
    feedVerdict: getDerivSymbolFeedStatus(SYMBOL).hasRecentTick ? "LIVE" : "AWAITING",
  });
  record(8, "normal user → SYMBOL_NOT_LIVE_TRADABLE even with a live tick",
    normalUserVerdict === "SYMBOL_NOT_LIVE_TRADABLE", normalUserVerdict);

  // ── CASE 5 — a non-Deriv broker hits the hard floor even for the owner. ──
  const nonDerivVerdict = evaluateSyntheticLiveFloor({
    ...ownerDerivBase, brokerIsDeriv: false, feedVerdict: "LIVE",
  });
  record(9, "owner on a non-Deriv broker → SYMBOL_NOT_LIVE_TRADABLE",
    nonDerivVerdict === "SYMBOL_NOT_LIVE_TRADABLE", nonDerivVerdict);

  // ── CASE 6 — broker truth blocking the symbol hits the hard floor. ──────
  const brokerBlockedVerdict = evaluateSyntheticLiveFloor({
    ...ownerDerivBase, brokerTruthBlocks: true, feedVerdict: "LIVE",
  });
  record(10, "owner + broker-truth-blocked symbol → SYMBOL_NOT_LIVE_TRADABLE",
    brokerBlockedVerdict === "SYMBOL_NOT_LIVE_TRADABLE", brokerBlockedVerdict);

  // ── CASE 7 — a non-synthetic symbol does not engage the floor at all. ───
  const notEngaged = evaluateSyntheticLiveFloor({
    isSyntheticOrDataOnly: false,
    isOwnerUnrestricted: true,
    brokerIsDeriv: true,
    brokerTruthBlocks: false,
    feedVerdict: "AWAITING",
  });
  record(11, "non-synthetic symbol → NOT_ENGAGED (floor does not apply)",
    notEngaged === "NOT_ENGAGED", notEngaged);

  // ── CASE 8 — full per-symbol coverage across the CANONICAL list (Task #559) ─
  // V75 (above) and the Jump indices (Task #555) were guarded, but the Boom,
  // Crash, Step, 1-second, and remaining base-volatility entries in
  // DERIV_SYNTHETIC_SYMBOLS still had NO pre-commit guard — full per-symbol
  // coverage only lived in the live-fire harness (syntheticLiveFloorQa.ts),
  // which needs a provisioned DB + a real Deriv master + QA_ALLOW_DB_MUTATION
  // and so CANNOT run in `pnpm run ci`. A wrong/missing Deriv WS id on any of
  // those symbols would ship undetected.
  //
  // This loop is DRIVEN from the canonical DERIV_SYNTHETIC_SYMBOLS list, so any
  // symbol added there in future is automatically covered: an entry with no
  // independently-pinned expected id below fails the completeness check loudly.
  // For EACH symbol it asserts, with NO DB: (a) it resolves via
  // resolveDerivSymbol to its correct, INDEPENDENTLY-hardcoded Deriv WS id
  // (reading the id back from the same list would be tautological and catch
  // nothing — pinning it here is what catches a wrong/missing id in the list),
  // (b) it classifies as a synthetic (the `isSyntheticOrDataOnly` input the live
  // pipeline derives), and (c) the floor actually ENGAGES — refusing an
  // un-ticking feed (SYNTHETIC_FEED_NOT_LIVE_CONFIRMED) and clearing only on a
  // confirmed fresh per-symbol tick (ALLOWED) for the owner-Deriv profile,
  // through the same real getDerivSymbolFeedStatus seam as V75.
  const EXPECTED_DERIV_IDS: Record<string, string> = {
    V10: "R_10", V25: "R_25", V50: "R_50", V75: "R_75", V100: "R_100",
    V10_1S: "1HZ10V", V25_1S: "1HZ25V", V50_1S: "1HZ50V", V75_1S: "1HZ75V", V100_1S: "1HZ100V",
    BOOM500: "BOOM500", BOOM1000: "BOOM1000",
    CRASH500: "CRASH500", CRASH1000: "CRASH1000",
    STEP: "stpRNG",
    JUMP10: "JD10", JUMP25: "JD25", JUMP50: "JD50", JUMP75: "JD75", JUMP100: "JD100",
  };
  let nextId = 12;
  for (const entry of DERIV_SYNTHETIC_SYMBOLS) {
    const label = entry.symbol;
    const expectedDerivId = EXPECTED_DERIV_IDS[label];

    // Completeness: a NEW canonical symbol with no independently-pinned
    // expectation here fails loudly instead of silently shipping unguarded.
    record(nextId++, `${label} has an independently-pinned expected Deriv WS id`,
      typeof expectedDerivId === "string" && expectedDerivId.length > 0,
      "expected id missing from EXPECTED_DERIV_IDS — add it");
    if (!expectedDerivId) {
      continue;
    }

    const symResolved = resolveDerivSymbol(label);
    record(nextId++, `${label} resolves via resolveDerivSymbol to ${expectedDerivId}`,
      symResolved?.derivId === expectedDerivId,
      `resolved=${JSON.stringify(symResolved)}`);

    record(nextId++, `${label} classifies as a synthetic instrument`,
      isDerivSyntheticSymbol(label) === true, String(isDerivSyntheticSymbol(label)));

    // Without a resolved id we cannot seed/clear this symbol's tick — skip the
    // floor assertions (the resolve check above already failed loudly).
    if (!symResolved) {
      record(nextId++, `${label} un-ticking → SYNTHETIC_FEED_NOT_LIVE_CONFIRMED`, false, "unresolved");
      record(nextId++, `${label} ticking → ALLOWED (owner-Deriv)`, false, "unresolved");
      continue;
    }
    const symId = symResolved.derivId;

    // (c1) un-ticking → the floor ENGAGES and refuses (not NOT_ENGAGED).
    clearTick();
    const symBlocked = evaluateSyntheticLiveFloor({
      ...ownerDerivBase,
      feedVerdict: getDerivSymbolFeedStatus(label).hasRecentTick ? "LIVE" : "AWAITING",
    });
    record(nextId++, `${label} un-ticking → SYNTHETIC_FEED_NOT_LIVE_CONFIRMED`,
      symBlocked === "SYNTHETIC_FEED_NOT_LIVE_CONFIRMED", symBlocked);

    // (c2) a fresh per-symbol tick clears the transient floor (ALLOWED). Seed
    // ONLY this symbol's tick so a different synthetic can never promote it.
    wsClient.lastTickBySymbol.clear();
    wsClient.lastTickBySymbol.set(symId, {
      symbol: symId, epoch: Math.floor(Date.now() / 1000), quote: 100,
    });
    const symAllowed = evaluateSyntheticLiveFloor({
      ...ownerDerivBase,
      feedVerdict: getDerivSymbolFeedStatus(label).hasRecentTick ? "LIVE" : "AWAITING",
    });
    record(nextId++, `${label} ticking → ALLOWED (owner-Deriv)`,
      symAllowed === "ALLOWED", symAllowed);
  }
  const delayedFloorVerdict = evaluateSyntheticLiveFloor({ ...ownerDerivBase, feedVerdict: "LIVE_DELAYED" });
  record(nextId++, "LIVE_DELAYED synthetic → SYNTHETIC_FEED_NOT_LIVE_CONFIRMED (delayed bar blocks the floor)",
    delayedFloorVerdict === "SYNTHETIC_FEED_NOT_LIVE_CONFIRMED", delayedFloorVerdict);

  const resolverCases: Array<{
    label: string;
    input: { hasRecentTick: boolean; trailingIntervals: number | null };
    expect: string;
  }> = [
    { label: "no tick → AWAITING", input: { hasRecentTick: false, trailingIntervals: 0 }, expect: "AWAITING" },
    { label: "tick + clean bar (gap 1) → LIVE", input: { hasRecentTick: true, trailingIntervals: 1 }, expect: "LIVE" },
    { label: "tick + delayed bar (gap 2) → LIVE_DELAYED", input: { hasRecentTick: true, trailingIntervals: 2 }, expect: "LIVE_DELAYED" },
    { label: "tick + stale bar (gap 3) → AWAITING", input: { hasRecentTick: true, trailingIntervals: 3 }, expect: "AWAITING" },
    { label: "tick + no candles (null) → AWAITING", input: { hasRecentTick: true, trailingIntervals: null }, expect: "AWAITING" },
  ];
  for (const rc of resolverCases) {
    const got = resolveSymbolFeedVerdict(rc.input);
    record(nextId++, `resolveSymbolFeedVerdict: ${rc.label}`, got === rc.expect, got);
  }

  clearTick();

  finish();
}

function finish(): void {
  // Restore Deriv env.
  if (ORIGINAL_DERIV_APP_ID === undefined) delete process.env.DERIV_APP_ID;
  else process.env.DERIV_APP_ID = ORIGINAL_DERIV_APP_ID;
  if (ORIGINAL_DERIV_TOKEN === undefined) delete process.env.DERIV_API_TOKEN;
  else process.env.DERIV_API_TOKEN = ORIGINAL_DERIV_TOKEN;

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) {
    // eslint-disable-next-line no-console
    console.log(`${r.ok ? "PASS" : "FAIL"}  #${String(r.id).padStart(2, "0")}  ${r.name}${r.ok ? "" : "  → " + r.detail}`);
  }
  // eslint-disable-next-line no-console
  console.log(`\n${passed}/${results.length} synthetic-live-floor unit checks passed`);
  if (passed !== results.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(2); });

export {};
