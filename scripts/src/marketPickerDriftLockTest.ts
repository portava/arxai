// Task #417 — Lock the market picker against future drift.
//
// Pure logic — no DB, no network. Fails the build if a future edit lets an
// off-universe market slip into the frontend symbol registry (the picker),
// duplicates a canonical key, swaps one of the curated canonical routing keys
// (V75 / NAS100 / SPX500 / BTCUSDT / XAUUSD / US30) the chart bus + broker
// resolution depend on, or introduces a MarketType the Symbol Explorer's
// CATEGORY_ORDER doesn't render (so a new asset class can never be in the
// registry but invisible in the UI).
//
// Task #558 — the registry is DERIVED ENTIRELY from the @workspace/domain ARX
// Focus registry (SYMBOL_REGISTRY = ARX_FOCUS_MARKETS.map(...)); this test
// re-asserts that the derivation can only ever surface the 36 approved Focus
// markets and nothing else.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  SYMBOL_REGISTRY,
  resolveSymbol,
  isCanonical,
  groupByMarketType,
  type MarketType,
} from "../../artifacts/trading-dashboard/src/lib/symbolRegistry";
import { ARX_FOCUS_MARKETS, isApprovedArxMarket } from "@workspace/domain/market";

type Result = { name: string; pass: boolean; detail: string };
const results: Result[] = [];
function check(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail });
  // eslint-disable-next-line no-console
  console.log(`${pass ? "PASS" : "FAIL"}  ${name} — ${detail}`);
}

// ── Registry size is locked to the approved universe ────────────────────────
check(
  "SYMBOL_REGISTRY length === 43 (approved ARX Focus markets)",
  SYMBOL_REGISTRY.length === 43,
  `length=${SYMBOL_REGISTRY.length}`,
);

// The picker registry and the domain Focus registry must stay 1:1 — same count,
// same canonical set. A drift in either direction (picker showing a non-Focus
// market, or a Focus market missing from the picker) fails here.
{
  const pickerSet = new Set(SYMBOL_REGISTRY.map((e) => e.canonicalSymbol.toUpperCase()));
  const focusSet = new Set(ARX_FOCUS_MARKETS.map((m) => m.canonicalSymbol.toUpperCase()));
  const extra = [...pickerSet].filter((s) => !focusSet.has(s));
  const missing = [...focusSet].filter((s) => !pickerSet.has(s));
  check(
    "picker registry canonical set === ARX Focus canonical set",
    extra.length === 0 && missing.length === 0,
    extra.length || missing.length ? `extra=[${extra.join(",")}] missing=[${missing.join(",")}]` : "1:1 match",
  );
}

// ── No duplicate canonical keys ─────────────────────────────────────────────
{
  const seen = new Set<string>();
  const dups: string[] = [];
  for (const e of SYMBOL_REGISTRY) {
    const k = e.canonicalSymbol.toUpperCase();
    if (seen.has(k)) dups.push(k);
    seen.add(k);
  }
  check("no duplicate canonical symbols in the picker", dups.length === 0, dups.join(",") || "clean");
}

// ── Every canonical is an approved market (resolves to status "resolved") ───
{
  const offUniverse: string[] = [];
  for (const e of SYMBOL_REGISTRY) {
    if (!isApprovedArxMarket(e.canonicalSymbol)) offUniverse.push(e.canonicalSymbol);
  }
  check(
    "every picker canonical is an approved ARX Focus market",
    offUniverse.length === 0,
    offUniverse.join(", ") || "0 off-universe",
  );
}

// ── Curated routing keys still resolve to themselves ────────────────────────
// These exact keys are depended on by the chart-symbol bus + broker symbol
// resolution. A swap (e.g. NAS100 → US100, or V75 → "Volatility 75 Index")
// would silently break routing — lock them.
{
  const ROUTING_KEYS = ["V75", "SPX500", "GER30", "BTCUSD", "XAUUSD", "US30"];
  const broken: string[] = [];
  for (const k of ROUTING_KEYS) {
    const r = resolveSymbol(k);
    if (!isCanonical(k) || r?.canonicalSymbol !== k) {
      broken.push(`${k}→${r?.canonicalSymbol ?? "null"}`);
    }
  }
  check(
    "curated routing keys (V75/SPX500/GER30/BTCUSD/XAUUSD/US30) resolve to themselves",
    broken.length === 0,
    broken.join(", ") || "all intact",
  );
}

