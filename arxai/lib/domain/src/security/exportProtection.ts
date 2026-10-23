// ═══════════════════════════════════════════════════════════════════════════
// security/exportProtection.ts — pure export-envelope metadata + canonical
// serialization for backup/export protection.
//
// Deterministic, no IO and no crypto. The api-server supplies a crypto exportId
// + createdAt and computes the sha256 over `canonicalExportPayload(meta)`; this
// module only shapes the trustworthy, redaction-aware metadata envelope.
//
// SAFETY: raw broker payloads are ALWAYS excluded; internal formulas are only
// marked included for an admin export. Non-admin exports never advertise
// internal-formula inclusion.
// ═══════════════════════════════════════════════════════════════════════════

export interface ExportEnvelopeInput {
  exportType: string;
  requestedBy: string;
  requestedByRole?: string | null;
  dateRangeStart?: string | null;
  dateRangeEnd?: string | null;
  /** Redaction status reported by the redaction layer. */
  redactionStatus: string;
  redactedKeys: string[];
  recordCount?: number;
  /** True only for an admin-authorized export (may include internal formulas). */
  adminExport: boolean;
}

export interface ExportEnvelopeMeta {
  exportId: string;
  exportType: string;
  requestedBy: string;
  requestedByRole: string | null;
  createdAt: string;
  dateRange: { start: string | null; end: string | null } | null;
  redactionStatus: string;
  redactedKeys: string[];
  recordCount: number | null;
  internalFormulasIncluded: boolean;
  /** Always true — raw broker payloads never leave the system in an export. */
  rawBrokerPayloadExcluded: true;
  signatureAlgorithm: "sha256";
}

export function buildExportEnvelopeMeta(
  input: ExportEnvelopeInput,
  exportId: string,
  createdAt: string,
): ExportEnvelopeMeta {
  const hasRange = input.dateRangeStart != null || input.dateRangeEnd != null;
  return {
    exportId,
    exportType: input.exportType,
    requestedBy: input.requestedBy,
    requestedByRole: input.requestedByRole ?? null,
    createdAt,
    dateRange: hasRange ? { start: input.dateRangeStart ?? null, end: input.dateRangeEnd ?? null } : null,
    redactionStatus: input.redactionStatus,
    redactedKeys: [...input.redactedKeys].sort(),
    recordCount: typeof input.recordCount === "number" ? input.recordCount : null,
    internalFormulasIncluded: input.adminExport === true,
    rawBrokerPayloadExcluded: true,
    signatureAlgorithm: "sha256",
  };
}

/**
 * Stable, key-sorted JSON of the envelope for deterministic hashing. The same
 * metadata always serialises to the same string regardless of key insertion
 * order, so the server-computed sha256 is reproducible and verifiable.
 */
export function canonicalExportPayload(meta: ExportEnvelopeMeta): string {
  const ordered = {
    createdAt: meta.createdAt,
    dateRange: meta.dateRange,
    exportId: meta.exportId,
    exportType: meta.exportType,
    internalFormulasIncluded: meta.internalFormulasIncluded,
    rawBrokerPayloadExcluded: meta.rawBrokerPayloadExcluded,
    recordCount: meta.recordCount,
    redactedKeys: meta.redactedKeys,
    redactionStatus: meta.redactionStatus,
    requestedBy: meta.requestedBy,
    requestedByRole: meta.requestedByRole,
    signatureAlgorithm: meta.signatureAlgorithm,
  };
  return JSON.stringify(ordered);
}
