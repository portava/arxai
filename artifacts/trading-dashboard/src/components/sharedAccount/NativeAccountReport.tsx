import type { MasterMt5Snapshot } from "@workspace/api-client-react";
import { useMasterAccountEvidence } from "@/hooks/useMasterAccountEvidence";

type Report = NonNullable<MasterMt5Snapshot["nativeAccountReport"]>;
const fields = [
  ["balance", "Balance"], ["equity", "Equity"], ["profit", "Account P/L"],
  ["credit", "Credit"], ["margin", "Used margin"], ["freeMargin", "Free margin"],
] as const;

/** Preserve terminal display precision without converting money to a JS number. */
export function nativeAccountMoney(value: unknown, currency: unknown, digits: unknown): string | null {
  if (typeof value !== "string" || value.length > 48 || typeof currency !== "string"
    || currency.length < 1 || currency.length > 8 || currency.trim().length === 0 || /[\x00-\x1F\x7F]/.test(currency)
    || typeof digits !== "number" || !Number.isInteger(digits) || digits < 0 || digits > 16) return null;
  const pattern = new RegExp(`^-?(?:0|[1-9]\\d*)${digits ? `\\.\\d{${digits}}` : ""}$`);
  if (!pattern.test(value) || /^-0(?:\.0+)?$/.test(value)) return null;
  const [whole, fraction] = value.split(".");
  return `${currency} ${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${fraction === undefined ? "" : `.${fraction}`}`;
}

const canonicalTime = (value: unknown): number => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return NaN;
  const stamp = Date.parse(value);
  return Number.isFinite(stamp) && new Date(stamp).toISOString() === value ? stamp : NaN;
};

const unavailableReason: Record<string, string> = {
  ACCOUNT_BINDING_MISMATCH: "The report does not match the selected broker account.",
  ACCOUNT_SCOPE_MISMATCH: "The report belongs to a different account connection.",
  ACCOUNT_REPORT_REJECTED: "The latest account report was rejected.",
  ACCOUNT_SEQUENCE_UNVERIFIED: "The order of account reports could not be verified.",
  CAPTURE_TIME_INVALID: "The report's observation time could not be verified.",
  RECEIPT_TIME_INVALID: "The report's arrival time could not be verified.",
  TERMINAL_DISCONNECTED: "The terminal reported that it was disconnected.",
  LEGACY_ACCOUNT_REPORT_UNVERIFIED: "This bridge has not supplied the complete native account report.",
};

/** Same read-only report in both owner surfaces. No second fetch or money engine. */
export function NativeAccountReport({ report, failed = false }: { report: Report | null; failed?: boolean }) {
  const evidence = useMasterAccountEvidence(report ? {
    lastMt5SnapshotAt: report.observedAt, snapshotAgeMs: report.observationAgeMs,
    snapshotStatus: "FRESH", syncStatus: "LIVE",
  } : null, failed);
  const receivedAt = canonicalTime(report?.receivedAt);
  const observedAt = canonicalTime(report?.observedAt);
  const values = fields.map(([key]) => nativeAccountMoney(report?.amounts?.[key], report?.currency, report?.currencyDigits));
  const valid = !failed && report?.status === "reported" && report.currentVerified === false
    && Number.isFinite(observedAt) && evidence.observedAtMs != null && evidence.ageMs != null && Number.isFinite(receivedAt)
    && receivedAt >= evidence.observedAtMs && receivedAt <= Date.now()
    && values.every(value => value !== null) && !report.amounts?.margin.startsWith("-");
  return <div data-testid="native-account-report">
    <p className="mb-2 text-xs text-warning">
      {valid ? "MT5-reported amounts — current state unverified." : "Complete MT5 account report unavailable."}
    </p>
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {fields.map(([key, label], index) => <div key={key} className="min-w-0">
        <p className="text-xs text-txt-muted">{label}</p>
        <p className="break-words font-mono text-sm text-foreground" data-testid={`native-money-${key}`}>{valid ? values[index] : "—"}</p>
      </div>)}
    </div>
    {valid && <div className="mt-2 text-xs text-txt-muted">
      <p>Terminal-reported observation: {report.observedAt}. Received by ARX: {report.receivedAt}.</p>
      <p>{evidence.freshness === "stale" ? "Stale report. " : ""}Terminal clock and report ordering are not verified. These figures describe the whole broker account.</p>
    </div>}
    {!valid && <p className="mt-2 text-xs text-txt-muted">{failed ? "The latest account refresh failed." : unavailableReason[report?.reason ?? ""] ?? "Waiting for a complete report matched to this account."} No older stored balance is substituted.</p>}
  </div>;
}
