// Expiring-registration-keys admin digest email body builder — PURE, no IO.
//
// Lives in the domain lib so the exact rendered body can be unit/regression
// tested for raw-key leakage (see scripts security regression suite) without
// sending anything. The api-server's sendExpiringKeysDigestEmail() consumes this
// and hands the result to the Resend transport.
//
// HONESTY / SAFETY:
//   * The raw registration key is NEVER available to this builder — callers pass
//     the already-masked display value (e.g. "ARX-9K4M-****"). This builder only
//     renders what it is given; it cannot reconstruct or leak a raw key.
//   * Deterministic + side-effect free so the body is fully regression-testable.

import type { EmailContent } from "./passwordResetEmail.js";

const BRAND = "ARX AI";

export interface ExpiringKeyDigestItem {
  /** Masked key for display, e.g. "ARX-9K4M-****". Never the raw key. */
  maskedKey: string;
  /** Whole days until expiry (0 = expires today). */
  daysLeft: number;
  /** Assigned email for the key, or null for email-optional keys. */
  assignedEmail: string | null;
  /** Role the key grants at signup (USER/INVESTOR/ADMIN), or null. */
  roleGrant: string | null;
  /** ISO-8601 expiry timestamp for the precise expiry instant. */
  expiresAtIso: string;
}

export interface ExpiringKeysDigestContentInput {
  items: ExpiringKeyDigestItem[];
  /** The look-ahead window (in days) used to collect these keys. */
  windowDays: number;
  /** Frontend link admins open to manage keys (always trusted config). */
  manageLink: string;
}

function daysLeftLabel(daysLeft: number): string {
  if (daysLeft <= 0) return "expires today";
  return `${daysLeft} day${daysLeft === 1 ? "" : "s"} left`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Build the expiring-keys admin digest subject/html/text. Pure and
 * deterministic. The caller guarantees `items` is non-empty (no email is built
 * or sent when nothing is expiring — see the worker's no-noise rule).
 */
export function buildExpiringKeysDigestEmail(
  input: ExpiringKeysDigestContentInput,
): EmailContent {
  const count = input.items.length;
  const subject = `${BRAND}: ${count} registration key${count === 1 ? "" : "s"} expiring within ${input.windowDays} day${input.windowDays === 1 ? "" : "s"}`;

  // ── Plain-text body ──────────────────────────────────────────────────────
  const textLines: string[] = [
    `${BRAND} — registration keys expiring soon`,
    "",
    `${count} PENDING registration key${count === 1 ? "" : "s"} ${count === 1 ? "is" : "are"} set to expire within the next ${input.windowDays} day${input.windowDays === 1 ? "" : "s"}.`,
    "Extend or revoke them before they lapse:",
    "",
  ];
  for (const item of input.items) {
    const parts = [
      item.maskedKey,
      daysLeftLabel(item.daysLeft),
      `expires ${item.expiresAtIso}`,
    ];
    if (item.roleGrant) parts.push(`grants ${item.roleGrant}`);
    if (item.assignedEmail) parts.push(`assigned to ${item.assignedEmail}`);
    textLines.push(`• ${parts.join(" · ")}`);
  }
  textLines.push("", `Manage keys: ${input.manageLink}`);
  const text = textLines.join("\n");

  // ── HTML body ────────────────────────────────────────────────────────────
  const rows = input.items
    .map((item) => {
      const role = item.roleGrant ? escapeHtml(item.roleGrant) : "—";
      const assigned = item.assignedEmail ? escapeHtml(item.assignedEmail) : "—";
      const urgent = item.daysLeft <= 1;
      const daysColor = urgent ? "#f87171" : "#e2e8f0";
      return `              <tr>
                <td style="padding:10px 12px;border-bottom:1px solid #1f2937;font-size:13px;color:#f9fafb;font-family:ui-monospace,Menlo,Consolas,monospace;">${escapeHtml(item.maskedKey)}</td>
                <td style="padding:10px 12px;border-bottom:1px solid #1f2937;font-size:13px;color:${daysColor};font-weight:700;white-space:nowrap;">${escapeHtml(daysLeftLabel(item.daysLeft))}</td>
                <td style="padding:10px 12px;border-bottom:1px solid #1f2937;font-size:13px;color:#94a3b8;">${role}</td>
                <td style="padding:10px 12px;border-bottom:1px solid #1f2937;font-size:13px;color:#94a3b8;">${assigned}</td>
              </tr>`;
    })
    .join("\n");

  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#0b0f17;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b0f17;padding:32px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#111827;border:1px solid #1f2937;border-radius:14px;overflow:hidden;">
            <tr>
              <td style="padding:28px 32px 8px 32px;">
                <div style="font-size:13px;letter-spacing:2px;color:#22d3ee;font-weight:700;">${BRAND}</div>
                <h1 style="margin:14px 0 0 0;font-size:22px;line-height:1.3;color:#f9fafb;font-weight:700;">Registration keys expiring soon</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 32px 0 32px;">
                <p style="margin:16px 0 0 0;font-size:15px;line-height:1.6;color:#cbd5e1;">
                  ${count} PENDING registration key${count === 1 ? "" : "s"} ${count === 1 ? "is" : "are"} set to expire within the next <strong style="color:#e2e8f0;">${input.windowDays} day${input.windowDays === 1 ? "" : "s"}</strong>. Extend or revoke them before they lapse.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px 0 32px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #1f2937;border-radius:10px;overflow:hidden;">
                  <thead>
                    <tr style="background:#0b0f17;">
                      <th align="left" style="padding:10px 12px;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#64748b;">Key</th>
                      <th align="left" style="padding:10px 12px;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#64748b;">Expiry</th>
                      <th align="left" style="padding:10px 12px;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#64748b;">Grants</th>
                      <th align="left" style="padding:10px 12px;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#64748b;">Assigned</th>
                    </tr>
                  </thead>
                  <tbody>
${rows}
                  </tbody>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 32px;">
                <a href="${input.manageLink}" style="display:inline-block;background:#22d3ee;color:#0b0f17;text-decoration:none;font-weight:700;font-size:15px;padding:13px 26px;border-radius:10px;">Manage registration keys</a>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 28px 32px;border-top:1px solid #1f2937;">
                <p style="margin:16px 0 0 0;font-size:12px;line-height:1.6;color:#64748b;">
                  This is an automated heads-up. Keys are shown masked — the full key is never re-served. You're receiving this because you are an ${BRAND} admin.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { subject, html, text };
}
