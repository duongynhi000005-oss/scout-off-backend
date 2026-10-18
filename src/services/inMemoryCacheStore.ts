import { CacheStore } from './cacheStore';
import config, { parseCacheMaxEntries } from '../config';
import { recordCacheEviction } from '../middleware/metrics';

interface Entry {
  value: unknown;
  expiresAt?: number;
}

export const DEFAULT_MAX_SIZE = 1000;

function resolveMaxSize(explicit?: number): number {
  if (explicit !== undefined) {
    if (!Number.isInteger(explicit) || explicit < 1) {
      throw new Error(`InMemoryCacheStore maxSize must be a positive integer (got ${explicit})`);
    }
    return explicit;
  }
  if (
    process.env.CACHE_MAX_ENTRIES !== undefined ||
    process.env.CACHE_MAX_SIZE !== undefined ||
    process.env.PLAYER_CACHE_MAX_SIZE !== undefined
  ) {
    return parseCacheMaxEntries(process.env);
  }
  return config?.cacheMaxEntries ?? DEFAULT_MAX_SIZE;
}

/**
 * Unified bounded, TTL-aware, LRU in-memory CacheStore (#1553).
 *
 * Uses Map insertion order to track LRU access order in O(1): reading (`get`,
 * `has`) or updating (`set`) an entry re-inserts it at the tail of the Map, and
 * when capacity (`maxSize`, configured via `CACHE_MAX_ENTRIES`) is exceeded the
 * head entry is evicted and counted via `recordCacheEviction()`.
 */
export class InMemoryCacheStore implements CacheStore {
  private readonly store = new Map<string, Entry>();
  public readonly maxSize: number;

  constructor(maxSize?: number) {
    this.maxSize = resolveMaxSize(maxSize);
  }

  get size(): number {
    return this.store.size;
  }

  private isExpired(entry: Entry): boolean {
    return entry.expiresAt !== undefined && entry.expiresAt <= Date.now();
  }

  private evictIfNeeded(): void {
    while (this.store.size > this.maxSize) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey === undefined) break;
      this.store.delete(oldestKey);
      recordCacheEviction();
    }
  }

  private touch(key: string, entry: Entry): void {
    this.store.delete(key);
    this.store.set(key, entry);
  }

  async get<T>(key: string): Promise<T | undefined> {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (this.isExpired(entry)) {
      this.store.delete(key);
      recordCacheEviction();
      return undefined;
    }
    this.touch(key, entry);
    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    const entry: Entry = {
      value,
      expiresAt: ttlMs !== undefined ? Date.now() + ttlMs : undefined,
    };
    if (this.store.has(key)) {
      this.store.delete(key);
    }
    this.store.set(key, entry);
    this.evictIfNeeded();
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async has(key: string): Promise<boolean> {
    const entry = this.store.get(key);
    if (!entry) return false;
    if (this.isExpired(entry)) {
      this.store.delete(key);
      recordCacheEviction();
      return false;
    }
    this.touch(key, entry);
    return true;
  }

  async deleteByPrefix(prefix: string): Promise<void> {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
      }
    }
  }
}

