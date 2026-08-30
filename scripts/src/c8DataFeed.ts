// C8 data feed — shared plumbing for the three CLIs.
//
// This is the only file in the C8 data path that touches a network or a
// filesystem. @workspace/markets holds the adapters, the integrity guard and
// the fingerprint as pure code with their I/O injected; this file supplies the
// real `fetch` and the real `node:fs`, so every one of those units stays
// exercisable offline.
//
// Nothing here places, sizes, or authorises a trade.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import {
  FileImportSource,
  FredCsvSource,
  StockAnalysisJsonSource,
  StooqCsvSource,
  checkSeriesIntegrity,
  formatIntegrityReport,
  isSeriesRefusal,
  serialiseSnapshot,
  type DailySeries,
  type DailySeriesSource,
  type IntegrityOptions,
  type PriceAdjustment,
  type SeriesFetchResult,
  type SeriesRange,
} from "@workspace/markets/daily-series";

/**
 * True when the environment routes egress through an HTTP proxy but this Node
 * process is not configured to use it.
 *
 * WHY THIS CHECK EARNS ITS PLACE. Node's global `fetch` (undici) does NOT read
 * `HTTPS_PROXY` unless `NODE_USE_ENV_PROXY=1` is set. In a proxied sandbox the
 * failure surfaces as `ENOTFOUND` — DNS refused — which reads as "the host is
 * unreachable" and would be reported as a blocked data source. It is nothing of
 * the sort: the host is fine and the runtime is misconfigured. Reporting the
 * first as the second is exactly the confident-wrong-answer this repository
 * forbids, so the misconfiguration is detected and named.
 *
 * Reads only whether the variables are SET. Their values are credentials and
 * are never read, logged, or included in any message.
 */
export function proxyConfiguredButUnused(env: NodeJS.ProcessEnv = process.env): boolean {
  const proxied =
    typeof env.HTTPS_PROXY === "string" ||
    typeof env.https_proxy === "string" ||
    typeof env.HTTP_PROXY === "string" ||
    typeof env.http_proxy === "string";
  const honoured = env.NODE_USE_ENV_PROXY === "1";
  return proxied && !honoured;
}

export const PROXY_HINT =
  "This environment sets an HTTP proxy but NODE_USE_ENV_PROXY is not 1, so Node's fetch bypasses it and " +
  "DNS fails. Re-run with NODE_USE_ENV_PROXY=1. Do NOT record this as a blocked data source.";

/** The real fetch, adapted to the injected `FetchLike` shape. */
export const nodeFetch = async (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
): Promise<{ ok: boolean; status: number; text(): Promise<string> }> => {
  try {
    const res = await fetch(url, { headers: init?.headers, ...(init?.signal ? { signal: init.signal } : {}) });
    return { ok: res.ok, status: res.status, text: () => res.text() };
  } catch (e) {
    const cause = (e as { cause?: { code?: string } })?.cause?.code;
    if ((cause === "ENOTFOUND" || cause === "ECONNREFUSED") && proxyConfiguredButUnused()) {
      throw new Error(`${cause} — ${PROXY_HINT}`);
    }
    throw e;
  }
};

export const readTextFile = (path: string): Promise<string> => readFile(path, "utf8");

export type NetworkSourceName = "fred" | "stooq" | "stockanalysis";

/**
 * The network adapters, constructed against the real fetch.
 *
 * REACHABILITY AS OBSERVED FROM THE BUILD SANDBOX ON 2026-08-29 — recorded so
 * the next reader does not repeat the probing:
 *   fred          REACHABLE. CSV returned. Price-only index levels. SP500/DJIA
 *                 are licence-truncated to ~10 years; NASDAQCOM/NASDAQ100 carry
 *                 full history.
 *   stockanalysis REACHABLE. JSON returned, split+dividend adjusted ETF closes,
 *                 SPY back to 1993. Licence UNVERIFIED — an owner gate.
 *   stooq         BLOCKED. HTTP 200 with a JavaScript proof-of-work browser
 *                 check instead of CSV, on both stooq.com and stooq.pl, with
 *                 and without a browser User-Agent. NOT worked around.
 * A host's status can change; `--probe` re-measures it rather than trusting
 * this comment.
 */
