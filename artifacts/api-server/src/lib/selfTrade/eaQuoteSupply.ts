// Which supported EA builds actually stream per-symbol broker quotes.
//
// The final entry claim needs a fresh `mt5_broker` quote for the command's
// symbol. Only an EA that POSTs TICK messages to /api/bridge/v2/ingest can
// supply one; the shipped connection kit (ReplitMT5BridgeEA v1.31) never does,
// so on such a bridge every agent entry refuses ENTRY_FRESH_QUOTE_UNAVAILABLE.
// This pure lookup turns the bridge's reported `eaVersion` into an explicit
// statement for the refusal detail and audit, so an operator reads "EA v1.31
// does not stream broker quotes" instead of a bare UNAVAILABLE. It changes no
// outcome: the claim still fails closed on a missing quote whatever the EA.
//
// The table is keyed by exact major.minor version and verified by reading the
// EA sources in mt5-bridge/ (see docs/SELF_TRADING_BROKER_QUOTE_SUPPLY_2026_10_27.md
// for the per-file cites). A version that is not in the table is "UNKNOWN":
// nothing is inferred from version ordering, because a later build may drop or
// gate the stream (v2.00 ships it opt-in and off).

export type EaQuoteStreamSupport =
  /** Streams TICKs for the EA's `CandleSymbols` set (default: chart symbol) by default. */
  | "STREAMS_CONFIGURED_SYMBOLS"
  /** Has a TICK stream but it is an opt-in input that defaults to off. */
  | "OPT_IN_DEFAULT_OFF"
  /** No TICK, quote or candle POST anywhere in the build. */
  | "NONE"
  /** Version missing, malformed or not in the verified table. */
  | "UNKNOWN";

export interface EaQuoteSupply {
  /** The version as reported by the bridge heartbeat, trimmed; null when absent. */
  eaVersion: string | null;
  /** The major.minor key that was looked up; null when it could not be parsed. */
  versionKey: string | null;
  quoteStream: EaQuoteStreamSupport;
  /** One operator-facing sentence citing the EA source. */
  note: string;
}

interface KnownBuild {
  file: string;
  quoteStream: EaQuoteStreamSupport;
  note: string;
}

const NO_STREAM_NOTE = "posts heartbeat/account/position/command traffic only; no TICK, quote or candle POST";

// Verified against mt5-bridge/*.mq5 on 2026-10-27 (grep for
// "/api/bridge/v2/ingest", "/api/mt5/sync-quotes" and PushLiveTickV2).
const KNOWN_BUILDS: Readonly<Record<string, KnownBuild>> = {
  "1.27": { file: "ReplitMT5BridgeEA.mq5", quoteStream: "NONE", note: NO_STREAM_NOTE },
  "1.28": { file: "ReplitMT5BridgeEA_v128.mq5", quoteStream: "NONE", note: NO_STREAM_NOTE },
  "1.29": { file: "ReplitMT5BridgeEA_v129.mq5", quoteStream: "NONE", note: NO_STREAM_NOTE },
  "1.30": { file: "ReplitMT5BridgeEA_DemoExec_v130.mq5", quoteStream: "NONE", note: NO_STREAM_NOTE },
  "1.31": {
    file: "ReplitMT5BridgeEA_v131.mq5",
    quoteStream: "NONE",
    note: "the shipped connection kit; pushes symbol specs every 300 s but never a quote, tick or candle",
  },
  "1.40": { file: "ARX_AI_Bridge_v140_PendingOrders.mq5", quoteStream: "NONE", note: NO_STREAM_NOTE },
  "1.50": { file: "ARX_AI_Universal_Agent_v150.mq5", quoteStream: "NONE", note: NO_STREAM_NOTE },
  "1.51": {
    file: "ARX_AI_Universal_Agent_v151.mq5",
    quoteStream: "NONE",
    note: "posts closed-candle history to /api/mt5/candles/ingest only; no TICK or quote",
  },
  "1.52": {
    file: "ARX_AI_Universal_Agent_v152.mq5",
    quoteStream: "STREAMS_CONFIGURED_SYMBOLS",
    note: "PushLiveTickV2 every 2 s for the CandleSymbols CSV (default: the chart symbol only), broker-native names",
  },
  "1.54": {
    file: "ARX_AI_Universal_Agent_v154.mq5",
    quoteStream: "STREAMS_CONFIGURED_SYMBOLS",
    note: "PushLiveTickV2 every 2 s for the CandleSymbols CSV (default: the chart symbol only), broker-native names",
  },
  "2.00": {
    file: "ARX_AI_Bridge_v2_Beta_Kernel.mq5",
    quoteStream: "OPT_IN_DEFAULT_OFF",
    note: "PushTick for the chart symbol only when EnableTickStream=true (input default false)",
  },
};

/** "v1.54", " 1.54 ", "1.54.2", "1.54-beta" → "1.54"; anything else → null. */
export function eaVersionKey(eaVersion: unknown): string | null {
  if (typeof eaVersion !== "string") return null;
  // A patch/suffix may follow only after ".", "-", "_" or whitespace.
  const m = /^\s*[vV]?(\d+)\.(\d+)(?:[.\-_\s].*)?$/s.exec(eaVersion);
  if (!m) return null;
  return `${Number(m[1])}.${m[2]}`;
}

export function describeEaQuoteSupply(eaVersion: unknown): EaQuoteSupply {
  const reported = typeof eaVersion === "string" && eaVersion.trim() !== "" ? eaVersion.trim() : null;
  const versionKey = eaVersionKey(eaVersion);
  const known = versionKey == null ? undefined : KNOWN_BUILDS[versionKey];
  if (!known)
    return {
      eaVersion: reported,
      versionKey,
      quoteStream: "UNKNOWN",
      note:
        reported == null
          ? "bridge reported no EA version; whether it streams broker quotes is unknown"
          : `EA v${reported} is not in the verified table; whether it streams broker quotes is unknown`,
    };
  const verb =
    known.quoteStream === "NONE"
      ? "does not stream broker quotes"
      : known.quoteStream === "OPT_IN_DEFAULT_OFF"
        ? "streams broker quotes only when opted in"
        : "streams broker quotes for its configured symbols only";
  return {
    eaVersion: reported,
    versionKey,
    quoteStream: known.quoteStream,
    note: `EA v${versionKey} ${verb} (${known.file}: ${known.note})`,
  };
}
