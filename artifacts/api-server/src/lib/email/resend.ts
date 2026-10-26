// Transactional email via Resend.
//
// Integration: Resend connector (@replit/connectors-sdk). The connector stores
// the Resend API key; the sender comes from EMAIL_FROM or connection metadata —
// nothing is hardcoded. Outbound sends use the connectors proxy. Older Replit
// connections expose from_email only through their settings endpoint (which may
// also return secrets); the compatibility adapter extracts only the sender and
// never logs, returns or caches the remaining settings.
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
// sender domain, invalid recipient). Carries a safe code and upstream status for
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

// Dependency boundary keeps transport tests offline and retains one shared mailer.
export interface EmailConnector {
  listConnections(options: { connector_names: string; refresh_policy: "none" }): Promise<unknown[]>;
  proxy(name: string, path: string, options: { method: string; body: unknown }): Promise<Response>;
  readLegacySender?(): Promise<unknown>;
}

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
}

export type EmailConfiguration = {
  configured: boolean;
  deliveryVerified: false;
  reason: "CONFIGURED_DELIVERY_UNVERIFIED" | "CONNECTOR_UNAVAILABLE" | "SENDER_MISSING_OR_INVALID";
};

function senderValid(value: unknown): value is string {
  if (typeof value !== "string" || /[\r\n]/.test(value)) return false;
  // Accept the provider's normal bare mailbox or display-name mailbox format.
  return /^(?:[^<>]+\s<)?[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>?$/.test(value.trim())
    && value.includes("<") === value.endsWith(">");
}

export function createEmailService(connector: EmailConnector, env: NodeJS.ProcessEnv = process.env,
  now: () => number = Date.now) {
  let cached: { sender: string; override: string; at: number } | null = null;
  const resolveSender = async (): Promise<string> => {
    const override = env.EMAIL_FROM?.trim() ?? "";
    if (cached && cached.override === override && now() - cached.at >= 0 && now() - cached.at < 300_000) return cached.sender;
    let items: unknown[];
    try {
      // SDK metadata listing deliberately does NOT request include_secrets.
      // Outbound mail still uses the proxy; API keys remain outside this process.
      items = await connector.listConnections({ connector_names: CONNECTOR_NAME, refresh_policy: "none" });
    } catch {
      throw new EmailNotConfiguredError("CONNECTOR_UNAVAILABLE");
    }
    if (!Array.isArray(items) || items.length === 0) throw new EmailNotConfiguredError("CONNECTOR_UNAVAILABLE");
    const item = items[0];
    const settings = item && typeof item === "object" ? (item as Record<string, unknown>).settings : null;
    const configured = settings && typeof settings === "object" ? (settings as Record<string, unknown>).from_email : null;
    let sender = override || (typeof configured === "string" ? configured.trim() : "");
    if (!sender && connector.readLegacySender) {
      try {
        const legacy = await connector.readLegacySender();
        sender = typeof legacy === "string" ? legacy.trim() : "";
      } catch {
        throw new EmailNotConfiguredError("CONNECTOR_UNAVAILABLE");
      }
    }
    if (!senderValid(sender)) throw new EmailNotConfiguredError("SENDER_MISSING_OR_INVALID");
    cached = { sender, override, at: now() };
    return sender;
  };
  const inspectConfiguration = async (): Promise<EmailConfiguration> => {
    try {
      await resolveSender();
      return { configured: true, deliveryVerified: false, reason: "CONFIGURED_DELIVERY_UNVERIFIED" };
    } catch (error) {
      const reason = error instanceof EmailNotConfiguredError && error.message === "SENDER_MISSING_OR_INVALID"
        ? "SENDER_MISSING_OR_INVALID" : "CONNECTOR_UNAVAILABLE";
      return { configured: false, deliveryVerified: false, reason };
    }
  };
  const send = async (input: SendEmailInput): Promise<{ id: string }> => {
    const from = await resolveSender();
    let resp: Response;
    try {
      resp = await connector.proxy(CONNECTOR_NAME, "/emails", {
        method: "POST",
        body: { from, to: input.to, subject: input.subject, html: input.html, text: input.text,
          ...(input.replyTo ? { reply_to: input.replyTo } : {}) },
      });
    } catch {
      // Do not propagate provider exception text: it can contain recipient data,
      // request bodies (including reset links) or authentication information.
      throw new EmailSendError("EMAIL_TRANSPORT_FAILED", 0);
    }
    if (!resp.ok) {
      cached = null;
      throw new EmailSendError("EMAIL_PROVIDER_REJECTED", resp.status);
    }
    let body: unknown;
    try { body = await resp.json(); } catch { throw new EmailSendError("EMAIL_RESPONSE_INVALID", resp.status); }
    const id = body && typeof body === "object" ? (body as Record<string, unknown>).id : null;
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
      throw new EmailSendError("EMAIL_ACCEPTANCE_UNCONFIRMED", resp.status);
    }
    return { id };
  };
  return { send, inspectConfiguration };
}

/** Compatibility with existing Replit connections whose sender is in settings.
 * This is the pre-existing read path, used only if metadata/EMAIL_FROM lack it.
 * The endpoint may return secrets: retain only from_email, never the payload. */
export async function readLegacyResendSender(
  connector: Pick<ReplitConnectors, "getProxyHeaders">,
  env: NodeJS.ProcessEnv = process.env,
  transport: typeof fetch = fetch,
): Promise<unknown> {
  try {
    const hostname = env.REPLIT_CONNECTORS_HOSTNAME ?? "connectors.replit.com";
    if (!/^[a-z0-9.-]+$/i.test(hostname)) throw new Error();
    const headers = await connector.getProxyHeaders(CONNECTOR_NAME);
    const response = await transport(`https://${hostname}/api/v2/connection?include_secrets=true&connector_names=resend&refresh_policy=auto`,
      { headers, signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error();
    const data = await response.json() as { items?: Array<{ settings?: { from_email?: unknown } }> };
    return data.items?.[0]?.settings?.from_email;
  } catch {
    throw new EmailNotConfiguredError("CONNECTOR_UNAVAILABLE");
  }
}

const connector = new ReplitConnectors();
const service = createEmailService({
  listConnections: options => connector.listConnections(options),
  proxy: (name, path, options) => connector.proxy(name, path, options),
  readLegacySender: () => readLegacyResendSender(connector),
});
export const sendEmail = service.send;
/** Read-only configuration check; never sends mail or claims inbox delivery. */
export const inspectEmailConfiguration = service.inspectConfiguration;