export function networkSource(name: NetworkSourceName): DailySeriesSource {
  switch (name) {
    case "fred":
      return new FredCsvSource(nodeFetch);
    case "stooq":
      return new StooqCsvSource(nodeFetch);
    case "stockanalysis":
      return new StockAnalysisJsonSource(nodeFetch, "adjusted");
  }
}

export function fileSource(opts: {
  path: string;
  adjustment: PriceAdjustment;
  originNote: string;
  dateHeaders?: readonly string[];
  valueColumn?: string | number;
}): DailySeriesSource {
  return new FileImportSource(readTextFile, {
    path: opts.path,
    adjustment: opts.adjustment,
    originNote: opts.originNote,
    ...(opts.dateHeaders ? { dateHeaders: opts.dateHeaders } : {}),
    ...(opts.valueColumn === undefined ? {} : { valueColumn: opts.valueColumn }),
  });
}

export function formatProvenance(series: DailySeries): string {
  const p = series.provenance;
  return [
    `  source       ${p.source}`,
    `  sourceSymbol ${p.sourceSymbol}`,
    `  request      ${p.request}`,
    `  fetchedAt    ${p.fetchedAt}`,
    `  adjustment   ${p.adjustment}`,
    `  termsOfUse   ${p.termsOfUse}`,
    `  detail       ${p.detail}`,
  ].join("\n");
}

export function describeFetchResult(r: SeriesFetchResult): string {
  if (isSeriesRefusal(r)) {
    const status = "status" in r ? ` (HTTP ${r.status})` : "";
    return `REFUSED ${r.code}${status}: ${r.detail}`;
  }
  return `${r.bars.length} bars${r.bars.length > 0 ? ` ${r.bars[0]!.date}..${r.bars[r.bars.length - 1]!.date}` : ""}`;
}

export interface IngestOutcome {
  ok: boolean;
  /** Present only when the fetch produced bars, whether or not they passed. */
  series: DailySeries | null;
  lines: string[];
}

/**
 * Fetch → report provenance → run the integrity guard → optionally snapshot.
 *
 * The snapshot is written ONLY when the guard passes. A refused series produces
 * a report and no file: a rejected dataset must not be sitting on disk where a
 * later run can pick it up.
 */
export async function ingest(opts: {
  source: DailySeriesSource;
  symbol: string;
  range: SeriesRange;
  at: string;
  integrity?: IntegrityOptions;
  outPath?: string;
}): Promise<IngestOutcome> {
  const lines: string[] = [];
  const result = await opts.source.fetchDailyCloses(opts.symbol, opts.range, opts.at);
  lines.push(`FETCH ${opts.source.name} ${opts.symbol} ${opts.range.from}..${opts.range.to}`);
  lines.push(`  ${describeFetchResult(result)}`);
  if (isSeriesRefusal(result)) return { ok: false, series: null, lines };

  lines.push("PROVENANCE");
  lines.push(formatProvenance(result));

  const report = checkSeriesIntegrity(result, opts.integrity);
  lines.push("INTEGRITY GUARD");
  lines.push(formatIntegrityReport(report));

  if (!report.ok) {
    lines.push("  NO SNAPSHOT WRITTEN — a refused series is refused whole, not trimmed to the clean part.");
    return { ok: false, series: result, lines };
  }

  if (opts.outPath !== undefined) {
    const abs = resolvePath(opts.outPath);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, serialiseSnapshot(result), "utf8");
    lines.push(`SNAPSHOT written to ${abs}`);
  } else {
    lines.push("SNAPSHOT skipped (no --out given)");
  }
  return { ok: true, series: result, lines };
}

// ── tiny argv parser ─────────────────────────────────────────────────────────

export type Argv = Record<string, string | boolean>;

export function parseArgv(argv: readonly string[]): Argv {
  const out: Argv = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

export function requireStr(argv: Argv, key: string): string {
  const v = argv[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`missing required --${key}`);
  }
  return v;
}
