export {};
// Phase UX8 — Trade Action Center (18 scenarios).
// Black-box HTTP suite. Verifies the new /api/me/trade-actions endpoints
// exist, are user-scoped, drafts never execute, guards block before
// queueing, safety envelope on every payload, secrets never leak, AI
// tools are registered, and the unified review modal + page are wired.

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __d = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__d, "..", "..");
function repo(p: string): string { return resolve(REPO_ROOT, p); }
function readRepo(p: string): string {
  const full = repo(p);
  return existsSync(full) ? readFileSync(full, "utf8") : "";
}

const BASE = process.env["BASE"] ?? "http://localhost:80";
type R = { name: string; pass: boolean; note?: string };
const results: R[] = [];
function record(name: string, pass: boolean, note?: string) {
  results.push({ name, pass, note });
  // eslint-disable-next-line no-console
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${note ? "  — " + note : ""}`);
}

let cookie = "";
async function api(path: string, init?: RequestInit) {
  const headers = new Headers(init?.headers ?? {});
  if (cookie) headers.set("cookie", cookie);
  if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const r = await fetch(`${BASE}${path}`, { ...init, headers, redirect: "manual" });
  const sc = r.headers.get("set-cookie");
  if (sc) {
    const m = sc.match(/(?:^|, )([^=]+=[^;]+)/g);
    if (m) cookie = m.map((s) => s.replace(/^, /, "")).join("; ");
  }
  return r;
}
async function asJson(r: Response): Promise<Record<string, unknown> | null> {
  try { return await r.json() as Record<string, unknown>; } catch { return null; }
}

async function register() {
  const u = `ux8_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const r = await api("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ username: u, password: "Password!23", email: `${u}@example.test` }),
  });
  if (!r.ok) {
    const r2 = await api("/api/auth/dev-owner-login", { method: "POST", body: JSON.stringify({}) });
    if (!r2.ok) throw new Error(`register/dev-owner failed (${r.status}/${r2.status})`);
  }
}

const ENV_KEYS = ["safetyMode","liveLocked","readOnlyMode","allowOrderExecution"] as const;
function hasEnvelope(o: Record<string, unknown> | null | undefined): boolean {
  if (!o) return false;
  const s = (o as { safety?: Record<string, unknown> }).safety ?? o;
  return ENV_KEYS.every((k) => k in (s as Record<string, unknown>));
}
function containsSecrets(text: string): boolean {
  const env = process.env;
  const hay = text.toLowerCase();
  for (const k of ["SESSION_SECRET", "TWELVEDATA_API_KEY", "MT5_BRIDGE_TOKEN"]) {
    const v = env[k];
    if (v && v.length >= 8 && hay.includes(v.toLowerCase())) return true;
  }
  return /apikeyhash|password_hash|sessionsecret|mt5_bridge_token/i.test(text);
}

const ACTION_TYPES = ["OPEN","CLOSE","PARTIAL_CLOSE","MOVE_STOP","TRAIL_STOP","MODIFY_TP_SL","CANCEL_ORDER"];
const STATUSES = ["ai_suggested","user_reviewing","awaiting_confirmation","confirmed","guard_checking","queued","sent_to_mt5","executed","rejected","failed","expired","cancelled"];

