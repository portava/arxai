import { upsertAlertOnce } from "../../routes/meAlerts.js";
import { logger } from "../logger.js";
import { createOperationalRateCapMonitor } from "./operationalRateCapMonitor.js";

/** Dashboard notification only; no email/SMS/push, broker call or control write. */
export const reportOperationalRateCap = createOperationalRateCapMonitor({
  emit: event => logger.warn(event, event.event),
  notify: (userId, alert) => upsertAlertOnce(userId, alert),
});
