// backend/src/services/watcherBackoff.ts
// Failure memory for the polling watchers (KI-08).
//
// A poller that retries every target every tick turns one downstream outage
// into a permanent hammer: the 2026-09-28 staging run put ~600 WorkDrive 429s
// an hour through a single Zoho tenant and never converged. What was missing
// is state between ticks — nothing remembered that a case had just failed.
//
// State lives in memory, not the database. The watcher is single-instance and
// the memory only needs to outlive a few ticks; a restart re-tries everything
// once, which is the right behaviour after a deploy anyway. Move it to a
// table if the backend is ever scaled out.

export type FailureKind = 'auth' | 'rate-limit' | 'transient' | 'permanent' | 'unknown';

/**
 * What kind of failure this is, and therefore whether retrying can ever help.
 *
 * `err.message.slice(0, 120)` — what the watcher used to log — hides the HTTP
 * status, so a 404 and a 429 read the same in the logs and got the same
 * treatment. They need opposite treatment.
 */
export function classifyFailure(err: unknown): FailureKind {
  const status = (err as { response?: { status?: number }; status?: number })?.response?.status
    ?? (err as { status?: number })?.status;

  if (typeof status === 'number') {
    if (status === 401 || status === 403) return 'auth';
    if (status === 429) return 'rate-limit';
    if (status === 404 || status === 400) return 'permanent';
    if (status >= 500) return 'transient';
  }

  const code = (err as { code?: string })?.code;
  if (code && ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND'].includes(code)) {
    return 'transient';
  }

  // Zoho answers some rate limits in the body rather than the status line.
  const message = String((err as Error)?.message ?? '');
  if (/rate limit|too many requests|\b429\b|F7008/i.test(message)) return 'rate-limit';
  if (/\b(401|403)\b|unauthor|forbidden|invalid.*token/i.test(message)) return 'auth';
  if (/\b404\b|not found|does not exist/i.test(message)) return 'permanent';

  return 'unknown';
}

export interface BackoffOptions {
  /** Delay after the first failure. Doubles from here. */
  baseDelayMs: number;
  /** Ceiling, so a long outage settles into a slow poll rather than silence. */
  maxDelayMs: number;
  /**
   * Applied to failures that retrying cannot fix — a folder that is not there
   * stays not there until a human maps it.
   */
  permanentDelayMs: number;
  /** Fraction of the delay applied as random spread. 0 disables. */
  jitter: number;
  /** Injectable for tests. */
  random: () => number;
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  baseDelayMs: 5 * 60_000,
  maxDelayMs: 60 * 60_000,
  permanentDelayMs: 6 * 60 * 60_000,
  jitter: 0.2,
  random: Math.random,
};

export function backoffDelayMs(
  consecutiveFailures: number,
  kind: FailureKind,
  opts: BackoffOptions = DEFAULT_BACKOFF,
): number {
  if (kind === 'permanent') return opts.permanentDelayMs;

  const exponential = opts.baseDelayMs * 2 ** Math.max(0, consecutiveFailures - 1);
  const capped = Math.min(exponential, opts.maxDelayMs);

  // Spread so twenty cases that failed together do not all come back in the
  // same second and rebuild the burst the cap was meant to break up.
  if (opts.jitter <= 0) return capped;
  const spread = capped * opts.jitter;
  return Math.round(capped - spread / 2 + opts.random() * spread);
}

interface FailureState {
  consecutive: number;
  kind: FailureKind;
  retryAt: number;
}

/**
 * Per-target failure memory.
 *
 * Keys are opaque — the recording watcher uses the case id. Anything that
 * polls a list of things it can fail on individually can use this.
 */
export class FailureTracker {
  private readonly states = new Map<string, FailureState>();

  constructor(private readonly opts: BackoffOptions = DEFAULT_BACKOFF) {}

  /** True while this target is serving a backoff. */
  shouldSkip(key: string, now = Date.now()): boolean {
    const state = this.states.get(key);
    return state !== undefined && now < state.retryAt;
  }

  /**
   * Records a failure and returns the new state, plus whether this transition
   * is worth logging — the wall of identical per-tick warnings was itself part
   * of the problem, so only the first failure of a run and each subsequent
   * doubling say anything.
   */
  recordFailure(key: string, kind: FailureKind, now = Date.now()) {
    const previous = this.states.get(key);
    const consecutive = (previous?.consecutive ?? 0) + 1;
    const delayMs = backoffDelayMs(consecutive, kind, this.opts);

    this.states.set(key, { consecutive, kind, retryAt: now + delayMs });
    return { consecutive, kind, delayMs, shouldLog: consecutive === 1 || kind !== previous?.kind };
  }

  /** Clears any backoff. Returns true if the target had been failing. */
  recordSuccess(key: string): boolean {
    return this.states.delete(key);
  }

  /** Targets currently in backoff, for one summary line per tick. */
  get backingOff(): number {
    const now = Date.now();
    let n = 0;
    for (const state of this.states.values()) if (now < state.retryAt) n++;
    return n;
  }

  reset(): void {
    this.states.clear();
  }
}

export interface BreakerOptions {
  /** Failure ratio in a tick that trips it. */
  threshold: number;
  /** Ticks to stay tripped before trying a full tick again. */
  cooldownTicks: number;
  /** Below this, a tick is too small for its ratio to mean anything. */
  minSamples: number;
}

export const DEFAULT_BREAKER: BreakerOptions = {
  threshold: 0.5,
  cooldownTicks: 3,
  minSamples: 3,
};

/**
 * Tick-level circuit breaker.
 *
 * Per-target backoff handles "this case is broken". This handles "the service
 * is broken", which per-target backoff reads as every case failing at once and
 * would answer with twenty separate retries.
 */
export class TickBreaker {
  private skipsRemaining = 0;
  private lastReason: string | null = null;

  constructor(private readonly opts: BreakerOptions = DEFAULT_BREAKER) {}

  /** Call at the top of a tick. True means do nothing this time round. */
  shouldSkipTick(): boolean {
    if (this.skipsRemaining <= 0) return false;
    this.skipsRemaining--;
    return true;
  }

  /**
   * Call at the end of a tick with what happened. Returns a reason string when
   * it has just tripped, so the caller logs once rather than per failure.
   */
  record(attempted: number, failed: number, dominantKind: FailureKind | null): string | null {
    if (attempted < this.opts.minSamples) return null;
    if (failed / attempted < this.opts.threshold) {
      this.lastReason = null;
      return null;
    }

    this.skipsRemaining = this.opts.cooldownTicks;
    const reason =
      `${failed}/${attempted} targets failed` +
      (dominantKind ? ` (${dominantKind})` : '') +
      ` — pausing for ${this.opts.cooldownTicks} ticks`;

    // Already tripped for the same reason: let the caller stay quiet.
    if (reason === this.lastReason) return null;
    this.lastReason = reason;
    return reason;
  }

  get tripped(): boolean {
    return this.skipsRemaining > 0;
  }

  reset(): void {
    this.skipsRemaining = 0;
    this.lastReason = null;
  }
}

/** The kind that accounts for most of a tick's failures, for one log line. */
export function dominantKind(kinds: readonly FailureKind[]): FailureKind | null {
  if (kinds.length === 0) return null;
  const counts = new Map<FailureKind, number>();
  for (const k of kinds) counts.set(k, (counts.get(k) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}
