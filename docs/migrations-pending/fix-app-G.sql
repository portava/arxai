-- fix/app-G — additive schema for the notification/preferences defects
-- (ranks 14, 35, 77). Apply with plain psql. Everything is IF NOT EXISTS /
-- ADD COLUMN IF NOT EXISTS; nothing is dropped, narrowed, or rewritten.
-- Safe to re-run.

-- ── RANK 77: the push-delivery severity floor had no column to live in ──────
--
-- artifacts/api-server/src/lib/push/sendService.ts has always read
-- `minimumPushSeverity` off the user_notification_preferences row:
--
--     const minThreshold = (prefs as { minimumPushSeverity?: string })
--       ?.minimumPushSeverity ?? "info";
--
-- but the column existed only on the two RETIRED preference tables
-- (alert_preferences, notification_preferences). The cast therefore always
-- produced `undefined` and the gate silently defaulted to "info" for every
-- user: real gate code that no value could ever reach, and no surface in the
-- app could set it. /alert-preferences now writes this column.
--
-- CRITICAL alerts bypass this gate entirely (sendService only consults it for
-- non-critical severities), so raising the floor can never silence a live-risk
-- emergency.
ALTER TABLE user_notification_preferences
  ADD COLUMN IF NOT EXISTS minimum_push_severity text NOT NULL DEFAULT 'info';

-- ── RANK 35: digests had no owner ──────────────────────────────────────────
--
-- generateDigest() aggregated EVERY user's notifications and latestDigest()
-- returned the newest row in the table, so the Notification Center rendered
-- platform-wide counts plus the literal titles of other users' CRITICAL alerts
-- — directly beneath copy promising "We never show other users' notifications
-- or global admin alerts."
--
-- Nullable on purpose: pre-existing rows keep NULL and are treated as legacy
-- cross-user aggregates that no per-user read may ever return (the scoped
-- query filters on user_id = $1, so a NULL row can never match).
ALTER TABLE notification_digests
  ADD COLUMN IF NOT EXISTS user_id integer;

CREATE INDEX IF NOT EXISTS notification_digests_user_created_at_idx
  ON notification_digests (user_id, created_at);

-- ── RANK 34: no schema change is needed ────────────────────────────────────
--
-- The cross-user notification collision (two users hitting their daily loss
-- limit on the same day sharing one row, because rule dedupe keys such as
-- `HH:DAILY_LOSS_HIT:<date>` are user-independent and
-- notifications_dedupe_key_idx is a GLOBAL unique index) is fixed in
-- application code by namespacing the stored key with its owner
-- (`u<userId>::` / `system::`, see notifications/service.ts scopedDedupeKey).
-- That turns the existing global unique index into a per-user unique index for
-- free — no index rebuild, no destructive migration.
--
-- One-off consequence worth knowing at apply time: existing rows keep their old
-- un-namespaced dedupe_key, so the first re-fire of any already-recorded
-- condition creates one new row instead of bumping the old one's repeat_count.
-- No data is lost and nothing is deleted.
