// Source adapter: FILE IMPORT — the owner drops a CSV (or an ARX snapshot).
//
// This is the path that always exists. Every network source can be blocked, go
// down, change its terms, or start serving a bot challenge; a file the owner
// downloaded in a browser cannot. It is also the ONLY path whose adjustment
// basis is a stated fact rather than a vendor inference, because the person who
// downloaded the file is the person who knows what they downloaded.
//
// THE ADJUSTMENT IS A REQUIRED CONSTRUCTOR ARGUMENT. There is no default. An
// owner who does not know what their file is passes `"unknown"`, the integrity
// guard refuses the series, and they go and find out. That is a working day
// lost and a wrong twenty-year backtest avoided.
//
// Filesystem access is INJECTED (`readTextFile`), so this package stays I/O
// free and the adapter is testable with an in-memory map.

import type {
  DailySeriesSource,
  PriceAdjustment,
  SeriesFetchResult,
  SeriesRange,
} from "../types.js";
import { parseDateValueCsv, sortBars, clipToRange, classifyBody } from "../parse.js";
import { parseSnapshot } from "../snapshot.js";

export type ReadTextFile = (path: string) => Promise<string>;

export interface FileImportOptions {
  /** Absolute path to the CSV or ARX snapshot. */
  path: string;
  /**
   * What the file's prices ARE. Required — see the header. Ignored for an ARX
   * snapshot, which carries its own provenance.
   */
  adjustment: PriceAdjustment;
  /** Acceptable names for the date column. */
  dateHeaders?: readonly string[];
  /** Name of the close column, or a 0-based index. */
  valueColumn?: string | number;
  /** Free text describing where the owner got the file. Recorded verbatim. */
  originNote: string;
}

export class FileImportSource implements DailySeriesSource {
  readonly name = "file-import";
  readonly adjustment: PriceAdjustment;
  readonly termsOfUse = "UNVERIFIED" as const;

  constructor(
    private readonly readTextFile: ReadTextFile,
    private readonly opts: FileImportOptions,
  ) {
    this.adjustment = opts.adjustment;
  }

  async fetchDailyCloses(symbol: string, range: SeriesRange, at: string): Promise<SeriesFetchResult> {
    let text: string;
    try {
      text = await this.readTextFile(this.opts.path);
    } catch (e) {
      return {
        refused: true,
        code: "READ_FAILED",
        detail: `cannot read ${this.opts.path}: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    if (classifyBody(text) === "empty") {
      return { refused: true, code: "EMPTY_RESPONSE", detail: `${this.opts.path} is empty` };
    }

    // An ARX snapshot is self-describing and fingerprint-verified; prefer it.
    if (text.trimStart().startsWith("{")) {
      const snap = parseSnapshot(text);
      if (!snap.ok) {
        return { refused: true, code: "NOT_THE_EXPECTED_FORMAT", detail: `${snap.code}: ${snap.detail}` };
      }
      const bars = clipToRange(snap.series.bars, range.from, range.to);
      return {
        symbol: snap.series.symbol,
        bars,
        provenance: {
          ...snap.series.provenance,
          request: `file:${this.opts.path}`,
          detail:
            `ARX snapshot re-imported from ${this.opts.path} (fingerprint ${snap.fingerprint.slice(0, 16)} verified ` +
            `against its own bars). Original provenance: ${snap.series.provenance.detail}`,
        },
      };
    }

    const parsed = parseDateValueCsv(text, {
      dateHeaders: this.opts.dateHeaders ?? ["date", "observation_date", "datetime", "day"],
      valueColumn: this.opts.valueColumn ?? "close",
    });
    if ("error" in parsed) {
      return { refused: true, code: "NOT_THE_EXPECTED_FORMAT", detail: `${this.opts.path}: ${parsed.error}` };
    }
    const bars = clipToRange(sortBars(parsed.bars), range.from, range.to);

    return {
      symbol: symbol.toUpperCase(),
      bars,
      provenance: {
        source: this.name,
        sourceSymbol: symbol.toUpperCase(),
        request: `file:${this.opts.path}`,
        fetchedAt: at,
        adjustment: this.adjustment,
        termsOfUse: this.termsOfUse,
        detail:
          `Owner-supplied file. Adjustment "${this.adjustment}" is DECLARED BY THE IMPORTER — this adapter ` +
          "measured nothing about the file's basis and does not claim to. " +
          `Origin as stated by the importer: ${this.opts.originNote}. ` +
          `${parsed.blankRows} blank row(s) dropped, ${parsed.unparsableRows} unparsable row(s) dropped ` +
          `(dropped, never zeroed). Columns seen: [${parsed.header.join(", ")}].`,
      },
    };
  }
}
