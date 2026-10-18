/**
 * Tests for the graphql_enabled feature flag gating of the /graphql endpoint.
 *
 * The flag is read dynamically per request via src/services/featureFlags
 * using the driver-agnostic async `isFeatureEnabled()` (#1516).
 */

jest.mock('../../src/services/featureFlags', () => ({
  ...jest.requireActual('../../src/services/featureFlags'),
  isFeatureEnabled: jest.fn(),
  bootstrapFeatureFlags: jest.fn(),
  GRAPHQL_ENABLED: 'graphql_enabled',
}));

// Stub IPFS and indexer so app.ts imports don't throw
jest.mock('../../src/services/ipfs', () => ({
  pinJson: jest.fn(),
  pinFile: jest.fn(),
  gatewayUrl: jest.fn((cid: string) => `https://gateway.pinata.cloud/ipfs/${cid}`),
  checkHealth: jest.fn().mockResolvedValue(undefined),
}));

import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import app from '../../src/app';
import * as featureFlags from '../../src/services/featureFlags';
import * as db from '../../src/db';
import config from '../../src/config';
import { mountGraphQL } from '../../src/graphql';

const mockIsFeatureEnabled = featureFlags.isFeatureEnabled as jest.Mock;

describe('GET /graphql — feature flag gating', () => {
  afterEach(() => {
    mockIsFeatureEnabled.mockReset();
  });

  it('returns 404 when graphql_enabled flag is OFF', async () => {
    mockIsFeatureEnabled.mockResolvedValue(false);
    const res = await request(app).get('/graphql');
    expect(res.status).toBe(404);
  });

  it('does not expose a GraphQL schema when flag is OFF', async () => {
    mockIsFeatureEnabled.mockResolvedValue(false);
    const res = await request(app)
      .post('/graphql')
      .send({ query: '{ __schema { types { name } } }' })
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(404);
  });

  it('forwards to GraphQL handler (returns non-404) when flag is ON', async () => {
    mockIsFeatureEnabled.mockResolvedValue(true);
    const res = await request(app)
      .post('/graphql')
      .send({ query: '{ __typename }' })
      .set('Content-Type', 'application/json');
    expect(res.status).not.toBe(404);
  });

  it('calls isFeatureEnabled with the GRAPHQL_ENABLED key on each request', async () => {
    mockIsFeatureEnabled.mockResolvedValue(false);
    await request(app).get('/graphql');
    expect(mockIsFeatureEnabled).toHaveBeenCalledWith('graphql_enabled');
  });
});

describe('POST /graphql — feature flag gating', () => {
  afterEach(() => {
    mockIsFeatureEnabled.mockReset();
  });

  it('returns 404 for POST when flag is OFF', async () => {
    mockIsFeatureEnabled.mockResolvedValue(false);
    const res = await request(app)
      .post('/graphql')
      .send({ query: '{ __typename }' })
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(404);
  });
});

