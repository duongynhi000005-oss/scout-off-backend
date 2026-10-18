# Issues #1336, #1337, #1338, #1339: SSE Pub/Sub with Redis and Contract Pagination

## Summary

Implements two key features:
1. **Contract Pagination**: Adds cursor/page-based variants for unbounded contract read functions, preventing CPU/memory/return-size budget failures as data grows.
2. **SSE Pub/Sub with Redis**: Introduces Redis as a pub/sub transport for cross-instance SSE event delivery, with the indexer as a producer for chain-derived events.

## Changes

### Contract Pagination (Issues #1336, #1337)

**Files Modified:**
- `contracts/shared/src/storage.rs`: Added `Page<T>` type and `MAX_PAGE_SIZE=50` constant
- `contracts/register/src/lib.rs`: Added `filter_players_page` (paginated variant)
- `contracts/connection/src/lib.rs`: Added `list_connections_page`, `get_connections_page`, `get_trial_offers_page`
- `contracts/progress/src/lib.rs`: Added `get_milestones_page`
- `src/services/stellar.ts`: Added `queryMilestonesPage` and updated `queryMilestones` signature

**Design:**
- Signature: `fn list_x(env, key, start: u32, limit: u32) -> Page<T>` where `Page = { items: Vec<T>, next: Option<u32> }`
- Hard limit of 50 items per page to stay within Soroban budgets
- All new functions validate inputs and return empty pages with `next: None` when `start >= total`

### SSE Pub/Sub with Redis (Issues #1338, #1339)

**Files Modified:**
- `src/services/redis.ts`: Added `publishSseEvent`, `subscribeSseEvents` functions
- `src/services/eventBroadcaster.ts`: Added Redis pub/sub transport with instance ID deduplication
- `src/services/indexer.ts`: Added `broadcastIndexedEvent` to publish chain-derived events

**Design:**
- When Redis is configured: `broadcast()` publishes to Redis `PUBLISH sse:events` + local broadcast
- Each instance subscribes to `sse:events` and rebroadcasts locally (skipping own origin)
- When Redis is NOT configured: falls back to original in-process-only mode
- Metrics: `published`, `received`, `localBroadcasts`, `redisBroadcasts`

**Event Types Broadcast by Indexer:**
- `player_registered`
- `milestone_submitted`
- `milestone_approved`
- `scout_subscribed`
- `contact_unlocked`
- `trial_offer_logged`

**Deduplication:**
- Controllers broadcast when they successfully submit transactions
- Indexer broadcasts only AFTER successful `INSERT OR IGNORE` (new rows)
- Instance ID tracking (`{redis|local}:{random8chars}`) prevents echoing back our own Redis publishes
