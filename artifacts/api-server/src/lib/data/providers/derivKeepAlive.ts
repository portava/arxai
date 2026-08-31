import { logger } from "../../logger.js";
import { getDerivWsClient } from "./derivWsClient.js";
import { DERIV_SYNTHETIC_SYMBOLS, resolveDerivSymbol } from "./derivProvider.js";
import { startDerivFormingBridge } from "../chart/derivFormingBridge.js";
import { mapWithConcurrency } from "../../marketScanner.js";

const KEEP_ALIVE_INTERVAL_MS = 20_000;
const PER_SYMBOL_COOLDOWN_MS = 15_000;
const KEEP_ALIVE_CONCURRENCY = 4;
const KEEP_ALIVE_CANDLE_GRANULARITY = 60;
const KEEP_ALIVE_CANDLE_COUNT = 3;

// Phase 2 four-symbol universe (vision.md:243; audit-deriv.md G8), expressed
// as ARX labels and resolved through the canonical DERIV_SYNTHETIC_SYMBOLS map
// at call time — the venue ids (1HZ25V / 1HZ50V / R_75 / 1HZ75V) are looked
// up, never restated here, so this list cannot drift from the map. Runtime
// discovery validation (derivSymbolDiscovery) independently checks the map
// itself against the venue's active_symbols.
export const DERIV_PHASE2_UNIVERSE_ARX_LABELS = ["V25_1S", "V50_1S", "V75", "V75_1S"] as const;

export interface ResolvedDerivUniverse {
  /** Deriv venue ids the keep-alive should pin (deduped, input order). */
  derivIds: string[];
  source: "env" | "default";
  /** ARX_DERIV_UNIVERSE entries that matched NO known symbol — skipped and
   *  reported, never guessed (honesty doctrine). */
  invalidEntries: string[];
}

/**
 * Resolve the configured keep-alive universe (audit G8/G11, R5 slice 7).
 *
 * ARX_DERIV_UNIVERSE is a comma list of ARX labels or Deriv ids (e.g.
 * "V75,1HZ25V"). Entries are resolved through the static map via
 * resolveDerivSymbol; unresolvable entries are reported in `invalidEntries`
 * and skipped — never guessed into a venue id. When the env var is unset,
 * empty, or yields zero valid entries, the default is the four-symbol Phase 2
 * universe (a fully invalid config falls back to the default rather than
 * silencing the keep-alive entirely, WITH the invalid entries reported —
 * the Phase 2 data floor is the safer failure mode than a dead feed).
 *
 * NOTE (read before widening): the client has NO per-symbol consumer tracking
 * (eagerWarmupSymbols is add-only and conflates warm-up pins with on-demand
 * subscribes), so "symbols with active consumers" cannot be computed today —
 * this env-configured universe is option (b) of R5 slice 7. On-demand symbols
 * outside the universe still subscribe through the provider paths and still
 * re-subscribe after reconnects via the client's eager set; they simply stop
 * receiving the every-20s keep-alive candle refresh.
 */
export function resolveConfiguredDerivUniverse(
  rawEnvValue: string | undefined = process.env.ARX_DERIV_UNIVERSE,
): ResolvedDerivUniverse {
  const invalidEntries: string[] = [];
  const fromEnv: string[] = [];
  const seen = new Set<string>();
  for (const part of (rawEnvValue ?? "").split(",")) {
    const entry = part.trim();
    if (entry.length === 0) continue;
    const resolved = resolveDerivSymbol(entry);
    if (!resolved) {
      invalidEntries.push(entry);
      continue;
    }
    if (!seen.has(resolved.derivId)) {
      seen.add(resolved.derivId);
      fromEnv.push(resolved.derivId);
    }
  }
  if (fromEnv.length > 0) {
    return { derivIds: fromEnv, source: "env", invalidEntries };
  }
  const defaults: string[] = [];
  for (const label of DERIV_PHASE2_UNIVERSE_ARX_LABELS) {
    const resolved = resolveDerivSymbol(label);
    // A Phase 2 label missing from the canonical map is a wiring defect —
    // report it rather than silently shrinking the default universe.
    if (!resolved) {
      invalidEntries.push(label);
      continue;
    }
    defaults.push(resolved.derivId);
  }
  return { derivIds: defaults, source: "default", invalidEntries };
}

let started = false;
let cycleInFlight = false;
let invalidUniverseWarned = false;
const lastRefreshBySymbol = new Map<string, number>();
/** Symbols whose live-tick subscription this session cannot have, logged once each. */
const tickSubscribeUnavailable = new Set<string>();

function derivConfigured(): boolean {
  return Boolean(process.env.DERIV_APP_ID && process.env.DERIV_APP_ID.trim());
}