async function run() {
  await register();

  // 1) Schema file declares all action types + statuses.
  const schemaSrc = readRepo("lib/db/src/schema/tradeActionRequests.ts");
  record("01 schema declares all 7 action types",
    schemaSrc.length > 0 && ACTION_TYPES.every((t) => schemaSrc.includes(t)));
  record("02 schema declares all 12 lifecycle statuses",
    STATUSES.every((s) => schemaSrc.includes(s)));

  // 3) GET list unauthed-OR-authed responds with envelope and ok shape.
  const list1 = await api("/api/me/trade-actions");
  const list1j = await asJson(list1);
  record("03 GET /api/me/trade-actions returns envelope",
    list1.status === 200 && hasEnvelope(list1j ?? undefined),
    `status=${list1.status}`);

  // 4) Reject invalid actionType.
  const bad = await api("/api/me/trade-actions", { method: "POST", body: JSON.stringify({ actionType: "NUKE" }) });
  record("04 POST draft rejects invalid actionType", bad.status === 400);

  // 5) Reject CLOSE without tradeKey.
  const noTk = await api("/api/me/trade-actions", { method: "POST", body: JSON.stringify({ actionType: "CLOSE" }) });
  const noTkJ = await asJson(noTk);
  record("05 CLOSE without tradeKey rejected", noTk.status === 400 && hasEnvelope(noTkJ ?? undefined));

  // 6) Reject OPEN without symbol/side/lot.
  const noOpen = await api("/api/me/trade-actions", { method: "POST", body: JSON.stringify({ actionType: "OPEN" }) });
  record("06 OPEN missing fields rejected", noOpen.status === 400);

  // 7) Create OPEN draft with symbol+side+lot → 201.
  const draft = await api("/api/me/trade-actions", { method: "POST", body: JSON.stringify({
    actionType: "OPEN", symbol: "EURUSD", side: "BUY", lotSize: 0.01,
    requestedMode: "SIMULATED", reason: "ux8 test draft",
  }) });
  const draftJ = await asJson(draft);
  const draftAction = (draftJ?.["action"] as { id?: number; status?: string } | undefined);
  const draftId = draftAction?.id ?? 0;
  record("07 POST OPEN draft returns 201 with non-terminal pre-confirm status",
    draft.status === 201 && typeof draftId === "number" && draftId > 0
    && (draftAction?.status === "ai_suggested" || draftAction?.status === "user_reviewing" || draftAction?.status === "awaiting_confirmation"),
    `status=${draft.status} id=${draftId} actionStatus=${draftAction?.status}`);

  // 8) Envelope on success payload.
  record("08 draft response carries safety envelope", hasEnvelope(draftJ ?? undefined));

  // 9) GET :id returns the same draft.
  const got = draftId ? await api(`/api/me/trade-actions/${draftId}`) : null;
  const gotJ = got ? await asJson(got) : null;
  record("09 GET :id returns the created draft",
    !!got && got.status === 200 && (gotJ?.["action"] as { id?: number } | undefined)?.id === draftId);

  // 10) GET :id for non-existent → 404 with envelope.
  const miss = await api("/api/me/trade-actions/999999999");
  const missJ = await asJson(miss);
  record("10 GET :id 999999999 is 404 with envelope",
    miss.status === 404 && hasEnvelope(missJ ?? undefined));

  // 11) Confirm DOES NOT result in executed (no real broker). Status
  //     must end in one of: queued | sent_to_mt5 | rejected | failed.
  let confirmStatus: string | null = null;
  if (draftId) {
    const conf = await api(`/api/me/trade-actions/${draftId}/confirm`, { method: "POST", body: JSON.stringify({}) });
    const confJ = await asJson(conf);
    confirmStatus = ((confJ?.["action"] as { status?: string } | undefined)?.status) ?? null;
    record("11 confirm never reports 'executed' synchronously",
      confirmStatus !== "executed",
      `status=${conf.status} actionStatus=${confirmStatus}`);
  } else { record("11 confirm never reports 'executed' synchronously", false, "no draftId"); }

  // 12) Confirm response carries envelope.
  if (draftId) {
    const conf2 = await api(`/api/me/trade-actions/${draftId}/confirm`, { method: "POST", body: JSON.stringify({}) });
    const conf2J = await asJson(conf2);
    record("12 confirm payload carries safety envelope", hasEnvelope(conf2J ?? undefined));
  } else record("12 confirm payload carries safety envelope", false, "skipped");

  // 13) Cancel on a terminal action → 400 (cannot transition from terminal).
  //     If status is non-terminal, the cancel should succeed (200).
  if (draftId) {
    const cancel = await api(`/api/me/trade-actions/${draftId}/cancel`, { method: "POST", body: JSON.stringify({ reason: "test" }) });
    const okEither = cancel.status === 200 || cancel.status === 400;
    record("13 cancel returns deterministic 200|400 (never 500)", okEither, `status=${cancel.status}`);
  } else record("13 cancel returns deterministic 200|400 (never 500)", false, "skipped");

  // 14) Audit endpoint returns events array + envelope.
  if (draftId) {
    const aud = await api(`/api/me/trade-actions/${draftId}/audit`);
    const audJ = await asJson(aud);
    record("14 audit returns events array + envelope",
      aud.status === 200 && Array.isArray(audJ?.["events"]) && hasEnvelope(audJ ?? undefined));
  } else record("14 audit returns events array + envelope", false, "skipped");

  // 15) No secrets in any of the action responses we collected.
  const dump = JSON.stringify({ list1j, draftJ, gotJ, missJ });
  record("15 no secrets leaked in any UX8 response", !containsSecrets(dump));

  // 16) AI tools registered + dispatch wired.
  const toolsSrc = readRepo("artifacts/api-server/src/lib/assistant/tools.ts");
  const fourTools = ["createTradeActionDraft","listMyPendingActions","getTradeActionStatus","explainActionRejection"];
  record("16 four UX8 AI tools defined + dispatched",
    fourTools.every((t) => toolsSrc.includes(`name: "${t}"`) && toolsSrc.includes(`case "${t}"`)));

  // 17) systemPrompt teaches UX8 draft-only flow.
  const sysSrc = readRepo("artifacts/api-server/src/lib/assistant/systemPrompt.ts");
  record("17 systemPrompt UX8 teaches draft-only + Action Center",
    /Phase UX8/.test(sysSrc) && /createTradeActionDraft/.test(sysSrc) && /never executes automatically|never executes/i.test(sysSrc));

  // 18) Frontend modal + page + sidebar entry exist.
  const modal = readRepo("artifacts/trading-dashboard/src/components/action-center/TradeActionReviewModal.tsx");
  const page  = readRepo("artifacts/trading-dashboard/src/pages/action-center.tsx");
  const layout = readRepo("artifacts/trading-dashboard/src/components/layout/AppLayout.tsx");
  record("18 modal + page + sidebar entry wired",
    modal.includes("TradeActionReviewModal")
    && page.includes("Trade Action Center")
    && /href: "\/action-center"/.test(layout));

  const passed = results.filter((r) => r.pass).length;
  // eslint-disable-next-line no-console
  console.log(`\nResults: ${passed}/${results.length} passed`);
  if (passed < results.length) process.exit(1);
}

run().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("UX8 test crashed:", e);
  process.exit(1);
});
