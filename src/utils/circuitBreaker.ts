/**
 * Circuit breakers for outbound dependency calls.
 *
 * Two implementations live here because the two call sites have genuinely
 * different needs:
 *
 *   • {@link CircuitBreaker} — a plain breaker (closed / open / half-open) with
 *     no retry logic. Used for IPFS / Pinata (issue #1142): a single failing
 *     call counts as one failure, and once the breaker is open every call
 *     fast-fails with {@link CircuitBreakerOpenError} until the reset timeout
 *     elapses and a single probe is allowed through.
 *
 *   • {@link RetryingCircuitBreaker} — wraps each call in bounded exponential
 *     backoff retries before counting a failure. Used for the Stellar RPC
 *     client (see src/services/stellar.ts), where transient RPC errors are
 *     common and worth retrying in-line.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Plain breaker (IPFS / Pinata) — issue #1142
// ─────────────────────────────────────────────────────────────────────────────

import { registerBreaker } from '../middleware/metrics';

export type CircuitState = 'closed' | 'open' | 'half-open';
export type CircuitStateChangeListener = (from: CircuitState, to: CircuitState) => void;

export interface CircuitBreakerOptions {
  /** Number of consecutive failures before opening. Default: 5 */
  failureThreshold?: number;
  /** Milliseconds to wait before moving from open → half-open. Default: 30000 */
  resetTimeoutMs?: number;
  /** Human-readable name used in error messages and logs. */
  name?: string;
  /** Optional callback fired whenever the breaker transitions between states. */
  onStateChange?: CircuitStateChangeListener;
}

export class CircuitBreakerOpenError extends Error {
  constructor(name: string) {
    super(`Circuit breaker open: ${name} is temporarily unavailable`);
    this.name = 'CircuitBreakerOpenError';
  }
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures = 0;
  private lastOpenedAt: number | null = null;
  private readonly listeners: CircuitStateChangeListener[] = [];

  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  readonly name: string;

  constructor(options: CircuitBreakerOptions = {}) {
    this.name = options.name ?? 'unknown';
    this.failureThreshold =
      options.failureThreshold ??
      parseInt(process.env.CIRCUIT_BREAKER_FAILURE_THRESHOLD ?? '5', 10);
    this.resetTimeoutMs =
      options.resetTimeoutMs ??
      parseInt(process.env.CIRCUIT_BREAKER_RESET_TIMEOUT_MS ?? '30000', 10);
    if (options.onStateChange) {
      this.listeners.push(options.onStateChange);
    }
  }

  addStateChangeListener(listener: CircuitStateChangeListener): void {
    this.listeners.push(listener);
  }

  private transitionTo(next: CircuitState): void {
    const prev = this.state;
    if (prev === next) return;
    this.state = next;
    for (const listener of this.listeners) {
      listener(prev, next);
    }
  }

  getState(): CircuitState {
    if (this.state === 'open' && this.lastOpenedAt !== null) {
      if (Date.now() - this.lastOpenedAt >= this.resetTimeoutMs) {
        this.transitionTo('half-open');
      }
    }
    return this.state;
  }

  /** Execute fn through the breaker. Throws CircuitBreakerOpenError when open. */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.getState();

