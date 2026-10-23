import { db, featureAnnouncementsTable, userFeatureAcknowledgementsTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { SEED_ANNOUNCEMENTS } from "./seed.js";

const DEFAULT_USER = "default";

let seededOnce = false;

export async function ensureSeeded(): Promise<void> {
  if (seededOnce) return;
  for (const a of SEED_ANNOUNCEMENTS) {
    await db.insert(featureAnnouncementsTable).values({
      featureKey: a.featureKey,
      version: a.version,
      title: a.title,
      body: a.body,
      route: a.route,
      severity: a.severity,
      active: true,
    }).onConflictDoNothing();
  }
  seededOnce = true;
}

export interface AnnouncementWithState {
  id: number;
  featureKey: string;
  version: string;
  title: string;
  body: string;
  route: string | null;
  severity: string;
  acknowledged: boolean;
  dismissed: boolean;
  remindLaterUntil: string | null;
  shouldShow: boolean;
}

export async function listAnnouncements(userKey: string = DEFAULT_USER): Promise<AnnouncementWithState[]> {
  await ensureSeeded();
  const rows = await db.select().from(featureAnnouncementsTable).where(eq(featureAnnouncementsTable.active, true));
  const acks = await db.select().from(userFeatureAcknowledgementsTable).where(eq(userFeatureAcknowledgementsTable.userKey, userKey));
  const ackByKey = new Map(acks.map(a => [`${a.featureKey}@${a.version}`, a]));
  const now = Date.now();
  return rows.map(r => {
    const ack = ackByKey.get(`${r.featureKey}@${r.version}`);
    const acknowledged = ack?.acknowledged ?? false;
    const dismissed = ack?.dismissed ?? false;
    const remindLaterUntil = ack?.remindLaterUntil ? ack.remindLaterUntil.toISOString() : null;
    const remindLaterActive = remindLaterUntil && new Date(remindLaterUntil).getTime() > now;
    const shouldShow = !acknowledged && !dismissed && !remindLaterActive;
    return {
      id: r.id,
      featureKey: r.featureKey,
      version: r.version,
      title: r.title,
      body: r.body,
      route: r.route,
      severity: r.severity,
      acknowledged,
      dismissed,
      remindLaterUntil,
      shouldShow,
    };
  });
}

async function upsertAck(
  userKey: string,
  featureKey: string,
  version: string,
  patch: { acknowledged?: boolean; dismissed?: boolean; remindLaterUntil?: Date | null },
): Promise<void> {
  const setValues: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.acknowledged !== undefined) {
    setValues.acknowledged = patch.acknowledged;
    setValues.acknowledgedAt = patch.acknowledged ? new Date() : null;
  }
  if (patch.dismissed !== undefined) {
    setValues.dismissed = patch.dismissed;
    setValues.dismissedAt = patch.dismissed ? new Date() : null;
  }
  if (patch.remindLaterUntil !== undefined) {
    setValues.remindLaterUntil = patch.remindLaterUntil;
  }
  await db.insert(userFeatureAcknowledgementsTable).values({
    userKey,
    featureKey,
    version,
    acknowledged: patch.acknowledged ?? false,
    dismissed: patch.dismissed ?? false,
    remindLaterUntil: patch.remindLaterUntil ?? null,
    acknowledgedAt: patch.acknowledged ? new Date() : null,
    dismissedAt: patch.dismissed ? new Date() : null,
  }).onConflictDoUpdate({
    target: [userFeatureAcknowledgementsTable.userKey, userFeatureAcknowledgementsTable.featureKey, userFeatureAcknowledgementsTable.version],
    set: setValues,
  });
}

export async function acknowledgeAnnouncement(featureKey: string, version: string, userKey: string = DEFAULT_USER): Promise<void> {
  await upsertAck(userKey, featureKey, version, { acknowledged: true, remindLaterUntil: null });
}

export async function dismissAnnouncement(featureKey: string, version: string, userKey: string = DEFAULT_USER): Promise<void> {
  await upsertAck(userKey, featureKey, version, { dismissed: true, remindLaterUntil: null });
}

export async function remindLater(featureKey: string, version: string, hours: number = 24, userKey: string = DEFAULT_USER): Promise<Date> {
  const until = new Date(Date.now() + hours * 3600 * 1000);
  await upsertAck(userKey, featureKey, version, { remindLaterUntil: until });
  return until;
}

export async function resetAcknowledgements(userKey: string = DEFAULT_USER): Promise<number> {
  const result = await db.delete(userFeatureAcknowledgementsTable).where(eq(userFeatureAcknowledgementsTable.userKey, userKey));
  return (result as unknown as { rowCount?: number }).rowCount ?? 0;
}
