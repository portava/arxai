// Password-reset email body builder — PURE, no IO.
//
// Lives in the domain lib so the exact rendered body can be unit/regression
// tested for secret leakage (see scripts security regression suite) without
// sending anything. The api-server's sendPasswordResetEmail() consumes this and
// hands the result to the Resend transport. The ONLY dynamic, secret-bearing
// field interpolated here is `resetLink` (which carries the one-time reset token
// by design); nothing else secret is ever templated in. Keep the wording in
// sync with the reset-password page; the link is always built from trusted
// config (never request headers — see api-server auth.ts resolvePublicOrigin).

const BRAND = "ARX AI";

function formatExpiry(expiresAt: Date, now: Date): string {
  const minutes = Math.max(1, Math.round((expiresAt.getTime() - now.getTime()) / 60000));
  if (minutes < 90) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

export interface PasswordResetEmailContentInput {
  resetLink: string;
  expiresAt: Date;
  /** Injectable clock for deterministic expiry rendering in tests. */
  now?: Date;
}

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

/** Build the password-reset email subject/html/text. Pure and deterministic. */
export function buildPasswordResetEmail(
  input: PasswordResetEmailContentInput,
): EmailContent {
  const expiry = formatExpiry(input.expiresAt, input.now ?? new Date());
  const subject = `Reset your ${BRAND} password`;

  const text = [
    `Reset your ${BRAND} password`,
    "",
    "We received a request to reset the password for your account.",
    "Open the link below to choose a new password:",
    "",
    input.resetLink,
    "",
    `This link expires in ${expiry} and can only be used once.`,
    "If you didn't request this, you can safely ignore this email — your password won't change.",
  ].join("\n");

  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#0b0f17;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b0f17;padding:32px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#111827;border:1px solid #1f2937;border-radius:14px;overflow:hidden;">
            <tr>
              <td style="padding:28px 32px 8px 32px;">
                <div style="font-size:13px;letter-spacing:2px;color:#22d3ee;font-weight:700;">${BRAND}</div>
                <h1 style="margin:14px 0 0 0;font-size:22px;line-height:1.3;color:#f9fafb;font-weight:700;">Reset your password</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 32px 0 32px;">
                <p style="margin:16px 0 0 0;font-size:15px;line-height:1.6;color:#cbd5e1;">
                  We received a request to reset the password for your account. Click the button below to choose a new password.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:28px 32px;">
                <a href="${input.resetLink}" style="display:inline-block;background:#22d3ee;color:#0b0f17;text-decoration:none;font-weight:700;font-size:15px;padding:13px 26px;border-radius:10px;">Reset password</a>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px;">
                <p style="margin:0;font-size:13px;line-height:1.6;color:#94a3b8;">
                  This link expires in <strong style="color:#e2e8f0;">${expiry}</strong> and can only be used once.
                </p>
                <p style="margin:14px 0 0 0;font-size:13px;line-height:1.6;color:#94a3b8;">
                  If the button doesn't work, copy and paste this link into your browser:
                </p>
                <p style="margin:8px 0 0 0;font-size:12px;line-height:1.5;word-break:break-all;color:#64748b;">
                  ${input.resetLink}
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 32px 28px 32px;border-top:1px solid #1f2937;margin-top:16px;">
                <p style="margin:16px 0 0 0;font-size:12px;line-height:1.6;color:#64748b;">
                  If you didn't request a password reset, you can safely ignore this email — your password won't change.
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
