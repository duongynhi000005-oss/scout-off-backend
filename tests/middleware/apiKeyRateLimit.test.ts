/**
 * Unit tests for src/middleware/apiKeyRateLimit.ts (#1587)
 */

import { Request, Response, NextFunction } from 'express';
import {
  apiKeyRateLimit,
  _clearApiKeyRateLimitCache,
} from '../../src/middleware/apiKeyRateLimit';
import { getRedisClient } from '../../src/services/redis';
import { getApiKeyRateLimits } from '../../src/db/apiKeyHelpers';
import { logger } from '../../src/utils/logger';

jest.mock('../../src/services/redis', () => ({
  getRedisClient: jest.fn(),
}));

jest.mock('../../src/db/apiKeyHelpers', () => ({
  getApiKeyRateLimits: jest.fn(),
}));

const mockedGetRedisClient = getRedisClient as jest.Mock;
const mockedGetApiKeyRateLimits = getApiKeyRateLimits as jest.Mock;

function createMockRedis() {
  const counters = new Map<string, number>();
  return {
    counters,
    incr: jest.fn(async (key: string) => {
      const nextVal = (counters.get(key) ?? 0) + 1;
      counters.set(key, nextVal);
      return nextVal;
    }),
    expire: jest.fn(async () => 1),
  };
}

