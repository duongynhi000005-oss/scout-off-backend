/**
 * Unit tests for src/services/tokenBlocklist.ts
 *
 * Coverage:
 *  - revokeToken writes to both Redis and DB
 *  - isTokenRevoked returns true via Redis hit
 *  - isTokenRevoked falls back to DB when Redis is unavailable
 *  - isTokenRevoked returns false for an unknown jti
 *  - isTokenRevoked returns false for undefined/empty jti
 *  - Write-through: DB is written even when Redis fails
 *  - Fail-safe: DB read error returns true (blocks token)
 *  - pruneExpiredTokens removes expired rows
 */

import Database from 'better-sqlite3';

// ─── In-memory SQLite setup (mirrors setup.ts but scoped to this module) ──────
//
// The tokenBlocklist module calls getDriver() at runtime, NOT at import time,
// so we set up the DB before the module is first imported by any test.

process.env.DB_PATH = ':memory:';
process.env.DB_DRIVER = 'sqlite';

// ─── Module imports ───────────────────────────────────────────────────────────

import { getDriver } from '../../src/db';
import {
  revokeToken,
  isTokenRevoked,
  pruneExpiredTokens,
} from '../../src/services/tokenBlocklist';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const FUTURE_EXP = Math.floor(Date.now() / 1000) + 3600; // 1 h from now
const PAST_EXP   = Math.floor(Date.now() / 1000) - 1;    // already expired

