// Transactional email via Resend.
//
// Integration: Resend connector (@replit/connectors-sdk). The connector stores
// the Resend API key and the verified sender address (`from_email`) as secrets —
// nothing is hardcoded and the raw API key never enters this process: outbound
// sends go through the connectors proxy, which injects the Authorization header
// server-side. We only read the (non-secret) sender address from the connection
// settings to populate the `from` field.
//
// This is the single shared email helper for the API server. Reuse `sendEmail`
// for future transactional mail (invites, access approvals, security notices) —
// do NOT add a second mailer.

import { ReplitConnectors } from "@replit/connectors-sdk";

const CONNECTOR_NAME = "resend";

// Raised when the Resend connection / sender address cannot be resolved. Callers
// log this at error level for admin/developer visibility — it is never surfaced
// to end users (who always see the same neutral message).
export class EmailNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailNotConfiguredError";
  }
}

// Raised when Resend accepts the request but rejects the send (e.g. unverified
// sender domain, invalid recipient). Carries the upstream status + message for
// the admin/developer log.
export class EmailSendError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "EmailSendError";
    this.status = status;
  }
}

export function isEmailNotConfiguredError(err: unknown): err is EmailNotConfiguredError {
  return err instanceof EmailNotConfiguredError;
}

const connectors = new ReplitConnectors();

// Sender address resolution is cached briefly so we don't hit the connectors
// settings endpoint on every send. It is NOT a secret (the API key is never
// cached here — that stays inside the proxy).
const SENDER_TTL_MS = 5 * 60 * 1000;
let cachedSender: { value: string; at: number } | null = null;

interface ConnectionListResponse {
  items?: Array<{ settings?: { from_email?: string } }>;
}

// Resolve the verified sender address. Precedence: explicit EMAIL_FROM env
// override (handy for testing against a verified domain), then the connector's
// configured `from_email`.
async function resolveSenderAddress(): Promise<string> {
  const override = process.env.EMAIL_FROM?.trim();
  if (override) return override;

  if (cachedSender && Date.now() - cachedSender.at < SENDER_TTL_MS) {
    return cachedSender.value;
  }

  let resp: Response;
  try {
    // getProxyHeaders gives us the Replit identity headers (with token refresh
    // handled by the SDK). We use them to read the connection's non-secret
    // sender address via the connectors settings endpoint.
    const headers = await connectors.getProxyHeaders(CONNECTOR_NAME);
    const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME ?? "connectors.replit.com";
    const url =
      `https://${hostname}/api/v2/connection` +
      `?include_secrets=true&connector_names=${CONNECTOR_NAME}&refresh_policy=auto`;
    resp = await fetch(url, { headers });
  } catch (err) {
    throw new EmailNotConfiguredError(
      `Resend connection lookup failed: ${(err as Error).message}`,
    );
  }

  if (!resp.ok) {
    throw new EmailNotConfiguredError(
      `Resend connection lookup returned ${resp.status} — is the Resend integration connected?`,
    );
  }

  const data = (await resp.json()) as ConnectionListResponse;
  const from = data.items?.[0]?.settings?.from_email?.trim();
  if (!from) {
    throw new EmailNotConfiguredError(
      "Resend sender address (from_email) is not configured on the connection.",
    );
  }
  cachedSender = { value: from, at: Date.now() };
  return from;
}

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
}

interface ResendSendResponse {
  id?: string;
  message?: string;
  name?: string;
}

// Send a transactional email through Resend. Throws EmailNotConfiguredError if
// the connection/sender is unavailable, or EmailSendError if Resend rejects the
// send. Never logs or returns the API key.
export async function sendEmail(input: SendEmailInput): Promise<{ id: string }> {
  const from = await resolveSenderAddress();

  const resp = await connectors.proxy(CONNECTOR_NAME, "/emails", {
    method: "POST",
    body: {
      from,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
      ...(input.replyTo ? { reply_to: input.replyTo } : {}),
    },
  });

  const raw = await resp.text();
  let parsed: ResendSendResponse = {};
  try {
    parsed = raw ? (JSON.parse(raw) as ResendSendResponse) : {};
  } catch {
    /* non-JSON body — fall through to status-based handling */
  }

  if (!resp.ok) {
    const detail = parsed.message ?? raw ?? "unknown error";
    throw new EmailSendError(`Resend send failed: ${detail}`, resp.status);
  }

  return { id: parsed.id ?? "" };
}
