// MT5 Trade History Parser
//
// Parses MT5 export formats into a normalized ImportedTrade shape.
// Supports:
//   - MT5 CSV (Deals tab or Orders tab from History)
//   - MT5 HTML account statement
//   - Excel/XLSX (via pre-parsed rows passed in as arrays)
//
// SAFETY:
//   - Pure parsing functions. No I/O, no DB writes, no broker calls.
//   - Never returns execution-capable objects.
//   - All prices are stored as floats, never used to place orders.

export interface ParsedTrade {
  brokerDealId:    string | null;
  brokerOrderId:   string | null;
  magicNumber:     string | null;
  comment:         string | null;
  symbol:          string;
  side:            "BUY" | "SELL";
  orderType:       string | null;
  lotSize:         number;
  entryPrice:      number | null;
  exitPrice:       number | null;
  stopLoss:        number | null;
  takeProfit:      number | null;
  openedAt:        Date | null;
  closedAt:        Date | null;
  durationSeconds: number | null;
  grossPnl:        number | null;
  commission:      number | null;
  swap:            number | null;
  netPnl:          number | null;
  balanceAfter:    number | null;
  closeType:       "tp_hit" | "sl_hit" | "manual" | "partial" | "unknown" | null;
  flagReasons:     string[];
}

export interface ParseResult {
  ok:       boolean;
  trades:   ParsedTrade[];
  rejected: Array<{ row: number; reason: string }>;
  warnings: string[];
  errors:   string[];
  isLiveHint: boolean | null;   // detected from report header
  accountLabel: string | null;  // masked account ref if found
  brokerHint:  string | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function safeFloat(v: unknown): number | null {
  if (v === null || v === undefined || v === "" || v === "-") return null;
  const n = typeof v === "string" ? parseFloat(v.replace(/,/g, "").trim()) : Number(v);
  return isFinite(n) ? n : null;
}

function safeDate(v: unknown): Date | null {
  if (!v || v === "" || v === "-") return null;
  // MT5 format: "2024.03.15 09:32:45" or ISO or Excel serial
  let s = String(v).trim();
  // MT5 dot-date format
  s = s.replace(/^(\d{4})\.(\d{2})\.(\d{2})\s/, "$1-$2-$3 ");
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function normalizeSide(v: unknown): "BUY" | "SELL" | null {
  const s = String(v ?? "").toLowerCase().trim();
  if (s === "buy" || s === "in" || s === "long" || s === "0") return "BUY";
  if (s === "sell" || s === "out" || s === "short" || s === "1") return "SELL";
  return null;
}

function normalizeSymbol(v: unknown): string {
  return String(v ?? "").replace(/\s/g, "").toUpperCase().trim();
}

function detectCloseType(
  exitPrice: number | null,
  sl: number | null,
  tp: number | null,
  side: "BUY" | "SELL",
  comment: string | null,
): ParsedTrade["closeType"] {
  const c = (comment ?? "").toLowerCase();
  if (c.includes("tp") || c.includes("take profit")) return "tp_hit";
  if (c.includes("sl") || c.includes("stop loss")) return "sl_hit";
  if (exitPrice !== null && tp !== null && Math.abs(exitPrice - tp) < 0.00005) return "tp_hit";
  if (exitPrice !== null && sl !== null && Math.abs(exitPrice - sl) < 0.00005) return "sl_hit";
  if (c.includes("close") || c.includes("manual")) return "manual";
  return "unknown";
}

function calcDuration(open: Date | null, close: Date | null): number | null {
  if (!open || !close) return null;
  const d = Math.round((close.getTime() - open.getTime()) / 1000);
  return d > 0 ? d : null;
}

// ── MT5 CSV Parser ───────────────────────────────────────────────────────────
// Standard MT5 "History > Deals" CSV columns (order may vary):
// Time, Deal, Symbol, Type, Direction, Volume, Price, Order, Commission,
// Swap, Profit, Balance, Comment
//
// Also handles MT5 "Orders" history format.

export function parseMT5CSV(csvText: string): ParseResult {
  const result: ParseResult = {
    ok: false, trades: [], rejected: [], warnings: [], errors: [],
    isLiveHint: null, accountLabel: null, brokerHint: null,
  };

  const lines = csvText.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) {
    result.errors.push("File is empty or has no data rows.");
    return result;
  }

  // Detect account/broker from header lines (MT5 puts account info at top)
  for (const line of lines.slice(0, 5)) {
    if (/account/i.test(line)) {
      const m = line.match(/(\d{5,})/);
      if (m) result.accountLabel = `****${m[1].slice(-4)}`;
    }
    if (/demo/i.test(line)) result.isLiveHint = false;
    if (/real|live/i.test(line)) result.isLiveHint = true;
    if (/broker|company/i.test(line)) {
      const m = line.match(/[":,]\s*([A-Za-z][\w\s]{2,30})/);
      if (m) result.brokerHint = m[1].trim();
    }
  }

  // Find header row
  let headerRow = -1;
  let headers: string[] = [];
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    const cols = lines[i]!.split(/[,\t;]/).map((c) => c.replace(/"/g, "").trim().toLowerCase());
    if (cols.includes("symbol") && (cols.includes("volume") || cols.includes("lots"))) {
      headerRow = i;
      headers = cols;
      break;
    }
  }

  if (headerRow === -1) {
    result.errors.push("Could not find a valid header row. Expected columns: Symbol, Volume/Lots, Price, Type.");
    return result;
  }

  // Column index helpers
  const col = (names: string[]) => {
    for (const n of names) {
      const i = headers.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };

  const iSymbol     = col(["symbol"]);
  const iType       = col(["type", "direction", "action"]);
  const iVolume     = col(["volume", "lots", "size"]);
  const iPrice      = col(["price", "entry", "open price", "open_price"]);
  const iClosePrice = col(["close price", "close_price", "exit price", "exit_price"]);
  const iSL         = col(["s/l", "sl", "stop loss", "stoploss"]);
  const iTP         = col(["t/p", "tp", "take profit", "takeprofit"]);
  const iOpenTime   = col(["time", "open time", "open_time", "opentime", "open"]);
  const iCloseTime  = col(["close time", "close_time", "closetime", "close"]);
  const iProfit     = col(["profit", "p&l", "pnl"]);
  const iCommission = col(["commission", "comm"]);
  const iSwap       = col(["swap"]);
  const iBalance    = col(["balance"]);
  const iDeal       = col(["deal", "deal id", "ticket"]);
  const iOrder      = col(["order", "order id"]);
  const iMagic      = col(["magic", "magic number"]);
  const iComment    = col(["comment"]);

  if (iSymbol === -1 || iVolume === -1) {
    result.errors.push("Missing required columns: Symbol and Volume/Lots.");
    return result;
  }

  // Parse data rows
  for (let i = headerRow + 1; i < lines.length; i++) {
    const raw = lines[i]!;
    if (!raw.trim()) continue;

    // Split respecting quoted fields
    const cells = raw.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
      .map((c) => c.replace(/^"|"$/g, "").trim());

    const get = (idx: number) => (idx >= 0 && idx < cells.length ? cells[idx] : null);

    const symbolRaw = get(iSymbol);
    if (!symbolRaw || symbolRaw.toLowerCase() === "balance" || symbolRaw.toLowerCase() === "deposit") continue;

    const symbol = normalizeSymbol(symbolRaw);
    if (!symbol) {
      result.rejected.push({ row: i + 1, reason: "Empty symbol" });
      continue;
    }

    const sideRaw = get(iType);
    const side = normalizeSide(sideRaw);
    if (!side) {
      // Some MT5 CSVs have "buy", "sell", "balance", "credit" in type column
      // Skip non-trade rows silently
      continue;
    }

    const lotSize = safeFloat(get(iVolume));
    if (!lotSize || lotSize <= 0) {
      result.rejected.push({ row: i + 1, reason: `Invalid lot size: ${get(iVolume)}` });
      continue;
    }

    const entryPrice  = safeFloat(get(iPrice));
    const exitPrice   = safeFloat(get(iClosePrice));
    const sl          = safeFloat(get(iSL));
    const tp          = safeFloat(get(iTP));
    const openedAt    = safeDate(get(iOpenTime));
    const closedAt    = safeDate(get(iCloseTime));
    const grossPnl    = safeFloat(get(iProfit));
    const commission  = safeFloat(get(iCommission));
    const swap        = safeFloat(get(iSwap));
    const balanceAfter = safeFloat(get(iBalance));
    const comment     = get(iComment) || null;
    const brokerDealId = get(iDeal) || null;
    const brokerOrderId = get(iOrder) || null;
    const magicNumber  = get(iMagic) || null;

    const netPnl = grossPnl !== null
      ? grossPnl + (commission ?? 0) + (swap ?? 0)
      : null;

    const flagReasons: string[] = [];
    if (!sl) flagReasons.push("missing_sl");
    if (!tp) flagReasons.push("missing_tp");
    if (!openedAt) flagReasons.push("missing_open_time");
    if (!exitPrice && !closedAt) flagReasons.push("possibly_open_trade");
    if (grossPnl !== null && Math.abs(grossPnl) > 100000) flagReasons.push("suspicious_pnl");

    result.trades.push({
      brokerDealId,
      brokerOrderId,
      magicNumber,
      comment,
      symbol,
      side,
      orderType: "market",
      lotSize,
      entryPrice,
      exitPrice,
      stopLoss: sl,
      takeProfit: tp,
      openedAt,
      closedAt,
      durationSeconds: calcDuration(openedAt, closedAt),
      grossPnl,
      commission,
      swap,
      netPnl,
      balanceAfter,
      closeType: detectCloseType(exitPrice, sl, tp, side, comment),
      flagReasons,
    });
  }

  if (result.trades.length === 0) {
    result.errors.push("No valid trades found in the file.");
    return result;
  }

  if (result.trades.length < 10) {
    result.warnings.push(`Only ${result.trades.length} trades found. Small sample reduces analysis quality.`);
  }

  result.ok = true;
  return result;
}

// ── MT5 HTML Parser ──────────────────────────────────────────────────────────
// Parses the HTML account statement MT5 generates.
// The HTML contains a table with class "trades" or similar.
// We extract text content row by row.

export function parseMT5HTML(html: string): ParseResult {
  const result: ParseResult = {
    ok: false, trades: [], rejected: [], warnings: [], errors: [],
    isLiveHint: null, accountLabel: null, brokerHint: null,
  };

  // Detect account info from HTML meta/title
  if (/demo/i.test(html)) result.isLiveHint = false;
  if (/real account|live account/i.test(html)) result.isLiveHint = true;

  const accountMatch = html.match(/account[:\s]+(\d{5,})/i);
  if (accountMatch) result.accountLabel = `****${accountMatch[1].slice(-4)}`;

  const brokerMatch = html.match(/<title>([^<]{3,40})<\/title>/i);
  if (brokerMatch) result.brokerHint = brokerMatch[1].trim();

  // Extract table rows — strip all HTML tags to get plain cell text
  const tableMatch = html.match(/<table[^>]*>([\s\S]*?)<\/table>/gi);
  if (!tableMatch) {
    result.errors.push("No tables found in HTML file.");
    return result;
  }

  // Find the largest table (likely the trades table)
  let bestTable = "";
  for (const t of tableMatch) {
    if (t.length > bestTable.length) bestTable = t;
  }

  const stripTags = (s: string) =>
    s.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&#\d+;/g, "").trim();

  const rows = bestTable.match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi) ?? [];
  if (rows.length < 2) {
    result.errors.push("HTML table has no data rows.");
    return result;
  }

  // Extract cells from each row
  const parsedRows: string[][] = rows.map((row) => {
    const cells = row.match(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi) ?? [];
    return cells.map((c) => stripTags(c));
  });

  // Find header row
  let headerIdx = -1;
  let headers: string[] = [];
  for (let i = 0; i < Math.min(parsedRows.length, 5); i++) {
    const row = parsedRows[i]!.map((c) => c.toLowerCase());
    if (row.some((c) => c.includes("symbol")) && row.some((c) => c.includes("volume") || c.includes("lots"))) {
      headerIdx = i;
      headers = row;
      break;
    }
  }

  if (headerIdx === -1) {
    result.warnings.push("Could not detect column headers in HTML. Attempting positional parse.");
    // Fall back: pass as CSV-like
    const csvLike = parsedRows.map((r) => r.join(",")).join("\n");
    return parseMT5CSV(csvLike);
  }

  // Re-use CSV parser logic with detected headers
  const csvText = [
    headers.join(","),
    ...parsedRows.slice(headerIdx + 1).map((r) => r.map((c) => `"${c}"`).join(",")),
  ].join("\n");

  const csvResult = parseMT5CSV(csvText);
  return {
    ...csvResult,
    isLiveHint: result.isLiveHint ?? csvResult.isLiveHint,
    accountLabel: result.accountLabel ?? csvResult.accountLabel,
    brokerHint: result.brokerHint ?? csvResult.brokerHint,
  };
}

// ── Excel/XLSX Row Parser ────────────────────────────────────────────────────
// Accepts pre-parsed rows (from a XLSX reader like SheetJS on the frontend,
// or from the server-side xlsx library).
// Each row is an array of cell values (string | number | Date | null).

export function parseMT5ExcelRows(rows: Array<Array<unknown>>): ParseResult {
  if (!rows || rows.length < 2) {
    return {
      ok: false, trades: [], rejected: [],
      warnings: [], errors: ["Excel file is empty or has no data rows."],
      isLiveHint: null, accountLabel: null, brokerHint: null,
    };
  }
  // Convert to CSV-like strings and reuse CSV parser
  const csvLines = rows.map((row) =>
    row.map((cell) => {
      if (cell instanceof Date) return cell.toISOString();
      if (cell === null || cell === undefined) return "";
      return `"${String(cell).replace(/"/g, '""')}"`;
    }).join(",")
  );
  return parseMT5CSV(csvLines.join("\n"));
}

// ── Data Quality Scorer ──────────────────────────────────────────────────────
import type { TradeImportDataQuality } from "@workspace/db/schema";

export function scoreDataQuality(
  result: ParseResult,
  trustLevel: "HIGH" | "MEDIUM" | "LOW",
): TradeImportDataQuality {
  const trades = result.trades;
  const total = trades.length + result.rejected.length;

  const missingSL = trades.filter((t) => t.flagReasons.includes("missing_sl")).length;
  const missingTP = trades.filter((t) => t.flagReasons.includes("missing_tp")).length;
  const missingTs = trades.filter((t) => t.flagReasons.includes("missing_open_time")).length;
  const missingExit = trades.filter((t) => t.flagReasons.includes("possibly_open_trade")).length;
  const suspicious = trades.filter((t) => t.flagReasons.includes("suspicious_pnl")).length;

  // Check for duplicates by deal ID
  const dealIds = trades.map((t) => t.brokerDealId).filter(Boolean);
  const dupCount = dealIds.length - new Set(dealIds).size;

  // Score calculation
  let score = 100;
  if (missingSL > 0) score -= Math.min(20, (missingSL / Math.max(1, trades.length)) * 30);
  if (missingTP > 0) score -= Math.min(15, (missingTP / Math.max(1, trades.length)) * 20);
  if (missingTs > 0) score -= Math.min(20, (missingTs / Math.max(1, trades.length)) * 25);
  if (dupCount > 0) score -= Math.min(15, dupCount * 3);
  if (suspicious > 0) score -= Math.min(20, suspicious * 5);
  if (result.rejected.length > 0) score -= Math.min(15, (result.rejected.length / Math.max(1, total)) * 20);
  if (trustLevel === "LOW") score -= 10;
  if (trustLevel === "MEDIUM") score -= 5;
  score = Math.max(0, Math.round(score));

  const status: TradeImportDataQuality["status"] =
    score >= 80 ? "GOOD" :
    score >= 60 ? "ACCEPTABLE" :
    score >= 40 ? "DEGRADED" : "POOR";

  const warnings: string[] = [...result.warnings];
  if (missingSL > trades.length * 0.5) warnings.push(`${missingSL} trades are missing stop loss.`);
  if (missingTP > trades.length * 0.5) warnings.push(`${missingTP} trades are missing take profit.`);
  if (dupCount > 0) warnings.push(`${dupCount} possible duplicate deals detected.`);
  if (suspicious > 0) warnings.push(`${suspicious} trades have unusually large P/L — verify data.`);

  return {
    status,
    score,
    totalRows: total,
    validRows: trades.length,
    duplicates: dupCount,
    missingSL,
    missingTP,
    missingTimestamps: missingTs,
    missingExitPrice: missingExit,
    suspiciousResults: suspicious,
    brokerTimezoneIssue: false, // detected separately if needed
    tooFewTrades: trades.length < 10,
    demoOnly: result.isLiveHint === false,
    warnings,
    errors: result.errors,
  };
}

// ── Trust level from source ──────────────────────────────────────────────────
export function trustLevelFromSource(
  source: string,
): "HIGH" | "MEDIUM" | "LOW" {
  switch (source) {
    case "DERIV_API":
    case "BROKER_API":
      return "HIGH";
    case "MT5_CSV":
    case "MT5_EXCEL":
      return "MEDIUM";
    case "MT5_HTML":
    case "MANUAL":
    default:
      return "LOW";
  }
}
