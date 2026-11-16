// ═══════════════════════════════════════════════════════════════════════════
// Notification Intensity
//
// Recommends how loudly the system should alert the trader. At low
// severity we whisper; at high severity we surface persistent banners
// and require acknowledgment.
// ═══════════════════════════════════════════════════════════════════════════

import { z } from "zod/v4";

export const NotificationIntensitySchema = z.object({
  level: z.enum(["SILENT", "AMBIENT", "STANDARD", "INSISTENT", "MUST_ACK"]),
  bannerPersistent: z.boolean(),
  audioCue:         z.boolean(),
  requireAck:       z.boolean(),
  reasons:          z.array(z.string()),
});
export type NotificationIntensity = z.infer<typeof NotificationIntensitySchema>;

export function recommendNotificationIntensity(input: {
  severity01: number;
  recentAcknowledgmentsMissed: number;
}): NotificationIntensity {
  const reasons: string[] = [];
  let level: NotificationIntensity["level"] = "AMBIENT";
  let bannerPersistent = false, audioCue = false, requireAck = false;

  if      (input.severity01 >= 0.85) { level = "MUST_ACK";  bannerPersistent = true;  audioCue = true; requireAck = true;  reasons.push("severity ≥0.85 → must acknowledge"); }
  else if (input.severity01 >= 0.65) { level = "INSISTENT"; bannerPersistent = true;  audioCue = true;                     reasons.push("severity ≥0.65 → insistent"); }
  else if (input.severity01 >= 0.50) { level = "STANDARD";  bannerPersistent = true;                                       reasons.push("severity ≥0.50 → standard banner"); }
  else if (input.severity01 >= 0.25) { level = "STANDARD";                                                                 reasons.push("severity ≥0.25 → standard"); }
  else if (input.severity01 < 0.10)  { level = "SILENT";                                                                   reasons.push("severity <0.10 → silent"); }

  if (input.recentAcknowledgmentsMissed >= 2 && !requireAck) {
    requireAck = true;
    reasons.push(`${input.recentAcknowledgmentsMissed} ack(s) missed → require acknowledgment`);
  }
  return { level, bannerPersistent, audioCue, requireAck, reasons };
}