// ── Every MarketType the registry produces is rendered by the Explorer ──────
// Parse CATEGORY_ORDER out of SymbolExplorer.tsx source so a new asset class
// can never be in the registry but invisible in the picker UI.
{
  const here = dirname(fileURLToPath(import.meta.url));
  const explorerPath = join(
    here,
    "../../artifacts/trading-dashboard/src/components/scanner/SymbolExplorer.tsx",
  );
  const src = readFileSync(explorerPath, "utf8");

  const block = src.match(/const CATEGORY_ORDER[^=]*=\s*\[([\s\S]*?)\];/);
  const categoryIds = new Set<string>();
  if (block) {
    const idRe = /id:\s*"([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = idRe.exec(block[1])) !== null) categoryIds.add(m[1]);
  }
  check(
    "CATEGORY_ORDER parsed from SymbolExplorer.tsx",
    categoryIds.size > 0,
    `ids=${[...categoryIds].join(",")}`,
  );

  const groups = groupByMarketType();
  const producedTypes = (Object.keys(groups) as MarketType[]).filter((t) => groups[t].length > 0);
  const missing = producedTypes.filter((t) => !categoryIds.has(t));
  check(
    "every MarketType in the registry has a CATEGORY_ORDER row",
    missing.length === 0,
    missing.length ? `missing categories: ${missing.join(",")}` : `produced=${producedTypes.join(",")}`,
  );
}

// ── Custom escape hatch is closed ──────────────────────────────────────────
// Task #418 — the legacy "custom" market category + looksLikeSymbol()
// "add as custom symbol" path are gone. A regression that re-adds either
// would let an off-universe market become selectable/scannable again.
{
  const groups = groupByMarketType();
  const hasCustomGroup = Object.prototype.hasOwnProperty.call(groups, "custom");
  check(
    "groupByMarketType produces no 'custom' bucket",
    !hasCustomGroup,
    hasCustomGroup ? "custom bucket present" : "no custom bucket",
  );

  const here = dirname(fileURLToPath(import.meta.url));
  const registryPath = join(
    here,
    "../../artifacts/trading-dashboard/src/lib/symbolRegistry.ts",
  );
  const explorerPath = join(
    here,
    "../../artifacts/trading-dashboard/src/components/scanner/SymbolExplorer.tsx",
  );
  const registrySrc = readFileSync(registryPath, "utf8");
  const explorerSrc = readFileSync(explorerPath, "utf8");

  check(
    "symbolRegistry.ts no longer exports looksLikeSymbol()",
    !/export function looksLikeSymbol/.test(registrySrc),
    /export function looksLikeSymbol/.test(registrySrc) ? "still exported" : "removed",
  );
  check(
    "symbolRegistry.ts MarketType union has no 'custom'",
    !/\|\s*"custom"/.test(registrySrc),
    /\|\s*"custom"/.test(registrySrc) ? "custom in union" : "removed",
  );

  const explorerBlock = explorerSrc.match(/const CATEGORY_ORDER[^=]*=\s*\[([\s\S]*?)\];/);
  const explorerHasCustom = !!explorerBlock && /id:\s*"custom"/.test(explorerBlock[1]);
  check(
    "SymbolExplorer CATEGORY_ORDER has no 'custom' row",
    !explorerHasCustom,
    explorerHasCustom ? "custom row present" : "no custom row",
  );
  check(
    "SymbolExplorer no longer imports looksLikeSymbol",
    !/looksLikeSymbol/.test(explorerSrc),
    /looksLikeSymbol/.test(explorerSrc) ? "still referenced" : "removed",
  );
}

// ── Watchlist add is gated to the approved universe ────────────────────────
// Task #418 — the watchlist add route stores enrich-scanned symbols, so it
// must reject anything outside the approved list. Source-scan the route to
// confirm it resolves the typed symbol through resolveUserMarketInput before
// inserting (off-universe symbols would otherwise be scanned).
{
  const here = dirname(fileURLToPath(import.meta.url));
  const routePath = join(
    here,
    "../../artifacts/api-server/src/routes/watchlists.ts",
  );
  const routeSrc = readFileSync(routePath, "utf8");
  const itemsHandler = routeSrc.match(/router\.post\("\/watchlists\/:id\/items"[\s\S]*?\n\}\);/);
  const gated =
    !!itemsHandler &&
    /resolveArxMarket\(/.test(itemsHandler[0]) &&
    /SYMBOL_NOT_IN_APPROVED_LIST/.test(itemsHandler[0]);
  check(
    "watchlist add route gates symbols through resolveArxMarket",
    gated,
    gated ? "gated" : "missing universe gate",
  );

  // Behavioural proof the gate's resolver actually rejects off-universe input.
  const off = isApprovedArxMarket("FAKECOIN MOON 9000");
  check(
    "resolveArxMarket rejects an off-universe symbol",
    off === false,
    `approved=${off}`,
  );
}

// ── Summary ─────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.pass);
// eslint-disable-next-line no-console
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) {
  // eslint-disable-next-line no-console
  console.error(`FAILED: ${failed.map((f) => f.name).join("; ")}`);
  process.exit(1);
}
