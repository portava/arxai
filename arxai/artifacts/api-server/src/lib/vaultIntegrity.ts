// ═══════════════════════════════════════════════════════════════════════════
// Vault Integrity Scanner — flags missing, malformed, or suspicious vault
// rows BEFORE the AI consumes them as memory.
//
// Categories (mirror dataIntegrity.engine vocabulary where possible):
//   • MISSING_REFERENCE          — required field empty / null
//   • NEGATIVE_OR_INVALID_VALUE  — severity / truthDomain outside vocabulary
//   • TIME_PARADOX               — generatedAtIso > createdAt (skew > 60s)
//                                   or generatedAtIso > now + 60s
//   • DANGLING_REPLAY            — linkedTradeId/linkedSignalId references no
//                                   row in the referenced trade book
//   • DUPLICATE_ID               — exact (kind, summary, generatedAtIso) seen
//                                   more than once within the scan window
//   • STALE_OR_FROZEN_DATA       — > N events share the same generatedAtIso
// ═══════════════════════════════════════════════════════════════════════════

import { db, vaultEventsTable, tradesTable, paperOrdersTable, type VaultEventRow } from "@workspace/db";
import { desc, gte, inArray } from "drizzle-orm";

export type IntegritySeverity = "INFO" | "WARN" | "CRITICAL";

export interface IntegrityFlag {
  flagId: string;
  recordRef: string;
  category:
    | "MISSING_REFERENCE"
    | "NEGATIVE_OR_INVALID_VALUE"
    | "TIME_PARADOX"
    | "DANGLING_REPLAY"
    | "DUPLICATE_ID"
    | "STALE_OR_FROZEN_DATA";
  severity: IntegritySeverity;
  description: string;
  reasons: string[];
}

const ALLOWED_SEVERITY = new Set(["INFO", "WARN", "DANGER", "CRITICAL"]);
const ALLOWED_TRUTH_DOMAIN = new Set([
  "SAFETY", "MARKET", "DECISION", "EXECUTION", "BEHAVIOR", "OUTCOME",
]);
const ALLOWED_SOURCE = new Set([
  "CONTROL_TOWER", "RISK_GOVERNOR", "KILL_SWITCH", "RESILIENCE",
  "USER", "MT5", "STRATEGY", "EXECUTION", "VAULT",
  // Legacy Phase 1 source — accepted but exempt from new-row vocab requirement.
  "SAFETY_CORE",
]);
// Kinds the Phase 2 taxonomy mandates a truthDomain for. Phase 1 emits are
// allowed to omit truthDomain to keep backward compatibility.
const REQUIRES_TRUTH_DOMAIN = new Set([
  "APPROVED_TRADE", "BLOCKED_TRADE", "REJECTED_TRADE", "PAPER_TRADE",
  "SIMULATED_TRADE", "RISK_DECISION", "RECOVERY_EVENT", "MT5_DISCONNECT",
  "LATENCY_SPIKE", "SPREAD_CHANGE", "USER_OVERRIDE",
]);
const FROZEN_GROUP_THRESHOLD = 8;
const TIME_SKEW_TOLERANCE_MS = 60_000;

export interface VaultIntegrityReport {
  scannedRows: number;
  flagCount: number;
  criticalCount: number;
  byCategory: Record<string, number>;
  flags: IntegrityFlag[];
  reasons: string[];
}

function referencePayload(row: VaultEventRow): Record<string, unknown> {
  return row.payload != null && typeof row.payload === "object" && !Array.isArray(row.payload)
    ? row.payload as Record<string, unknown> : {};
}

// Both books use PostgreSQL int4 IDs. Malformed or out-of-range references
// must be reported as missing rather than breaking the scanner's SQL cast.
function referencedIds(rows: VaultEventRow[], paper: boolean): number[] {
  return [...new Set(rows.filter(row => (referencePayload(row).entityType === "paper_order") === paper)
    .map(row => row.linkedTradeId)
    .filter((id): id is string => id != null && /^[1-9]\d*$/.test(id))
    .map(Number).filter(id => Number.isSafeInteger(id) && id <= 2_147_483_647))];
}

