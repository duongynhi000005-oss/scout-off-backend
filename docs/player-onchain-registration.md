# Player ID Mapping

The API keeps its cuid2 `player_id` as the stable public identifier. The register contract assigns a separate sequential `u64`; `players.on_chain_player_id` stores that value as decimal text. A null chain ID means the wallet has not completed contract registration.

`POST /api/players/register` creates the API profile immediately and returns `registrationStatus: "pending"` with the register contract ID, method, and arguments. The player wallet must authorize and submit that call. Once the indexer observes the `player_rg` event, it maps the wallet and sequential ID onto the existing API row. API endpoints that call player-aware contracts resolve the cuid2 through this mapping; transactions requiring an on-chain ID remain unavailable until registration is confirmed.

## Existing Rows

Migration 030 backfills rows only from unambiguous stored registration events. To check older rows against current register-contract state (including legacy wallet entries), deploy the register contract version exposing `get_player_id`, then run:

```sh
npm run backfill:on-chain-ids
```

### Flags & Environment Variables

| Option | Env Fallback | Default | Description |
| --- | --- | --- | --- |
| `--dry-run` | `DRY_RUN=true` | `false` | Queries the register contract and reports `linked` and `pending` counts without writing `on_chain_player_id` updates to the database. |
| `--batch-size=<n>` | `BACKFILL_BATCH_SIZE` | `100` | Number of unmapped player rows fetched per cursor page (`getPlayersMissingOnChainId`). |

Example dry run with a custom batch size:

```sh
npm run backfill:on-chain-ids -- --dry-run --batch-size=50
```

### Idempotency & Expected Runtime

- **Idempotency:** Safe to re-run at any time. The script paginates strictly over rows where `on_chain_player_id IS NULL` (ordered by `player_id` cursor) and only writes when `queryOnChainPlayerId(wallet)` returns a confirmed on-chain ID. Rows without an on-chain registration remain `NULL` (`pending`); no IDs are inferred from CUIDs, timestamps, or row order.
- **Expected Runtime:** Performs one read-only Soroban RPC simulation (`get_player_id`) per unmapped player wallet (~50–150 ms per wallet depending on RPC latency, or roughly 5–15 seconds per 100 unmapped rows).