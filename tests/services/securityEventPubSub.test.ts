/**
 * Unit tests for src/services/securityEventPubSub.ts (#1586)
 */

import { EventEmitter } from 'events';
import {
  initSecurityEventSubscriber,
  closeSecurityEventSubscriber,
} from '../../src/services/securityEventPubSub';
import { getRedisClient, getRedisSubscriberClient } from '../../src/services/redis';
import {
  onWalletBlockedRemote,
  onWalletUnblockedRemote,
} from '../../src/services/walletBlocklist';
import { onTokenRevokedRemote } from '../../src/services/tokenBlocklist';
import { logger } from '../../src/utils/logger';

jest.mock('../../src/services/redis', () => ({
  getRedisClient: jest.fn(),
  getRedisSubscriberClient: jest.fn(),
}));

jest.mock('../../src/services/walletBlocklist', () => ({
  onWalletBlockedRemote: jest.fn().mockResolvedValue(undefined),
  onWalletUnblockedRemote: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/tokenBlocklist', () => ({
  onTokenRevokedRemote: jest.fn().mockResolvedValue(undefined),
}));

const mockedGetRedisClient = getRedisClient as jest.Mock;
const mockedGetRedisSubscriberClient = getRedisSubscriberClient as jest.Mock;

class MockSubscriber extends EventEmitter {
  subscribe = jest.fn(async (...args: unknown[]) => {
    const maybeCb = args[args.length - 1];
    if (typeof maybeCb === 'function') {
      maybeCb(null);
    }
    return 3;
  });
  unsubscribe = jest.fn(async () => 'OK');
  quit = jest.fn(async () => 'OK');
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('securityEventPubSub (#1586)', () => {
  beforeEach(async () => {
    await closeSecurityEventSubscriber();
    jest.clearAllMocks();
  });

  it('1. logs info and does not subscribe when Redis client is not configured', async () => {
    mockedGetRedisClient.mockReturnValue(null);
    const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => {});

    await initSecurityEventSubscriber();

    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('Redis not configured; cross-instance security events disabled'),
    );
    expect(mockedGetRedisSubscriberClient).not.toHaveBeenCalled();
    infoSpy.mockRestore();
  });

  it('2. subscribes to the three security event channels when Redis is available', async () => {
    const sub = new MockSubscriber();
    mockedGetRedisClient.mockReturnValue({});
    mockedGetRedisSubscriberClient.mockReturnValue(sub);

    await initSecurityEventSubscriber();

    expect(sub.subscribe).toHaveBeenCalledWith(
      'security:wallet_blocked',
      'security:wallet_unblocked',
      'security:token_revoked',
      expect.any(Function),
    );
  });

  it('3. dispatches security:wallet_blocked messages to onWalletBlockedRemote', async () => {
    const sub = new MockSubscriber();
    mockedGetRedisClient.mockReturnValue({});
    mockedGetRedisSubscriberClient.mockReturnValue(sub);

    await initSecurityEventSubscriber();
    sub.emit('message', 'security:wallet_blocked', JSON.stringify({ wallet: 'GBLOCKEDWALLET123' }));
    await flushMicrotasks();

    expect(onWalletBlockedRemote).toHaveBeenCalledTimes(1);
    expect(onWalletBlockedRemote).toHaveBeenCalledWith('GBLOCKEDWALLET123');
  });

  it('4. dispatches security:wallet_unblocked messages to onWalletUnblockedRemote', async () => {
    const sub = new MockSubscriber();
    mockedGetRedisClient.mockReturnValue({});
    mockedGetRedisSubscriberClient.mockReturnValue(sub);

    await initSecurityEventSubscriber();
    sub.emit('message', 'security:wallet_unblocked', JSON.stringify({ wallet: 'GUNBLOCKEDWALLET456' }));
    await flushMicrotasks();

    expect(onWalletUnblockedRemote).toHaveBeenCalledTimes(1);
    expect(onWalletUnblockedRemote).toHaveBeenCalledWith('GUNBLOCKEDWALLET456');
  });

  it('5. dispatches security:token_revoked messages to onTokenRevokedRemote', async () => {
    const sub = new MockSubscriber();
    mockedGetRedisClient.mockReturnValue({});
    mockedGetRedisSubscriberClient.mockReturnValue(sub);

    await initSecurityEventSubscriber();
    sub.emit('message', 'security:token_revoked', JSON.stringify({ token_hash: 'jti-hash-789' }));
    await flushMicrotasks();

    expect(onTokenRevokedRemote).toHaveBeenCalledTimes(1);
    expect(onTokenRevokedRemote).toHaveBeenCalledWith('jti-hash-789');
  });

  it('6. logs a warning and does not throw when receiving invalid JSON', async () => {
    const sub = new MockSubscriber();
    mockedGetRedisClient.mockReturnValue({});
    mockedGetRedisSubscriberClient.mockReturnValue(sub);
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});

    await initSecurityEventSubscriber();
    sub.emit('message', 'security:wallet_blocked', '{not-valid-json');
    await flushMicrotasks();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('failed to parse message on security:wallet_blocked:'),
      expect.any(SyntaxError),
    );
    expect(onWalletBlockedRemote).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('7. ignores payloads missing the required wallet or token_hash field', async () => {
    const sub = new MockSubscriber();
    mockedGetRedisClient.mockReturnValue({});
    mockedGetRedisSubscriberClient.mockReturnValue(sub);

    await initSecurityEventSubscriber();
    sub.emit('message', 'security:wallet_blocked', JSON.stringify({}));
    sub.emit('message', 'security:wallet_unblocked', JSON.stringify({}));
    sub.emit('message', 'security:token_revoked', JSON.stringify({}));
    await flushMicrotasks();

    expect(onWalletBlockedRemote).not.toHaveBeenCalled();
    expect(onWalletUnblockedRemote).not.toHaveBeenCalled();
    expect(onTokenRevokedRemote).not.toHaveBeenCalled();
  });

  it('8. logs a warning when receiving a message on an unknown channel', async () => {
    const sub = new MockSubscriber();
    mockedGetRedisClient.mockReturnValue({});
    mockedGetRedisSubscriberClient.mockReturnValue(sub);
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});

    await initSecurityEventSubscriber();
    sub.emit('message', 'security:unknown_channel', JSON.stringify({ wallet: 'GABC' }));
    await flushMicrotasks();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('unknown channel: security:unknown_channel'),
    );
    warnSpy.mockRestore();
  });

  it('9. closeSecurityEventSubscriber() unsubscribes, quits, and is idempotent', async () => {
    const sub = new MockSubscriber();
    mockedGetRedisClient.mockReturnValue({});
    mockedGetRedisSubscriberClient.mockReturnValue(sub);

    await initSecurityEventSubscriber();
    await closeSecurityEventSubscriber();

    expect(sub.unsubscribe).toHaveBeenCalledTimes(1);
    expect(sub.quit).toHaveBeenCalledTimes(1);

    // Calling close again is a no-op
    await closeSecurityEventSubscriber();
    expect(sub.unsubscribe).toHaveBeenCalledTimes(1);
    expect(sub.quit).toHaveBeenCalledTimes(1);
  });
});