export async function scanVaultIntegrity(opts: { limit?: number; sinceIso?: string } = {}): Promise<VaultIntegrityReport> {
  const lim = Math.min(2000, Math.max(1, opts.limit ?? 500));
  const rows = opts.sinceIso
    ? await db.select().from(vaultEventsTable)
        .where(gte(vaultEventsTable.createdAt, new Date(opts.sinceIso)))
        .orderBy(desc(vaultEventsTable.createdAt))
        .limit(lim)
    : await db.select().from(vaultEventsTable)
        .orderBy(desc(vaultEventsTable.createdAt))
        .limit(lim);

  const flags: IntegrityFlag[] = [];
  const reasons: string[] = [];
  let counter = 0;
  const newId = () => `vif_${Date.now()}_${counter++}`;

  // ── per-row checks ─────────────────────────────────────────────────────
  const now = Date.now();
  const seenKey = new Map<string, number>();
  const isoCounts = new Map<string, number>();

  // Fetch only IDs referenced by this bounded vault window, from the correct
  // book. A legacy trade with the same numeric ID cannot validate a paper row.
  const legacyRefs = referencedIds(rows, false);
  const paperRefs = referencedIds(rows, true);
  const tradeRows = legacyRefs.length
    ? await db.select({ id: tradesTable.id }).from(tradesTable).where(inArray(tradesTable.id, legacyRefs)) : [];
  const paperRows = paperRefs.length
    ? await db.select({ id: paperOrdersTable.id, userId: paperOrdersTable.userId }).from(paperOrdersTable)
        .where(inArray(paperOrdersTable.id, paperRefs)) : [];
  const tradeIds = new Set(tradeRows.map((r) => String(r.id)));
  const paperOwners = new Map(paperRows.map(row => [String(row.id), row.userId]));

  for (const r of rows) {
    const ref = `vault:${r.id}`;
    if (!r.kind)               flags.push(mk(newId(), ref, "MISSING_REFERENCE", "CRITICAL", `vault row ${r.id} has empty kind`, []));
    if (!r.source)             flags.push(mk(newId(), ref, "MISSING_REFERENCE", "CRITICAL", `vault row ${r.id} has empty source`, []));
    if (!r.summary)            flags.push(mk(newId(), ref, "MISSING_REFERENCE", "WARN", `vault row ${r.id} has empty summary`, []));
    if (!r.generatedAtIso)     flags.push(mk(newId(), ref, "MISSING_REFERENCE", "CRITICAL", `vault row ${r.id} has empty generatedAtIso`, []));

    if (r.severity && !ALLOWED_SEVERITY.has(r.severity)) {
      flags.push(mk(newId(), ref, "NEGATIVE_OR_INVALID_VALUE", "CRITICAL",
        `vault row ${r.id} has invalid severity '${r.severity}'`,
        [`allowed=${[...ALLOWED_SEVERITY].join("|")}`]));
    }
    if (r.truthDomain && !ALLOWED_TRUTH_DOMAIN.has(r.truthDomain)) {
      flags.push(mk(newId(), ref, "NEGATIVE_OR_INVALID_VALUE", "WARN",
        `vault row ${r.id} has invalid truthDomain '${r.truthDomain}'`,
        [`allowed=${[...ALLOWED_TRUTH_DOMAIN].join("|")}`]));
    }
    if (r.kind && REQUIRES_TRUTH_DOMAIN.has(r.kind) && !r.truthDomain) {
      flags.push(mk(newId(), ref, "MISSING_REFERENCE", "WARN",
        `vault row ${r.id} (${r.kind}) is missing required truthDomain`, []));
    }
    if (r.source && !ALLOWED_SOURCE.has(r.source)) {
      flags.push(mk(newId(), ref, "NEGATIVE_OR_INVALID_VALUE", "WARN",
        `vault row ${r.id} has unrecognized source '${r.source}'`,
        [`allowed=${[...ALLOWED_SOURCE].join("|")}`]));
    }

    // ── time paradox: generatedAtIso > createdAt + skew, or in the future ─
    if (r.generatedAtIso) {
      const genMs = Date.parse(r.generatedAtIso);
      if (Number.isNaN(genMs)) {
        flags.push(mk(newId(), ref, "NEGATIVE_OR_INVALID_VALUE", "CRITICAL",
          `vault row ${r.id} has unparseable generatedAtIso '${r.generatedAtIso}'`, []));
      } else {
        if (genMs > now + TIME_SKEW_TOLERANCE_MS) {
          flags.push(mk(newId(), ref, "TIME_PARADOX", "CRITICAL",
            `vault row ${r.id} generatedAtIso is in the future (${r.generatedAtIso})`,
            [`skewMs=${genMs - now}`]));
        }
        if (r.createdAt) {
          const skew = genMs - r.createdAt.getTime();
          if (skew > TIME_SKEW_TOLERANCE_MS) {
            flags.push(mk(newId(), ref, "TIME_PARADOX", "WARN",
              `vault row ${r.id} generatedAtIso is ${Math.round(skew/1000)}s after createdAt`,
              [`generatedAtIso=${r.generatedAtIso}`, `createdAt=${r.createdAt.toISOString()}`]));
          }
        }
      }
      isoCounts.set(r.generatedAtIso, (isoCounts.get(r.generatedAtIso) ?? 0) + 1);
    }

    // ── dangling reference for linked trade IDs ─────────────────────────
    if (r.linkedTradeId) {
      const payload = referencePayload(r);
      if (payload.entityType === "paper_order") {
        const exists = paperOwners.has(r.linkedTradeId);
        // Explicit null owners are supported for legacy simulator rows. A
        // missing owner is not proof of an ownerless order.
        const ownerMatches = Object.hasOwn(payload, "userId")
          && payload.userId === paperOwners.get(r.linkedTradeId);
        if (!exists || !ownerMatches) flags.push(mk(newId(), ref, "DANGLING_REPLAY", "WARN",
          `vault row ${r.id} references ${!exists ? "unknown" : "differently owned"} paper order '${r.linkedTradeId}'`,
          [`entityType=paper_order`, `linkedTradeId=${r.linkedTradeId}`, !exists ? "paper order missing" : "paper order owner does not match vault evidence"]));
      } else if (!tradeIds.has(r.linkedTradeId)) {
        flags.push(mk(newId(), ref, "DANGLING_REPLAY", "WARN",
          `vault row ${r.id} references unknown trade '${r.linkedTradeId}'`,
          [`linkedTradeId=${r.linkedTradeId}`]));
      }
    }

    // ── duplicate-id detector (rows with identical kind+summary+iso) ────
    const k = `${r.kind}::${r.summary}::${r.generatedAtIso}`;
    seenKey.set(k, (seenKey.get(k) ?? 0) + 1);
  }

  for (const [key, n] of seenKey) {
    if (n > 1) {
      flags.push(mk(newId(), `vault:dup:${key.slice(0, 80)}`, "DUPLICATE_ID", "WARN",
        `${n} vault rows share identical (kind, summary, generatedAtIso)`,
        [`count=${n}`]));
    }
  }

  for (const [iso, n] of isoCounts) {
    if (n >= FROZEN_GROUP_THRESHOLD) {
      flags.push(mk(newId(), `vault:frozen:${iso}`, "STALE_OR_FROZEN_DATA", "WARN",
        `${n} vault rows share generatedAtIso ${iso} — possible frozen clock`,
        [`count=${n}`, `threshold=${FROZEN_GROUP_THRESHOLD}`]));
    }
  }

  const byCategory: Record<string, number> = {};
  let criticalCount = 0;
  for (const f of flags) {
    byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;
    if (f.severity === "CRITICAL") criticalCount += 1;
  }
  reasons.push(`scanned ${rows.length} vault rows in window — ${flags.length} flag(s), ${criticalCount} critical`);

  return {
    scannedRows: rows.length,
    flagCount: flags.length,
    criticalCount,
    byCategory,
    flags,
    reasons,
  };
}

function mk(
  flagId: string, recordRef: string,
  category: IntegrityFlag["category"], severity: IntegritySeverity,
  description: string, reasons: string[],
): IntegrityFlag {
  return { flagId, recordRef, category, severity, description, reasons };
}

// expose row type for callers that want to feed pre-loaded rows in tests
export type { VaultEventRow };
