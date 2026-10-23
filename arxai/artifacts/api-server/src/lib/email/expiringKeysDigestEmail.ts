// Expiring-registration-keys admin digest — ARX AI branded transactional mail.
// The rendered body is built by the PURE domain builder
// (`@workspace/domain/email` buildExpiringKeysDigestEmail) so it can be
// regression-tested for raw-key leakage without sending; this file only adds the
// Resend transport (see ./resend.ts).

import {
  buildExpiringKeysDigestEmail,
  type ExpiringKeyDigestItem,
} from "@workspace/domain/email";
import { sendEmail } from "./resend.js";

export interface ExpiringKeysDigestEmailInput {
  to: string;
  items: ExpiringKeyDigestItem[];
  windowDays: number;
  manageLink: string;
}

export async function sendExpiringKeysDigestEmail(
  input: ExpiringKeysDigestEmailInput,
): Promise<{ id: string }> {
  const { subject, html, text } = buildExpiringKeysDigestEmail({
    items: input.items,
    windowDays: input.windowDays,
    manageLink: input.manageLink,
  });
  return sendEmail({ to: input.to, subject, html, text });
}
