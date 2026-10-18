#!/usr/bin/env npx ts-node

import 'dotenv/config';
import {
  closeDb,
  getPlayersMissingOnChainId,
  initDb,
  setPlayerOnChainId,
} from '../src/db';
import { queryOnChainPlayerId } from '../src/services/stellar';

const DEFAULT_BATCH_SIZE = 100;

export function parseBackfillArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): {
  dryRun: boolean;
  batchSize: number;
} {
  const dryRun = argv.includes('--dry-run') || env.DRY_RUN === 'true';
  const batchFlag = argv.find((arg) => arg.startsWith('--batch-size='));
  const rawBatchSize = batchFlag ? batchFlag.slice('--batch-size='.length) : env.BACKFILL_BATCH_SIZE;
  const parsedBatch = rawBatchSize ? Number.parseInt(rawBatchSize, 10) : DEFAULT_BATCH_SIZE;
  const batchSize = Number.isFinite(parsedBatch) && parsedBatch > 0 ? parsedBatch : DEFAULT_BATCH_SIZE;
  return { dryRun, batchSize };
}

async function main(): Promise<void> {
  const { dryRun, batchSize } = parseBackfillArgs(process.argv.slice(2));
  await initDb();
  let afterPlayerId = '';
  let linked = 0;
  let pending = 0;

  try {
    for (;;) {
      const players = await getPlayersMissingOnChainId(afterPlayerId, batchSize);
      if (players.length === 0) break;

      for (const player of players) {
        const onChainPlayerId = await queryOnChainPlayerId(player.wallet);
        if (onChainPlayerId === null) {
          pending += 1;
        } else {
          if (!dryRun) {
            await setPlayerOnChainId(player.player_id, onChainPlayerId);
          }
          linked += 1;
        }
      }
      afterPlayerId = players[players.length - 1].player_id;
    }

    // eslint-disable-next-line no-console
    console.info(
      `Player ID backfill complete${dryRun ? ' (dry-run)' : ''}: linked=${linked} pending=${pending} batchSize=${batchSize}`,
    );
  } finally {
    await closeDb();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    // eslint-disable-next-line no-console
    console.error(`Player ID backfill failed: ${message}`);
    process.exitCode = 1;
  });
}