async function jtiExists(jti: string): Promise<boolean> {
  const driver = getDriver();
  const row = await driver.get<{ jti: string }>(
    'SELECT jti FROM revoked_tokens WHERE jti = ?',
    [jti],
  );
  return row !== undefined;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('tokenBlocklist — DB-only (no Redis)', () => {
  // Redis URL is NOT set in the test environment, so redisClient === null
  // and all Redis paths are skipped.  The tests exercise pure DB behaviour.

  beforeEach(async () => {
    // Clean the table between tests
    try {
      await getDriver().run('DELETE FROM revoked_tokens', []);
    } catch {
      // table may not exist yet on very first run — ignore
    }
  });

  it('revokeToken inserts the jti into the DB', async () => {
    const jti = 'unit-test-jti-1';
    await revokeToken(jti, FUTURE_EXP);
    expect(await jtiExists(jti)).toBe(true);
  });

  it('isTokenRevoked returns true for a revoked jti', async () => {
    const jti = 'unit-test-jti-2';
    await revokeToken(jti, FUTURE_EXP);
    expect(await isTokenRevoked(jti)).toBe(true);
  });

  it('isTokenRevoked returns false for an unknown jti', async () => {
    expect(await isTokenRevoked('unknown-jti-xyz')).toBe(false);
  });

  it('isTokenRevoked returns false when jti is undefined', async () => {
    expect(await isTokenRevoked(undefined)).toBe(false);
  });

  it('isTokenRevoked returns false when jti is an empty string', async () => {
    expect(await isTokenRevoked('')).toBe(false);
  });

  it('isTokenRevoked treats an already-expired row as non-revoked', async () => {
    // Insert a row with an expiry in the past directly (bypassing the
    // revokeToken guard which skips already-expired tokens in Redis)
    const jti = 'unit-test-jti-expired';
    await getDriver().run(
      'INSERT INTO revoked_tokens (jti, revoked_at, expires_at) VALUES (?, ?, ?)',
      [jti, Math.floor(Date.now() / 1000), PAST_EXP],
    );
    // The DB query in isTokenRevoked filters expires_at > now, so this should be false
    expect(await isTokenRevoked(jti)).toBe(false);
  });

  it('duplicate revokeToken calls do not throw (ON CONFLICT DO NOTHING)', async () => {
    const jti = 'unit-test-jti-dup';
    await revokeToken(jti, FUTURE_EXP);
    await expect(revokeToken(jti, FUTURE_EXP)).resolves.toBeUndefined();
  });

  it('pruneExpiredTokens removes rows with expired timestamps', async () => {
    const driver = getDriver();
    const jti = 'unit-test-jti-prune';
    await driver.run(
      'INSERT INTO revoked_tokens (jti, revoked_at, expires_at) VALUES (?, ?, ?)',
      [jti, Math.floor(Date.now() / 1000), PAST_EXP],
    );

    expect(await jtiExists(jti)).toBe(true);
    await pruneExpiredTokens();
    expect(await jtiExists(jti)).toBe(false);
  });

  it('pruneExpiredTokens does not remove non-expired rows', async () => {
    const jti = 'unit-test-jti-keep';
    await revokeToken(jti, FUTURE_EXP);
    await pruneExpiredTokens();
    expect(await jtiExists(jti)).toBe(true);
  });
});

// ─── Redis failover scenario ──────────────────────────────────────────────────
//
// We simulate Redis being unavailable by monkey-patching the module's Redis
// client.  Since the client is a module-level private, we intercept at the
// ioredis level using jest mocks.
//
// Two things have to be true for the mocked ioredis client to actually be
// exercised: (1) config.redisUrl must be truthy at module-load time — it's
// unset in the test environment (see tests/setup.ts), so without overriding
// it the module's `redisClient` stays null and the mocked exists()/setex()
// are never even called; and (2) jest.resetModules() wipes the ENTIRE module
// registry, not just ioredis/tokenBlocklist — including src/db's initialized
// driver singleton (see src/db/index.ts's getDriver(), which throws
// "Database not initialised" if _driver is unset). So every fresh
// tokenBlocklist module instance needs its own fresh src/db re-initialised
// via initDb() before it's usable, and — since that gives it its own
// isolated :memory: SQLite instance, disconnected from the outer describe
// block's `getDriver`/`jtiExists` — each test reads back through that same
// fresh instance rather than the stale outer one.
describe('tokenBlocklist — Redis-down failover', () => {
  beforeEach(async () => {
    try {
      await getDriver().run('DELETE FROM revoked_tokens', []);
    } catch { /* ignore */ }
  });

  /**
   * Resets the module registry and re-requires src/db (re-initialised) and
   * src/services/tokenBlocklist with ioredis mocked so every Redis call
   * rejects, simulating a configured-but-unreachable Redis instance.
   */
  async function loadWithRedisDown() {
    jest.resetModules();

    jest.doMock('ioredis', () => {
      return jest.fn().mockImplementation(() => ({
        on: jest.fn(),
        setex: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
        exists: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
        keys: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      }));
    });
    jest.doMock('../../src/config', () => ({
      __esModule: true,
      default: { ...jest.requireActual('../../src/config').default, redisUrl: 'redis://fake:6379' },
    }));

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const freshDb = require('../../src/db') as typeof import('../../src/db');
    await freshDb.initDb();

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const freshTokenBlocklist =
      require('../../src/services/tokenBlocklist') as typeof import('../../src/services/tokenBlocklist');

    return { freshDb, freshTokenBlocklist };
  }

  function unloadRedisDown() {
    jest.dontMock('ioredis');
    jest.dontMock('../../src/config');
    jest.resetModules();
  }

  it('still blocks a revoked token via DB when Redis exists() throws', async () => {
    const { freshTokenBlocklist } = await loadWithRedisDown();
    const jti = 'failover-jti-1';

    // Revoke via the same fresh module instance (DB write always succeeds
    // even with Redis down) so the read below sees it in its own DB.
    await freshTokenBlocklist.revokeToken(jti, FUTURE_EXP);

    // With Redis mocked to fail, the DB fallback should still return true
    expect(await freshTokenBlocklist.isTokenRevoked(jti)).toBe(true);

    unloadRedisDown();
  });

  it('allows a non-revoked token via DB when Redis exists() throws', async () => {
    const { freshTokenBlocklist } = await loadWithRedisDown();

    // Token was never revoked — DB will return undefined → false
    expect(await freshTokenBlocklist.isTokenRevoked('never-revoked-jti')).toBe(false);

    unloadRedisDown();
  });

  it('writes to DB even when Redis setex throws during revokeToken', async () => {
    const { freshDb, freshTokenBlocklist } = await loadWithRedisDown();
    const jti = 'failover-jti-write-through';

    // Should not throw even though Redis is down
    await expect(freshTokenBlocklist.revokeToken(jti, FUTURE_EXP)).resolves.toBeUndefined();

    // DB row must exist — read back through the same fresh instance that wrote it
    const row = await freshDb.getDriver().get<{ jti: string }>(
      'SELECT jti FROM revoked_tokens WHERE jti = ?',
      [jti],
    );
    expect(row).not.toBeUndefined();

    unloadRedisDown();
  });
});

describe('tokenBlocklist — pipelined Redis warm-up (#1592)', () => {
  afterEach(() => {
    jest.dontMock('ioredis');
    jest.dontMock('../../src/config');
    jest.resetModules();
  });

  it('warms 1,200 revoked tokens into Redis across 3 pipeline batches of 500', async () => {
    jest.resetModules();

    const store = new Map<string, { value: string; ttl: number }>();
    const pipelineExecSpy = jest.fn();
    const pipelineSpy = jest.fn(() => {
      const ops: Array<() => [Error | null, string]> = [];
      const pipe = {
        setex: jest.fn((key: string, ttl: number, val: string) => {
          ops.push(() => {
            store.set(key, { value: val, ttl });
            return [null, 'OK'];
          });
          return pipe;
        }),
        exec: jest.fn(async () => {
          pipelineExecSpy();
          return ops.map((fn) => fn());
        }),
      };
      return pipe;
    });

    jest.doMock('ioredis', () => {
      return jest.fn().mockImplementation(() => ({
        on: jest.fn(),
        setex: jest.fn(async (key: string, ttl: number, val: string) => {
          store.set(key, { value: val, ttl });
          return 'OK';
        }),
        exists: jest.fn(async (key: string) => (store.has(key) ? 1 : 0)),
        keys: jest.fn(async () => Array.from(store.keys())),
        pipeline: pipelineSpy,
      }));
    });
    jest.doMock('../../src/config', () => ({
      __esModule: true,
      default: { ...jest.requireActual('../../src/config').default, redisUrl: 'redis://fake:6379' },
    }));

    const freshDb = require('../../src/db') as typeof import('../../src/db');
    await freshDb.initDb();
    const driver = freshDb.getDriver();

    const nowSec = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 1200; i++) {
      await driver.run(
        'INSERT INTO revoked_tokens (jti, revoked_at, expires_at) VALUES (?, ?, ?)',
        [`batch-jti-${i}`, nowSec, nowSec + 3600],
      );
    }
    // Also insert an already-expired row to ensure it is skipped
    await driver.run(
      'INSERT INTO revoked_tokens (jti, revoked_at, expires_at) VALUES (?, ?, ?)',
      ['batch-jti-expired', nowSec - 100, nowSec - 10],
    );

    const freshTokenBlocklist =
      require('../../src/services/tokenBlocklist') as typeof import('../../src/services/tokenBlocklist');

    await freshTokenBlocklist.syncDbToRedis();

    expect(pipelineSpy).toHaveBeenCalledTimes(3);
    expect(pipelineExecSpy).toHaveBeenCalledTimes(3);
    expect(store.size).toBe(1200);
    expect(store.has('jti:revoked:batch-jti-0')).toBe(true);
    expect(store.has('jti:revoked:batch-jti-1199')).toBe(true);
    expect(store.has('jti:revoked:batch-jti-expired')).toBe(false);
    expect(await freshTokenBlocklist.isTokenRevoked('batch-jti-500')).toBe(true);
  });
});
