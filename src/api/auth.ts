/**
 * Optional shared-secret guard for the control API.
 *
 * The API listens on 0.0.0.0 by default and has endpoints that can sell
 * positions (/runner/sell-all, /runner/exit), move vault funds (/vault/*) and
 * change config. With API_TOKEN set, every request except GET /health must
 * carry the token as `Authorization: Bearer <token>` or `X-API-Token: <token>`.
 * Unset = old behaviour (open), so existing setups keep working.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

function digest(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

/** Constant-time string compare (via fixed-length digests). */
export function tokensMatch(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  return timingSafeEqual(digest(given), digest(expected));
}

export function extractToken(req: Pick<Request, "headers">): string | undefined {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "").trim();
  const h = req.headers["x-api-token"];
  return typeof h === "string" ? h.trim() : undefined;
}

export function apiTokenGuard(expected: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method === "OPTIONS" || (req.method === "GET" && req.path === "/health")) {
      next();
      return;
    }
    if (tokensMatch(extractToken(req), expected)) {
      next();
      return;
    }
    res.status(401).json({ ok: false, message: "Missing or invalid API token (set Authorization: Bearer <API_TOKEN>)." });
  };
}