async function runKeepAliveCycle(): Promise<void> {
  if (cycleInFlight) return;
  if (!derivConfigured()) return;
  cycleInFlight = true;
  try {
    const client = getDerivWsClient();
    client.ensureConnection();
    // BOOT RACE, observed live 2026-08-31. startDerivKeepAlive fires the first
    // cycle immediately, but ensureConnection() only STARTS the handshake — so
    // that cycle used to run its whole symbol sweep against a socket that was
    // still connecting and log a warning per symbol ("ws_not_connected"), four
    // alarming lines on every single boot for a condition that heals itself on
    // the next tick 20s later. Warnings that always fire are warnings nobody
    // reads. Skip the cycle instead: no work is lost, the interval retries, and
    // a REAL candle failure keeps its warning.
    if (!client.isConnected()) return;
    // Narrowed universe (audit collision #5): the keep-alive previously pinned
    // ALL 22 mapped synthetics every cycle. It now pins only the configured
    // universe (default: the four-symbol Phase 2 set). Re-resolved every cycle
    // so an env change takes effect without a restart.
    const universe = resolveConfiguredDerivUniverse();
    if (universe.invalidEntries.length > 0 && !invalidUniverseWarned) {
      invalidUniverseWarned = true;
      logger.warn(
        { invalidEntries: universe.invalidEntries, source: universe.source, derivIds: universe.derivIds },
        "ARX_DERIV_UNIVERSE entries did not resolve against the canonical symbol map — skipped, never guessed",
      );
    }
    const universeIds = new Set(universe.derivIds);
    const now = Date.now();
    const due = DERIV_SYNTHETIC_SYMBOLS.filter((s) => {
      if (!universeIds.has(s.derivId)) return false;
      const last = lastRefreshBySymbol.get(s.derivId) ?? 0;
      return now - last >= PER_SYMBOL_COOLDOWN_MS;
    });
    if (due.length === 0) return;
    await mapWithConcurrency(due, KEEP_ALIVE_CONCURRENCY, async (s) => {
      // TICKS AND CANDLES ARE SEPARATE CAPABILITIES — proven against the live
      // venue 2026-08-31. On a credential-free public session (Ruling 15 new
      // mode) `ticks`/`ticks_history subscribe` are refused InvalidSymbol and
      // `active_symbols` returns an empty list, while historical
      // `ticks_history` candles are served normally.
      //
      // They used to share one try block with the subscribe FIRST, so a
      // refused subscription threw before getCandles ever ran: the candle
      // warm-up — the thing the chart actually draws — was skipped entirely,
      // and because lastRefreshBySymbol was never stamped the symbol stayed
      // permanently "due" and re-warned every cycle forever. Candles are the
      // payload; a live tick is an upgrade on top of them.
      try {
        await client.subscribeTicks(s.derivId);
      } catch (err) {
        // Log ONCE per symbol per process. A capability this session does not
        // have is a standing condition, not a recurring incident, and a line
        // every cycle buries real faults.
        if (!tickSubscribeUnavailable.has(s.derivId)) {
          tickSubscribeUnavailable.add(s.derivId);
          logger.info(
            { symbol: s.derivId, reason: String(err) },
            "Deriv live-tick subscription unavailable for this symbol — historical candles continue; " +
            "an unauthenticated public session serves history but not streaming ticks",
          );
        }
      }
      try {
        await client.getCandles(s.derivId, KEEP_ALIVE_CANDLE_GRANULARITY, KEEP_ALIVE_CANDLE_COUNT);
        lastRefreshBySymbol.set(s.derivId, Date.now());
      } catch (err) {
        logger.warn({ err: String(err), symbol: s.derivId }, "Deriv keep-alive candle refresh failed (non-fatal)");
      }
    });
  } catch (err) {
    logger.warn({ err: String(err) }, "Deriv keep-alive cycle failed (non-fatal)");
  } finally {
    cycleInFlight = false;
  }
}

export function startDerivKeepAlive(): void {
  if (started) return;
  started = true;
  // Feed the chart's forming-bar composer from the SAME tick stream this keeps
  // alive, so a Deriv-fed chart's tip advances on real ticks instead of waiting
  // a whole interval for the next closed candle (Theme C3.1). Display-only;
  // idempotent; failure here must never stop the keep-alive itself.
  try {
    startDerivFormingBridge();
  } catch (err) {
    logger.warn({ err: String(err) }, "Deriv forming-bar bridge start failed (non-fatal)");
  }
  void runKeepAliveCycle();
  const timer = setInterval(() => {
    void runKeepAliveCycle();
  }, KEEP_ALIVE_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
}