describe('GraphQL rate limiting', () => {
  it('limits requests by IP and authenticated wallet', async () => {
    const previousMax = config.rateLimit.max;
    config.rateLimit.max = 1;

    try {
      const rateLimitedApp = express();
      rateLimitedApp.set('trust proxy', true);
      rateLimitedApp.use(express.json());
      mockIsFeatureEnabled.mockResolvedValue(true);
      mountGraphQL(rateLimitedApp);

      const ip = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
      const firstIpRequest = await request(rateLimitedApp)
        .post('/graphql')
        .set('X-Forwarded-For', ip)
        .send({ query: '{ __typename }' });
      const secondIpRequest = await request(rateLimitedApp)
        .post('/graphql')
        .set('X-Forwarded-For', ip)
        .send({ query: '{ __typename }' });

      expect(firstIpRequest.status).not.toBe(429);
      expect(secondIpRequest.status).toBe(429);

      const wallet = `G${Date.now()}WALLET`;
      const walletIp = `198.51.101.${Math.floor(Math.random() * 200) + 1}`;
      const token = jwt.sign({ sub: wallet, role: 'scout' }, config.jwtSecret, {
        expiresIn: '1h',
      });
      const walletLimitedApp = express();
      walletLimitedApp.set('trust proxy', true);
      walletLimitedApp.use(express.json());
      mountGraphQL(walletLimitedApp);

      const firstWalletRequest = await request(walletLimitedApp)
        .post('/graphql')
        .set('X-Forwarded-For', walletIp)
        .set('Authorization', `Bearer ${token}`)
        .send({ query: '{ __typename }' });
      const secondWalletRequest = await request(walletLimitedApp)
        .post('/graphql')
        .set('X-Forwarded-For', `198.51.102.${Math.floor(Math.random() * 200) + 1}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ query: '{ __typename }' });

      expect(firstWalletRequest.status).not.toBe(429);
      expect(secondWalletRequest.status).toBe(429);
    } finally {
      config.rateLimit.max = previousMax;
    }
  });
});

describe('featureFlags service unit tests (#1516)', () => {
  const {
    isEnabled: realIsEnabled,
    isFeatureEnabled: realIsFeatureEnabled,
    setFeatureFlag: realSetFeatureFlag,
    clearFlagCache,
  } = jest.requireActual<typeof import('../../src/services/featureFlags')>(
    '../../src/services/featureFlags',
  );

  beforeEach(() => {
    clearFlagCache();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    clearFlagCache();
  });

  it('returns false for graphql_enabled by default (no DB)', () => {
    const result = realIsEnabled('graphql_enabled');
    expect(result).toBe(false);
  });

  it('serves /graphql under DB_DRIVER=postgres when graphql_enabled=1 without calling getDb()', async () => {
    // Simulate Postgres mode where synchronous getDb() throws, while async getFeatureFlag works
    jest.spyOn(db, 'getDb').mockImplementation(() => {
      throw new Error('getDb() is only available with DB_DRIVER=sqlite');
    });
    const getFeatureFlagSpy = jest.spyOn(db, 'getFeatureFlag').mockResolvedValue({
      name: 'graphql_enabled',
      enabled: 1,
      updated_at: Date.now(),
      updated_by: 'admin',
    });

    mockIsFeatureEnabled.mockImplementation((key: string) => realIsFeatureEnabled(key));

    const res1 = await request(app)
      .post('/graphql')
      .send({ query: '{ __typename }' })
      .set('Content-Type', 'application/json');
    expect(res1.status).toBe(200);
    expect(getFeatureFlagSpy).toHaveBeenCalledTimes(1);

    // Second request hits the in-process cache with zero DB I/O
    const res2 = await request(app)
      .post('/graphql')
      .send({ query: '{ __typename }' })
      .set('Content-Type', 'application/json');
    expect(res2.status).toBe(200);
    expect(getFeatureFlagSpy).toHaveBeenCalledTimes(1);
  });

  it('toggling graphql_enabled via setFeatureFlag takes effect immediately on the next request', async () => {
    jest.spyOn(db, 'getFeatureFlag').mockResolvedValue({
      name: 'graphql_enabled',
      enabled: 0,
      updated_at: Date.now(),
      updated_by: 'seed',
    });
    jest.spyOn(db, 'upsertFeatureFlag').mockResolvedValue(undefined);
    mockIsFeatureEnabled.mockImplementation((key: string) => realIsFeatureEnabled(key));

    const beforeRes = await request(app)
      .post('/graphql')
      .send({ query: '{ __typename }' })
      .set('Content-Type', 'application/json');
    expect(beforeRes.status).toBe(404);

    await realSetFeatureFlag('graphql_enabled', true, 'admin-wallet');
    expect(realIsEnabled('graphql_enabled')).toBe(true);

    const afterRes = await request(app)
      .post('/graphql')
      .send({ query: '{ __typename }' })
      .set('Content-Type', 'application/json');
    expect(afterRes.status).toBe(200);
  });
});

