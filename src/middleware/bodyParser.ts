import express, { type Request, type Response, type NextFunction, type RequestHandler } from 'express';
import config from '../config';

export type BodyLimitKind = 'upload' | 'auth' | 'default';

const parsers: Record<BodyLimitKind, RequestHandler> = {
  upload: express.json({ limit: config.bodyLimit.upload }),
  auth: express.json({ limit: config.bodyLimit.auth }),
  default: express.json({ limit: config.bodyLimit.json }),
};

const UPLOAD_ROUTE_RE = /^\/api\/(?:v[12]\/)?(?:players\/register|validators\/milestone)$/;
const AUTH_ROUTE_RE = /^\/auth(?:\/(?:token|challenge|refresh|logout))?$/;

/**
 * Normalize a request path for route-limit classification:
 * collapses consecutive slashes, strips trailing slashes (preserving "/"),
 * and lowercases to match Express's default case-insensitive routing.
 */
export function normalizeBodyLimitPath(rawPath: string): string {
  const collapsed = rawPath.replace(/\/+/g, '/');
  const trimmed = collapsed.length > 1 ? collapsed.replace(/\/+$/, '') : collapsed;
  return trimmed.toLowerCase();
}

/**
 * Returns an Express JSON body-parser middleware configured for the given tier:
 * - `'upload'`  — `config.bodyLimit.upload` (default 10 MB) for player registration & milestone evidence
 * - `'auth'`    — `config.bodyLimit.auth` (default 1 KB) for `/auth/*` endpoints
 * - `'default'` — `config.bodyLimit.json` (default 1 MB) global fallback
 */
export function jsonBody(kind: BodyLimitKind = 'default'): RequestHandler {
  const parser = parsers[kind];

  if (kind !== 'default') {
    return parser;
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    if ((req as Request & { _body?: boolean })._body) {
      next();
      return;
    }

    const normalizedPath = normalizeBodyLimitPath(req.path || '/');
    if (AUTH_ROUTE_RE.test(normalizedPath) || UPLOAD_ROUTE_RE.test(normalizedPath)) {
      next();
      return;
    }

    parser(req, res, next);
  };
}
