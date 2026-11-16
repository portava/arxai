---
name: Notification dedupe collapse
description: Why repeated alerts spam user_notifications and how the collapse design avoids resurfacing dismissed alerts.
---

# Notification dedupe relies on a STABLE entity key

`createNotification` dedupes on `(userId, notificationType, entityType, entityId, bucket)`
via a UNIQUE index + `onConflictDoNothing`. Collapsing repeats only works if the
caller passes a **stable** `(entityType, entityId)` for the same logical condition.

**Why:** the sniper exit-alert path was spamming the Alerts page because it keyed
each emission on the freshly-inserted `trade_exit_alerts` row id (`entityId = a.id`),
so the dedupe key never collided and every re-fire of a persistent condition
(e.g. "holding longer than your intraday window") produced a brand-new
notification. Fix = key on the trade itself (`entityType: trade_exit:<tradeKey>`,
`entityId: 0`).

**How to apply:**
- For a persistent/recurring condition, pass a stable entity key AND a longer
  `cooldownMs` (bucket = `floor(now / cooldownMs)`, default 1h) so re-fires
  collapse into one row.
- On a dedupe collision the collapse path bumps `repeatCount` + `lastOccurrenceAt`
  but MUST NOT reset `status` — otherwise a read/dismissed alert gets resurfaced.
- Web-push fires on fresh insert only, never on a collapse bump.

# Deleting an alert is a SOFT archive

User-facing "delete"/bulk-dismiss sets `status='dismissed'` only. Never hard-delete
a notification row and never touch trade/command/ledger tables from the alerts
routes — alert rows can be referenced as evidence elsewhere. Bulk endpoints must
filter every UPDATE by `userId` AND id (never trust client ids alone) so one user
can never mutate another user's notifications.
