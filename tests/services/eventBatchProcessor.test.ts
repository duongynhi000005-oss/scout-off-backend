/**
 * tests/services/eventBatchProcessor.test.ts
 *
 * Dedicated unit tests for src/services/eventBatchProcessor.ts (#1588).
 */

import {
  processEventBatches,
  type BatchProcessorProgress,
} from '../../src/services/eventBatchProcessor';
import { initDb, getDb } from '../../src/db';

const mockGetEvents = jest.fn();

jest.mock('../../src/services/stellar', () => ({
  server: {
    getEvents: (...args: unknown[]) => mockGetEvents(...args),
  },
}));

jest.mock('../../src/services/audit', () => ({
  logAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/indexer', () => ({
  normalizeEventId: jest.fn(
    (contractId: string, ledger: number, txHash: string, eventIndex: number) =>
      `${contractId}:${ledger}:${txHash}:${eventIndex}`,
  ),
  normalizeSorobanEvent: jest.fn((raw: { typeName?: string; payloadData?: Record<string, unknown> }) => ({
    type: raw.typeName ?? 'player_registered',
    payload: raw.payloadData ?? {},
  })),
}));

function makeRawEvent(overrides: {
  ledger: number;
  txHash: string;
  txIndex?: number;
  eventIndex?: number;
  id?: string;
  typeName?: string;
  payloadData?: Record<string, unknown>;
  ledgerClosedAt?: string;
}) {
  return {
    ledger: overrides.ledger,
    txHash: overrides.txHash,
    txIndex: overrides.txIndex ?? 1,
    eventIndex: overrides.eventIndex ?? 0,
    id: overrides.id ?? `0000${overrides.ledger}-${overrides.txIndex ?? 1}-${overrides.eventIndex ?? 0}`,
    typeName: overrides.typeName ?? 'player_registered',
    payloadData: overrides.payloadData ?? { wallet: 'GABC' },
    topic: [],
    value: {},
    ledgerClosedAt: overrides.ledgerClosedAt ?? '2026-01-01T00:00:00Z',
  };
}