function createMockReqRes(apiKeyId?: number) {
  const req = { apiKeyId } as unknown as Request;
  const headers: Record<string, string> = {};
  const res = {
    headers,
    set: jest.fn((k: string, v: string) => {
      headers[k] = v;
      return res;
    }),
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response & { headers: Record<string, string> };
  const next = jest.fn() as NextFunction;
  return { req, res, next };
}

describe('apiKeyRateLimit middleware (#1587)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _clearApiKeyRateLimitCache();
    jest.useRealTimers();
  });

  it('1. calls next() immediately without touching Redis when req.apiKeyId is not set', async () => {
    const redis = createMockRedis();
    mockedGetRedisClient.mockReturnValue(redis);

    const { req, res, next } = createMockReqRes(undefined);
    await apiKeyRateLimit(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(mockedGetRedisClient).not.toHaveBeenCalled();
    expect(mockedGetApiKeyRateLimits).not.toHaveBeenCalled();
    expect(redis.incr).not.toHaveBeenCalled();
  });

  it('2. allows requests 1-2 and returns 429 API_KEY_RATE_LIMIT_EXCEEDED on request 3 when limit is 2/min', async () => {
    const redis = createMockRedis();
    mockedGetRedisClient.mockReturnValue(redis);
    mockedGetApiKeyRateLimits.mockResolvedValue({
      rate_limit_per_minute: 2,
      monthly_quota: null,
    });

    const r1 = createMockReqRes(42);
    await apiKeyRateLimit(r1.req, r1.res, r1.next);
    expect(r1.next).toHaveBeenCalledTimes(1);
    expect(r1.res.headers['RateLimit-Limit']).toBe('2');
    expect(r1.res.headers['RateLimit-Remaining']).toBe('1');

    const r2 = createMockReqRes(42);
    await apiKeyRateLimit(r2.req, r2.res, r2.next);
    expect(r2.next).toHaveBeenCalledTimes(1);
    expect(r2.res.headers['RateLimit-Remaining']).toBe('0');

    const r3 = createMockReqRes(42);
    await apiKeyRateLimit(r3.req, r3.res, r3.next);
    expect(r3.next).not.toHaveBeenCalled();
    expect(r3.res.status).toHaveBeenCalledWith(429);
    expect(r3.res.headers['RateLimit-Limit']).toBe('2');
    expect(r3.res.headers['RateLimit-Remaining']).toBe('0');
    expect(r3.res.json).toHaveBeenCalledWith({
      success: false,
      error: 'API key rate limit exceeded',
      code: 'API_KEY_RATE_LIMIT_EXCEEDED',
    });
  });

  it('3. sets a 60-second expiry only on the first request in a minute window', async () => {
    const redis = createMockRedis();
    mockedGetRedisClient.mockReturnValue(redis);
    mockedGetApiKeyRateLimits.mockResolvedValue({
      rate_limit_per_minute: 5,
      monthly_quota: null,
    });

    const r1 = createMockReqRes(7);
    await apiKeyRateLimit(r1.req, r1.res, r1.next);
    expect(redis.expire).toHaveBeenCalledTimes(1);
    expect(redis.expire).toHaveBeenCalledWith('apikey:ratelimit:7:minute', 60);

    const r2 = createMockReqRes(7);
    await apiKeyRateLimit(r2.req, r2.res, r2.next);
    expect(redis.expire).toHaveBeenCalledTimes(1);
  });

  it('4. fails open with a warning when Redis client is unavailable', async () => {
    mockedGetRedisClient.mockReturnValue(null);
    mockedGetApiKeyRateLimits.mockResolvedValue({
      rate_limit_per_minute: 10,
      monthly_quota: 100,
    });
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});

    const { req, res, next } = createMockReqRes(99);
    await apiKeyRateLimit(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Redis unavailable for rate limiting on key 99'),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Redis unavailable for quota tracking on key 99'),
    );
    warnSpy.mockRestore();
  });

  it('5. caches key rate-limit config for 5 minutes before re-querying DB', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-05-01T12:00:00.000Z'));

    const redis = createMockRedis();
    mockedGetRedisClient.mockReturnValue(redis);
    mockedGetApiKeyRateLimits.mockResolvedValue({
      rate_limit_per_minute: 10,
      monthly_quota: null,
    });

    const r1 = createMockReqRes(15);
    await apiKeyRateLimit(r1.req, r1.res, r1.next);

    // Advance 4 minutes (< 5 min TTL): should use cached config
    jest.advanceTimersByTime(4 * 60 * 1000);
    const r2 = createMockReqRes(15);
    await apiKeyRateLimit(r2.req, r2.res, r2.next);
    expect(mockedGetApiKeyRateLimits).toHaveBeenCalledTimes(1);

    // Advance past 5 minutes: should re-fetch from DB
    jest.advanceTimersByTime(2 * 60 * 1000);
    const r3 = createMockReqRes(15);
    await apiKeyRateLimit(r3.req, r3.res, r3.next);
    expect(mockedGetApiKeyRateLimits).toHaveBeenCalledTimes(2);
  });

  it('6. formats monthly quota Redis keys as YYYY-MM in UTC across month boundaries', async () => {
    jest.useFakeTimers();
    const redis = createMockRedis();
    mockedGetRedisClient.mockReturnValue(redis);
    mockedGetApiKeyRateLimits.mockResolvedValue({
      rate_limit_per_minute: null,
      monthly_quota: 50,
    });

    // End of January UTC
    jest.setSystemTime(new Date('2026-01-31T23:59:59.000Z'));
    const rJan = createMockReqRes(21);
    await apiKeyRateLimit(rJan.req, rJan.res, rJan.next);
    expect(redis.incr).toHaveBeenLastCalledWith('apikey:quota:21:2026-01');

    // Start of February UTC
    jest.setSystemTime(new Date('2026-02-01T00:00:00.000Z'));
    const rFeb = createMockReqRes(21);
    await apiKeyRateLimit(rFeb.req, rFeb.res, rFeb.next);
    expect(redis.incr).toHaveBeenLastCalledWith('apikey:quota:21:2026-02');
  });

  it('7. returns 429 API_KEY_QUOTA_EXCEEDED when monthly quota is exceeded', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-15T10:00:00.000Z'));

    const redis = createMockRedis();
    mockedGetRedisClient.mockReturnValue(redis);
    mockedGetApiKeyRateLimits.mockResolvedValue({
      rate_limit_per_minute: null,
      monthly_quota: 2,
    });

    const r1 = createMockReqRes(33);
    await apiKeyRateLimit(r1.req, r1.res, r1.next);
    expect(r1.next).toHaveBeenCalledTimes(1);
    expect(redis.expire).toHaveBeenCalledWith(
      'apikey:quota:33:2026-07',
      32 * 24 * 60 * 60,
    );

    const r2 = createMockReqRes(33);
    await apiKeyRateLimit(r2.req, r2.res, r2.next);
    expect(r2.next).toHaveBeenCalledTimes(1);

    const r3 = createMockReqRes(33);
    await apiKeyRateLimit(r3.req, r3.res, r3.next);
    expect(r3.next).not.toHaveBeenCalled();
    expect(r3.res.status).toHaveBeenCalledWith(429);
    expect(r3.res.json).toHaveBeenCalledWith({
      success: false,
      error: 'API key monthly quota exceeded',
      code: 'API_KEY_QUOTA_EXCEEDED',
    });
  });
});