    if (state === 'open') {
      throw new CircuitBreakerOpenError(this.name);
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  isOpen(): boolean {
    return this.getState() === 'open';
  }

  private onSuccess(): void {
    this.failures = 0;
    this.lastOpenedAt = null;
    this.transitionTo('closed');
  }

  private onFailure(): void {
    this.failures += 1;
    if (this.state === 'half-open' || this.failures >= this.failureThreshold) {
      this.lastOpenedAt = Date.now();
      this.transitionTo('open');
    }
  }

  /** Reset for testing purposes. */
  reset(): void {
    this.state = 'closed';
    this.failures = 0;
    this.lastOpenedAt = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Retrying breaker (Stellar RPC)
// ─────────────────────────────────────────────────────────────────────────────

export type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export class CircuitBreakerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CircuitBreakerError';
  }
}

export interface CircuitBreakerConfig {
  name?: string;
  failureThreshold: number;
  resetTimeoutMs: number;
  maxRetries: number;
  baseBackoffMs: number;
  onStateChange?: CircuitStateChangeListener;
}

function toNormalizedState(state: CircuitBreakerState): CircuitState {
  if (state === 'OPEN') return 'open';
  if (state === 'HALF_OPEN') return 'half-open';
  return 'closed';
}

export class RetryingCircuitBreaker {
  private _state: CircuitBreakerState = 'CLOSED';
  private failureCount = 0;
  private nextAttemptAt = 0;
  private config: CircuitBreakerConfig;
  private readonly listeners: CircuitStateChangeListener[] = [];
  readonly name: string;

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.name = config.name ?? 'stellar';
    this.config = {
      failureThreshold: 3,
      resetTimeoutMs: 10000,
      maxRetries: 3,
      baseBackoffMs: 1000,
      ...config,
    };
    if (config.onStateChange) {
      this.listeners.push(config.onStateChange);
    }
  }

  get state(): CircuitBreakerState {
    return this._state;
  }

  set state(next: CircuitBreakerState) {
    this.transitionTo(next);
  }

  addStateChangeListener(listener: CircuitStateChangeListener): void {
    this.listeners.push(listener);
  }

  private transitionTo(next: CircuitBreakerState): void {
    const prev = this._state;
    if (prev === next) return;
    this._state = next;
    const prevNorm = toNormalizedState(prev);
    const nextNorm = toNormalizedState(next);
    for (const listener of this.listeners) {
      listener(prevNorm, nextNorm);
    }
  }

  getState(): CircuitState {
    if (this._state === 'OPEN' && this.nextAttemptAt > 0 && Date.now() >= this.nextAttemptAt) {
      this.transitionTo('HALF_OPEN');
    }
    return toNormalizedState(this._state);
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this._state === 'OPEN') {
      if (Date.now() >= this.nextAttemptAt) {
        this.transitionTo('HALF_OPEN');
      } else {
        throw new CircuitBreakerError('ServiceUnavailable: Circuit breaker is OPEN');
      }
    }

    try {
      const result = await this.executeWithRetry(fn);
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private async executeWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    let attempt = 0;
    while (attempt <= this.config.maxRetries) {
      try {
        return await fn();
      } catch (error: any) {
        if (!this.isRetryable(error) || attempt === this.config.maxRetries) {
          throw error;
        }
        attempt++;
        // Exponential backoff with jitter
        const backoff = this.config.baseBackoffMs * Math.pow(2, attempt - 1) + Math.random() * 100;
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }
    throw new Error('Unreachable');
  }

  private isRetryable(error: any): boolean {
    const status = error?.response?.status;
    if (typeof status === 'number') {
      // 408 Request Timeout and 429 Too Many Requests are retryable
      if (status === 408 || status === 429) return true;
      // 4xx errors are generally validation/client errors -> fail fast
      if (status >= 400 && status < 500) return false;
    }
    // Network errors (no response, timeouts) or 5xx server errors are retryable
    return true;
  }

  private onSuccess() {
    this.failureCount = 0;
    this.transitionTo('CLOSED');
  }

  private onFailure() {
    this.failureCount++;
    if (this._state === 'HALF_OPEN' || this.failureCount >= this.config.failureThreshold) {
      this.nextAttemptAt = Date.now() + this.config.resetTimeoutMs;
      this.transitionTo('OPEN');
    }
  }

  /** Reset for testing purposes. */
  reset(): void {
    this._state = 'CLOSED';
    this.failureCount = 0;
    this.nextAttemptAt = 0;
  }
}

export const stellarBreaker = new RetryingCircuitBreaker({ name: 'stellar' });
registerBreaker(stellarBreaker);