describe('eventBatchProcessor (#1588)', () => {
  beforeAll(async () => {
    await initDb();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    const db = getDb();
    db.prepare('DELETE FROM events').run();

    const indexerModule = require('../../src/services/indexer');
    indexerModule.normalizeSorobanEvent.mockImplementation(
      (raw: { typeName?: string; payloadData?: Record<string, unknown> }) => ({
        type: raw.typeName ?? 'player_registered',
        payload: raw.payloadData ?? {},
      }),
    );
  });

  it('1. makes a single RPC call when the ledger range is smaller than batchSize', async () => {
    mockGetEvents.mockResolvedValueOnce({
      events: [
        makeRawEvent({ ledger: 102, txHash: 'tx-single-1' }),
        // Event outside [100, 105] should be filtered out
        makeRawEvent({ ledger: 110, txHash: 'tx-out-of-range' }),
      ],
    });

    const result = await processEventBatches({
      fromLedger: 100,
      toLedger: 105,
      batchSize: 50,
      batchDelayMs: 0,
      adminWallet: 'GADMIN',
    });

    expect(mockGetEvents).toHaveBeenCalledTimes(1);
    expect(mockGetEvents).toHaveBeenCalledWith(
      expect.objectContaining({ startLedger: 100 }),
    );
    expect(result).toEqual({
      eventsInserted: 1,
      ledgersProcessed: 6,
    });
  });

  it('2. spans three batches with exact startLedger values and no gaps or overlaps', async () => {
    mockGetEvents
      .mockResolvedValueOnce({ events: [makeRawEvent({ ledger: 100, txHash: 'tx-b1' })] })
      .mockResolvedValueOnce({ events: [makeRawEvent({ ledger: 110, txHash: 'tx-b2' })] })
      .mockResolvedValueOnce({ events: [makeRawEvent({ ledger: 120, txHash: 'tx-b3' })] });

    const progressUpdates: BatchProcessorProgress[] = [];

    const result = await processEventBatches({
      fromLedger: 100,
      toLedger: 124,
      batchSize: 10,
      batchDelayMs: 1,
      adminWallet: 'GADMIN',
      onProgress: (p) => progressUpdates.push(p),
    });

    expect(mockGetEvents).toHaveBeenCalledTimes(3);
    expect(mockGetEvents.mock.calls[0][0].startLedger).toBe(100);
    expect(mockGetEvents.mock.calls[1][0].startLedger).toBe(110);
    expect(mockGetEvents.mock.calls[2][0].startLedger).toBe(120);

    expect(progressUpdates.map((p) => [p.currentBatchStart, p.currentBatchEnd])).toEqual([
      [100, 109],
      [110, 119],
      [120, 124],
    ]);
    expect(result).toEqual({
      eventsInserted: 3,
      ledgersProcessed: 25,
    });
  });

  it('3. normalizes and inserts out-of-order events in deterministic total order', async () => {
    mockGetEvents.mockResolvedValueOnce({
      events: [
        makeRawEvent({ ledger: 205, txHash: 'tx-late', txIndex: 2, eventIndex: 1 }),
        makeRawEvent({ ledger: 201, txHash: 'tx-early-b', txIndex: 2, eventIndex: 0 }),
        makeRawEvent({ ledger: 201, txHash: 'tx-early-a', txIndex: 1, eventIndex: 0 }),
      ],
    });

    await processEventBatches({
      fromLedger: 200,
      toLedger: 210,
      batchSize: 20,
      batchDelayMs: 0,
      adminWallet: 'GADMIN',
    });

    const rows = getDb()
      .prepare('SELECT tx_hash, ledger, tx_application_order, event_index FROM events ORDER BY id ASC')
      .all() as Array<{ tx_hash: string; ledger: number }>;

    expect(rows.map((r) => r.tx_hash)).toEqual([
      'tx-early-a',
      'tx-early-b',
      'tx-late',
    ]);
  });

  it('4. deduplicates identical events across batches via INSERT OR IGNORE', async () => {
    const dupEvent = makeRawEvent({
      ledger: 300,
      txHash: 'tx-duplicate-hash',
      txIndex: 1,
      eventIndex: 0,
    });

    // First run inserts the event
    mockGetEvents.mockResolvedValueOnce({ events: [dupEvent] });
    const first = await processEventBatches({
      fromLedger: 300,
      toLedger: 305,
      batchSize: 10,
      batchDelayMs: 0,
      adminWallet: 'GADMIN',
    });
    expect(first.eventsInserted).toBe(1);

    // Second run over the same range returns the exact same event
    mockGetEvents.mockResolvedValueOnce({ events: [dupEvent] });
    const second = await processEventBatches({
      fromLedger: 300,
      toLedger: 305,
      batchSize: 10,
      batchDelayMs: 0,
      adminWallet: 'GADMIN',
    });
    expect(second.eventsInserted).toBe(0);

    const count = getDb()
      .prepare('SELECT COUNT(*) as cnt FROM events WHERE tx_hash = ?')
      .get('tx-duplicate-hash') as { cnt: number };
    expect(count.cnt).toBe(1);
  });

  it('5. continues to the next batch when an intermediate batch returns empty events', async () => {
    mockGetEvents
      .mockResolvedValueOnce({ events: [] })
      .mockResolvedValueOnce({ events: [makeRawEvent({ ledger: 412, txHash: 'tx-after-empty' })] });

    const result = await processEventBatches({
      fromLedger: 400,
      toLedger: 419,
      batchSize: 10,
      batchDelayMs: 0,
      adminWallet: 'GADMIN',
    });

    expect(mockGetEvents).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      eventsInserted: 1,
      ledgersProcessed: 20,
    });
  });

  it('6. logs and skips transient RPC errors on a batch, and reports fatal processing errors in result.error', async () => {
    // Contract: transient RPC errors on a single batch are caught, logged as a warning,
    // and the processor advances to the next batch without aborting.
    mockGetEvents
      .mockRejectedValueOnce(new Error('RPC timeout on batch 1'))
      .mockResolvedValueOnce({ events: [makeRawEvent({ ledger: 515, txHash: 'tx-batch-2-ok' })] });

    const partialResult = await processEventBatches({
      fromLedger: 500,
      toLedger: 519,
      batchSize: 10,
      batchDelayMs: 0,
      adminWallet: 'GADMIN',
    });

    expect(mockGetEvents).toHaveBeenCalledTimes(2);
    expect(partialResult).toEqual({
      eventsInserted: 1,
      ledgersProcessed: 20,
    });

    // Fatal error inside normalization/DB transaction is caught by the outer try/catch
    // and returned in result.error.
    const indexerModule = require('../../src/services/indexer');
    indexerModule.normalizeSorobanEvent.mockImplementationOnce(() => {
      throw new Error('Fatal normalization failure');
    });
    mockGetEvents.mockResolvedValueOnce({
      events: [makeRawEvent({ ledger: 600, txHash: 'tx-fatal' })],
    });

    const fatalResult = await processEventBatches({
      fromLedger: 600,
      toLedger: 609,
      batchSize: 10,
      batchDelayMs: 0,
      adminWallet: 'GADMIN',
    });

    expect(fatalResult.error).toBe('Fatal normalization failure');
    expect(fatalResult.eventsInserted).toBe(0);
  });

  it('7. invokes onProgress after each batch with accurate cumulative counts', async () => {
    mockGetEvents
      .mockResolvedValueOnce({
        events: [
          makeRawEvent({ ledger: 701, txHash: 'tx-p1', ledgerClosedAt: '' }),
          makeRawEvent({ ledger: 702, txHash: 'tx-p2' }),
        ],
      })
      .mockResolvedValueOnce({
        events: [makeRawEvent({ ledger: 715, txHash: 'tx-p3' })],
      });

    const onProgress = jest.fn();

    const result = await processEventBatches({
      fromLedger: 700,
      toLedger: 719,
      batchSize: 10,
      batchDelayMs: 0,
      adminWallet: 'GADMIN',
      onProgress,
    });

    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenNthCalledWith(1, {
      ledgersProcessed: 10,
      ledgersTotal: 20,
      eventsInserted: 2,
      currentBatchStart: 700,
      currentBatchEnd: 709,
    });
    expect(onProgress).toHaveBeenNthCalledWith(2, {
      ledgersProcessed: 20,
      ledgersTotal: 20,
      eventsInserted: 3,
      currentBatchStart: 710,
      currentBatchEnd: 719,
    });
    expect(result.eventsInserted).toBe(3);
  });
});
