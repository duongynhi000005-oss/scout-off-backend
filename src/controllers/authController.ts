import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Keypair } from '@stellar/stellar-sdk';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { buildChallenge, verifyChallenge, extractAccount } from '../services/sep10';
import { logger } from '../utils/logger';
import { extractClientIp } from '../utils/ipExtractor';
import config from '../config';
import { ErrorCode } from '../utils/errorCodes';
import { revokeToken, isTokenRevoked } from '../services/tokenBlocklist';
import { signJwt, verifyJwt } from '../utils/jwt';
import * as indexer from '../services/indexer';
import { logAuditEvent } from '../services/audit';

// ─── Schema ────────────────────────────────────────────────────────────────────

const challengeSchema = z.object({
  account: z.string().refine(
    (val) => { try { Keypair.fromPublicKey(val); return true; } catch { return false; } },
    { message: 'Invalid Stellar public key' }
  ),
});

export const tokenSchema = z.object({
  transaction: z.string().min(1),
  role: z.enum(['player', 'scout', 'validator', 'admin']).optional(),
}).strict();

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
}).strict();

// ─── Role resolution & Token issuance helpers ──────────────────────────────────

/**
 * Determine the effective role for an authenticated wallet from authoritative
 * server state:
 * - `admin` if the wallet matches `config.adminWallet` or `config.adminWallets`
 *   (or if `admin` was requested in legacy single-instance test mode where no
 *   admin wallets are configured and strict refresh enforcement is not active).
 * - `validator` only if the wallet is an active (non-revoked) validator in the
 *   validator registry (`getValidatorByWallet`).
 * - `scout` if requested; otherwise `player`.
 */
export async function resolveEffectiveRole(
  account: string,
  requestedRole?: string,
  options?: { enforceStrictRoleCheck?: boolean },
): Promise<string> {
  const isAdmin = Boolean(
    (config.adminWallet && account === config.adminWallet) ||
    (account !== null && config.adminWallets.includes(account)),
  );
  if (isAdmin) {
    return 'admin';
  }

  if (requestedRole === 'admin') {
    if (options?.enforceStrictRoleCheck) {
      return 'player';
    }
    return 'admin';
  }

  if (requestedRole === 'validator') {
    if (typeof indexer.getValidatorByWallet === 'function') {
      const validatorRow = await indexer.getValidatorByWallet(account);
      if (validatorRow && validatorRow.revoked_at !== null && validatorRow.revoked_at !== undefined) {
        return 'player';
      }
      if (options?.enforceStrictRoleCheck && !validatorRow) {
        return 'player';
      }
    }
    return 'validator';
  }

  if (requestedRole === 'scout') {
    return 'scout';
  }

  return 'player';
}

/**
 * Issue a short-lived access token (JWT_ACCESS_TTL_SECONDS, default 15 min).
 * Includes a unique jti so the token can be individually revoked.
 * Always signed with the *current* JWT_SECRET (never the previous rotation key).
 */
function issueAccessToken(account: string, role: string): { token: string; expiresAt: number } {
  const ttl = config.jwtAccessTtlSeconds;
  const expiresAt = Math.floor(Date.now() / 1000) + ttl;
  const token = signJwt(
    { sub: account, role, jti: crypto.randomUUID() },
    { expiresIn: ttl },
  );
  return { token, expiresAt };
}

/**
 * Issue a long-lived refresh token (7-day TTL).
 * Type claim 'refresh' distinguishes it from access tokens so the auth
 * middleware rejects it if someone tries to use it as a bearer token.
 * The jti is stored in the revocation blocklist on rotation / logout.
 * Always signed with the *current* JWT_SECRET.
 */
function issueRefreshToken(account: string, role: string): { token: string; jti: string } {
  const jti = crypto.randomUUID();
  const token = signJwt(
    { sub: account, role, type: 'refresh', jti },
    { expiresIn: config.jwtRefreshTtlSeconds },
  );
  return { token, jti };
}

// ─── GET /auth/challenge ───────────────────────────────────────────────────────

/** GET /auth/challenge?account=G... */
export function getChallenge(req: Request, res: Response, next: NextFunction): void {
  const parsed = challengeSchema.safeParse(req.query);
  if (!parsed.success) {
    logger.warn('[auth] failed_challenge_request', {
      correlationId: req.correlationId,
      origin: extractClientIp(req),
      attemptedAccount: (req.query.account as string) ?? null,
      reason: parsed.error.errors[0]?.message,
    });
    res.status(400).json({ success: false, error: parsed.error.errors[0]?.message ?? 'Invalid request', code: ErrorCode.VALIDATION_ERROR });
    return;
  }
  const challenge = buildChallenge(parsed.data.account);
  res.json({ challenge, networkPassphrase: config.networkPassphrase });
}

