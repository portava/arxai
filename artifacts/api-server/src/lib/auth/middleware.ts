// Per-user auth middleware. Reads the `arx_user_session` cookie, looks up
// the session row, attaches `req.authUser`. Independent from the existing
// security role layer (`hr_session` cookie + `x-security-role` header) which
// continues to govern OWNER/ADMIN/TESTER permission checks.
//
// Routes that need a logged-in user wrap themselves with `requireUser`.
// Routes that work for both anonymous and logged-in callers can read
// `req.authUser` after running through `attachAuthUser`.

import type { Request, Response, NextFunction } from "express";
import type { User } from "@workspace/db";
import { findUserBySessionToken, USER_SESSION_COOKIE } from "./userSessions.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      authUser?: User;
    }
  }
}

function readSessionCookie(req: Request): string | null {
  const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
  const raw = cookies?.[USER_SESSION_COOKIE];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

export async function attachAuthUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const raw = readSessionCookie(req);
    if (raw) {
      const user = await findUserBySessionToken(raw);
      if (user) req.authUser = user;
    }
  } catch {
    // fail open — req.authUser stays undefined, downstream middleware decides.
  }
  next();
}

export function requireUser(req: Request, res: Response, next: NextFunction): void {
  if (req.authUser) {
    next();
    return;
  }
  // Try sync attach if attachAuthUser wasn't mounted upstream.
  const raw = readSessionCookie(req);
  if (!raw) {
    res.status(401).json({ error: "AUTH_REQUIRED", message: "Sign in required." });
    return;
  }
  findUserBySessionToken(raw)
    .then((user) => {
      if (!user) {
        res.status(401).json({ error: "AUTH_REQUIRED", message: "Sign in required." });
        return;
      }
      req.authUser = user;
      next();
    })
    .catch(() => {
      res.status(401).json({ error: "AUTH_REQUIRED", message: "Sign in required." });
    });
}
