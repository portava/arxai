// Password-reset email — ARX AI branded transactional message.
// The rendered body is built by the PURE domain builder
// (`@workspace/domain/email` buildPasswordResetEmail) so it can be regression-
// tested for secret leakage without sending; this file only adds the Resend
// transport (see ./resend.ts). The link is always built from trusted config
// (never request headers — see auth.ts resolvePublicOrigin).

import { buildPasswordResetEmail } from "@workspace/domain/email";
import { sendEmail } from "./resend.js";

export interface PasswordResetEmailInput {
  to: string;
  resetLink: string;
  expiresAt: Date;
}

export async function sendPasswordResetEmail(
  input: PasswordResetEmailInput,
): Promise<{ id: string }> {
  const { subject, html, text } = buildPasswordResetEmail({
    resetLink: input.resetLink,
    expiresAt: input.expiresAt,
  });
  return sendEmail({ to: input.to, subject, html, text });
}