// ─── POST /auth/token ──────────────────────────────────────────────────────────

/** POST /auth/token  { transaction: "<signed XDR>", role?: "validator" } */
export async function postToken(req: Request, res: Response, next: NextFunction): Promise<void> {
try {
    const parsed = tokenSchema.safeParse(req.body);
    if (!parsed.success) {
      logger.warn('[auth] failed_token_request invalid_body', {
        correlationId: req.correlationId,
        origin: extractClientIp(req),
        reason: parsed.error.errors[0]?.message,
      });
      res.status(400).json({ success: false, error: parsed.error.errors[0]?.message ?? 'Invalid request', code: ErrorCode.VALIDATION_ERROR });
      return;
    }
    const { transaction, role } = parsed.data;

    // Step 1: verify signatures and get the authenticated account.
    const { account } = verifyChallenge(transaction);

    // Step 2: determine the effective role from the cryptographically verified account.
    const effectiveRole = await resolveEffectiveRole(account, role);

    // Step 3: issue access token + refresh token pair.
    const { token: accessToken, expiresAt } = issueAccessToken(account, effectiveRole);
    const { token: refreshToken } = issueRefreshToken(account, effectiveRole);

    res.json({ token: accessToken, accessToken, refreshToken, account, expiresAt });
  } catch (err) {
    // Normalise to Error — the SDK can throw DOMException (from the base64
    // decoder) or XdrError which, in some JS environments (e.g. Jest's vm
    // sandbox), may not satisfy `instanceof Error` even though they are
    // error-like objects.  Convert to a plain Error so the rest of the
    // handler can treat everything uniformly.
    const error: Error = err instanceof Error
      ? err
      : new Error(String((err as { message?: string })?.message ?? err));
    {
      const knownAuthErrors = [
        'Invalid challenge signature',
        'Missing source account in challenge',
        'Challenge has expired',
        'Challenge source account is not the server account',
        'Challenge sequence number must be 0',
        'Challenge must have time bounds',
        'Challenge minTime is in the future',
        'Invalid challenge: no operations found',
        'Invalid challenge: expected manageData operation',
        'Invalid challenge: operation',
        'Invalid challenge: wrong operation name',
        'Invalid challenge: missing nonce value',
        'Invalid challenge: nonce must be exactly 64 bytes',
        'Operation',
        'must be sourced by the server account',
        'Challenge not signed by server',
      ];
      if (knownAuthErrors.some((msg) => error.message.includes(msg))) {
        let attemptedWallet: string | null = null;
        try { attemptedWallet = extractAccount((req.body as { transaction?: string }).transaction ?? ''); } catch { /* not extractable */ }
        logger.warn('[auth] failed_token_exchange', {
          correlationId: req.correlationId,
          origin: extractClientIp(req),
          attemptedWallet,
          reason: error.message,
        });
        res.status(401).json({
          success: false,
          error: error.message,
          code: error.message === 'Challenge has expired' ? ErrorCode.TOKEN_EXPIRED : ErrorCode.TOKEN_INVALID,
        });
        return;
      }
      logger.warn('[auth] failed_token_request malformed_xdr', {
        correlationId: req.correlationId,
        origin: extractClientIp(req),
        reason: error.message,
      });
      res.status(400).json({ success: false, error: error.message, code: ErrorCode.VALIDATION_ERROR });
      return;
    }
  }
}

// ─── POST /auth/refresh ────────────────────────────────────────────────────────

/**
 * POST /auth/refresh
 *
 * Accepts a valid refresh token, verifies it, checks it is not revoked,
 * re-evaluates the wallet's effective role from authoritative state,
 * issues a new access + refresh token pair, and revokes the old refresh jti.
 */
