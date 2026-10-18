import config from '../../src/config';
import * as db from '../../src/db';
import {
  isDeadLetterJobRunning,
  stopDeadLetterRetryJob,
} from '../../src/services/webhookDeadLetterJob';
import {
  getWebhookCounters,
  incrementWebhookDeliveriesPrunedTotal,
  resetMetrics,
  serializeMetrics,
} from '../../src/middleware/metrics';

jest.mock('../../src/tracing', () => ({
  initTracing: jest.fn(),
  shutdownTracing: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/app', () => ({
  __esModule: true,
  default: {
    listen: jest.fn((_port: number, cb?: () => void) => {
      if (cb) cb();
      return {
        close: jest.fn((closeCb?: (err?: Error) => void) => {
          if (closeCb) closeCb();
        }),
        closeIdleConnections: jest.fn(),
      };
    }),
  },
  setDraining: jest.fn(),
}));

jest.mock('../../src/db', () => ({
  initDb: jest.fn().mockResolvedValue(undefined),
  closeDb: jest.fn().mockResolvedValue(undefined),
  fetchLastIndexedLedger: jest.fn().mockReturnValue(0),
  persistLastIndexedLedger: jest.fn(),
  pruneWebhookDeliveries: jest.fn().mockResolvedValue(3),
  countWebhookDeadLetters: jest.fn().mockReturnValue(0),
  countWebhookDeadLettersBySubscription: jest.fn().mockReturnValue([]),
  listWebhookDeadLetters: jest.fn().mockReturnValue([]),
  listWebhookSubscriptions: jest.fn().mockReturnValue([]),
}));

jest.mock('../../src/services/stellar', () => ({
  stellarHealth: jest.fn().mockResolvedValue(true),
}));

jest.mock('../../src/services/ipfs', () => ({
  checkHealth: jest.fn().mockResolvedValue(undefined),
  retryPendingPins: jest.fn().mockResolvedValue(undefined),
  reconcilePendingPins: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/indexer', () => ({
  indexEvents: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/tierDivergenceJob', () => ({
  runTierDivergenceCheck: jest.fn().mockResolvedValue(undefined),
  getTierDivergenceTotal: jest.fn().mockReturnValue(0),
}));

jest.mock('../../src/services/cache', () => ({
  initCacheInvalidationSubscriber: jest.fn().mockResolvedValue(undefined),
  closeCacheInvalidationSubscriber: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/securityEventPubSub', () => ({
  initSecurityEventSubscriber: jest.fn().mockResolvedValue(undefined),
  closeSecurityEventSubscriber: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/redis', () => ({
  getRedisClient: jest.fn().mockReturnValue(null),
  closeRedisClients: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/routes/events', () => ({
  drainAllSessions: jest.fn(),
  setAcceptingSseSessions: jest.fn(),
}));

import { startServer } from '../../src/index';

describe('webhook housekeeping startup & shutdown (#1524)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    stopDeadLetterRetryJob();
    resetMetrics();
  });

  afterEach(() => {
    stopDeadLetterRetryJob();
    jest.useRealTimers();
  });

  it('starts the DLQ retry job and schedules periodic webhook_deliveries pruning, and stops both on shutdown', async () => {
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const origPruneInterval = config.webhookDeliveryPruneIntervalMs;
    (config as { webhookDeliveryPruneIntervalMs: number }).webhookDeliveryPruneIntervalMs = 2000;
    try {
      const { shutdown } = await startServer();

      expect(isDeadLetterJobRunning()).toBe(true);
      expect(db.pruneWebhookDeliveries).not.toHaveBeenCalled();

      // Advance past one prune interval and flush async job tracking microtasks
      await jest.advanceTimersByTimeAsync(2000);

      expect(db.pruneWebhookDeliveries).toHaveBeenCalledTimes(1);
      expect(db.pruneWebhookDeliveries).toHaveBeenCalledWith(
        config.webhookDeliveryRetentionDays * 24 * 60 * 60 * 1000,
      );

      // Graceful shutdown stops both schedulers
      await shutdown('SIGTERM');

      expect(isDeadLetterJobRunning()).toBe(false);

      const callsAfterShutdown = (db.pruneWebhookDeliveries as jest.Mock).mock.calls.length;
      await jest.advanceTimersByTimeAsync(4000);
      expect(db.pruneWebhookDeliveries).toHaveBeenCalledTimes(callsAfterShutdown);
    } finally {
      (config as { webhookDeliveryPruneIntervalMs: number }).webhookDeliveryPruneIntervalMs = origPruneInterval;
      exitSpy.mockRestore();
    }
  });

  it('exposes scout_off_webhook_deliveries_pruned_total in Prometheus metrics output', () => {
    incrementWebhookDeliveriesPrunedTotal(7);
    expect(getWebhookCounters().deliveriesPrunedTotal).toBe(7);

    const output = serializeMetrics();
    expect(output).toContain('scout_off_webhook_deliveries_pruned_total 7');
  });
});