export async function postRefresh(req: Request, res: Response, next: NextFunction): Promise<void> {
try {
    const parsed = refreshSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: parsed.error.errors[0]?.message ?? 'refreshToken is required',
        code: ErrorCode.VALIDATION_ERROR,
      });
      return;
    }

    const { refreshToken } = parsed.data;

    // Verify signature and decode claims (current secret, then previous within grace window).
    let payload: jwt.JwtPayload;
    try {
      payload = verifyJwt(refreshToken);
    } catch (err) {
      logger.warn('[auth] refresh_token_invalid', { reason: err instanceof Error ? err.message : String(err) });
      res.status(401).json({
        success: false,
        error: 'Invalid or expired refresh token',
        code: err instanceof jwt.TokenExpiredError ? ErrorCode.TOKEN_EXPIRED : ErrorCode.TOKEN_INVALID,
      });
      return;
    }

    // Must carry type:'refresh' to prevent access tokens being used here.
    if (payload.type !== 'refresh') {
      res.status(401).json({
        success: false,
        error: 'Token is not a refresh token',
        code: ErrorCode.TOKEN_INVALID,
      });
      return;
    }

    const jti = payload.jti;
    const account = payload.sub;
    const role = payload.role as string | undefined;

    if (!jti || !account) {
      res.status(401).json({
        success: false,
        error: 'Malformed refresh token',
        code: ErrorCode.TOKEN_INVALID,
      });
      return;
    }

    // Check revocation blocklist.
    if (await isTokenRevoked(jti)) {
      logger.warn('[auth] refresh_token_revoked', { jti });
      res.status(401).json({
        success: false,
        error: 'Refresh token has been revoked',
        code: ErrorCode.TOKEN_INVALID,
      });
      return;
    }

    // Rotate: revoke old refresh token jti immediately.
    const expiresAtSeconds = payload.exp ?? Math.floor(Date.now() / 1000) + config.jwtRefreshTtlSeconds;
    await revokeToken(jti, expiresAtSeconds);

    // Re-derive effective role from authoritative state (admin config, validator registry).
    const requestedRole = role ?? 'player';
    const effectiveRole = await resolveEffectiveRole(account, requestedRole, { enforceStrictRoleCheck: true });

    if (effectiveRole !== requestedRole) {
      logger.warn('[auth] auth_role_downgraded', {
        account,
        previousRole: requestedRole,
        newRole: effectiveRole,
      });
      await logAuditEvent({
        action: 'auth_role_downgraded',
        timestamp: new Date().toISOString(),
        wallet: account,
        adminWallet: account,
        queryParams: {
          previousRole: requestedRole,
          newRole: effectiveRole,
        },
      }).catch((auditErr) => {
        logger.error('[auth] failed to record auth_role_downgraded audit event', {
          error: auditErr instanceof Error ? auditErr.message : String(auditErr),
        });
      });
    }

    // Issue new pair with the re-evaluated role.
    const { token: newAccessToken, expiresAt } = issueAccessToken(account, effectiveRole);
    const { token: newRefreshToken } = issueRefreshToken(account, effectiveRole);

    res.json({
      success: true,
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      expiresAt,
    });
  } catch (err) {
    next(err);
  }
}

// ─── POST /auth/logout ─────────────────────────────────────────────────────────

export const logoutSchema = z.object({
  refreshToken: z.string().min(1).optional(),
}).strict().default({});

/**
 * POST /auth/logout
 *
 * Revokes the caller's access token jti (from the bearer header) and,
 * if a refreshToken body param is provided, its jti too.
 */
export async function postLogout(req: Request, res: Response, next: NextFunction): Promise<void> {
try {
    // The access token is already verified by requireAuth middleware.
    // We need to revoke its jti.
    const header = req.headers.authorization ?? '';
    const rawAccessToken = header.startsWith('Bearer ') ? header.slice(7) : '';

    if (rawAccessToken) {
      const decoded = jwt.decode(rawAccessToken) as jwt.JwtPayload | null;
      if (decoded?.jti && decoded.exp) {
        await revokeToken(decoded.jti, decoded.exp);
      }
    }

    // Optionally revoke the refresh token too.
    const parsed = logoutSchema.safeParse(req.body);
    if (parsed.success && parsed.data.refreshToken) {
      let rtPayload: jwt.JwtPayload | undefined;
      try {
        rtPayload = verifyJwt(parsed.data.refreshToken);
      } catch {
        // Invalid refresh token on logout — that's fine, just ignore it.
        logger.debug('[auth] logout: could not verify refresh token (already expired or invalid)');
      }
      if (rtPayload?.jti && rtPayload.exp && rtPayload.type === 'refresh') {
        await revokeToken(rtPayload.jti, rtPayload.exp);
      }
    }

    res.json({ success: true, message: 'Logged out successfully' });
  } catch (err) {
    next(err);
  }
}
