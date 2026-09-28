// KI-08. The defect was a loop that never gave up, so these are mostly about
// what the watcher does NOT do: retry immediately, retry a 404 for ever, or
// keep asking a service that is plainly down.

import { describe, it, expect } from 'vitest';
import {
  classifyFailure,
  backoffDelayMs,
  FailureTracker,
  TickBreaker,
  dominantKind,
  DEFAULT_BACKOFF,
} from './watcherBackoff';

const httpError = (status: number, message = 'request failed') =>
  Object.assign(new Error(message), { response: { status } });

// No jitter, so a delay can be asserted exactly.
const fixed = { ...DEFAULT_BACKOFF, jitter: 0 };

describe('classifyFailure', () => {
  it('reads the status off an axios-shaped error', () => {
    expect(classifyFailure(httpError(429))).toBe('rate-limit');
    expect(classifyFailure(httpError(401))).toBe('auth');
    expect(classifyFailure(httpError(403))).toBe('auth');
    expect(classifyFailure(httpError(404))).toBe('permanent');
    expect(classifyFailure(httpError(503))).toBe('transient');
  });

  it('treats a dropped connection as transient', () => {
    expect(classifyFailure(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })))
      .toBe('transient');
  });

  // Zoho answers some rate limits in the body, and F7008 is the WorkDrive one
  // the watcher's own comment already named.
  it('falls back to the message when there is no status', () => {
    expect(classifyFailure(new Error('WorkDrive says F7008'))).toBe('rate-limit');
    expect(classifyFailure(new Error('Too Many Requests'))).toBe('rate-limit');
    expect(classifyFailure(new Error('folder not found'))).toBe('permanent');
  });

  it('says unknown rather than guessing', () => {
    expect(classifyFailure(new Error('something odd'))).toBe('unknown');
    expect(classifyFailure(undefined)).toBe('unknown');
  });
});

describe('backoffDelayMs', () => {
  it('doubles with each consecutive failure', () => {
    expect(backoffDelayMs(1, 'rate-limit', fixed)).toBe(5 * 60_000);
    expect(backoffDelayMs(2, 'rate-limit', fixed)).toBe(10 * 60_000);
    expect(backoffDelayMs(3, 'rate-limit', fixed)).toBe(20 * 60_000);
  });

  it('stops doubling at the ceiling, so an outage settles into a slow poll', () => {
    expect(backoffDelayMs(50, 'rate-limit', fixed)).toBe(fixed.maxDelayMs);
  });

  // Retrying cannot conjure a folder that is not there.
  it('parks a permanent failure for hours regardless of count', () => {
    expect(backoffDelayMs(1, 'permanent', fixed)).toBe(fixed.permanentDelayMs);
    expect(backoffDelayMs(9, 'permanent', fixed)).toBe(fixed.permanentDelayMs);
  });

  it('spreads with jitter so a batch does not come back in lockstep', () => {
    const jittered = { ...DEFAULT_BACKOFF, random: () => 1 };
    expect(backoffDelayMs(1, 'rate-limit', jittered)).toBeGreaterThan(
      backoffDelayMs(1, 'rate-limit', { ...DEFAULT_BACKOFF, random: () => 0 }),
    );
  });
});

describe('FailureTracker', () => {
  it('does not skip a target it has never seen fail', () => {
    expect(new FailureTracker(fixed).shouldSkip('case-1')).toBe(false);
  });

  // The actual KI-08 defect: this was false on every tick.
  it('skips a failed target until its delay has elapsed', () => {
    const t = new FailureTracker(fixed);
    const now = 1_000_000;
    t.recordFailure('case-1', 'rate-limit', now);

    expect(t.shouldSkip('case-1', now + 60_000)).toBe(true);
    expect(t.shouldSkip('case-1', now + 5 * 60_000 + 1)).toBe(false);
  });

  it('lengthens the wait each time it fails again', () => {
    const t = new FailureTracker(fixed);
    expect(t.recordFailure('case-1', 'rate-limit', 0).delayMs).toBe(5 * 60_000);
    expect(t.recordFailure('case-1', 'rate-limit', 0).delayMs).toBe(10 * 60_000);
    expect(t.recordFailure('case-1', 'rate-limit', 0).delayMs).toBe(20 * 60_000);
  });

  it('forgets everything once the target succeeds', () => {
    const t = new FailureTracker(fixed);
    t.recordFailure('case-1', 'rate-limit', 0);
    expect(t.recordSuccess('case-1')).toBe(true);
    expect(t.shouldSkip('case-1', 1)).toBe(false);
    expect(t.recordFailure('case-1', 'rate-limit', 0).delayMs).toBe(5 * 60_000);
  });

  it('reports no recovery for a target that was never failing', () => {
    expect(new FailureTracker(fixed).recordSuccess('case-1')).toBe(false);
  });

  // The per-tick wall of identical warnings was half the problem — you could
  // not tell from the logs whether things were improving.
  it('asks to log the first failure and each change of kind, not every tick', () => {
    const t = new FailureTracker(fixed);
    expect(t.recordFailure('case-1', 'rate-limit', 0).shouldLog).toBe(true);
    expect(t.recordFailure('case-1', 'rate-limit', 0).shouldLog).toBe(false);
    expect(t.recordFailure('case-1', 'auth', 0).shouldLog).toBe(true);
  });

  it('keeps targets apart', () => {
    const t = new FailureTracker(fixed);
    t.recordFailure('case-1', 'rate-limit', 0);
    expect(t.shouldSkip('case-1', 1)).toBe(true);
    expect(t.shouldSkip('case-2', 1)).toBe(false);
  });

  it('counts how many are waiting', () => {
    const t = new FailureTracker(fixed);
    t.recordFailure('a', 'rate-limit');
    t.recordFailure('b', 'rate-limit');
    expect(t.backingOff).toBe(2);
    t.recordSuccess('a');
    expect(t.backingOff).toBe(1);
  });
});

describe('TickBreaker', () => {
  it('stays closed while most targets are fine', () => {
    const b = new TickBreaker();
    expect(b.record(20, 2, 'rate-limit')).toBeNull();
    expect(b.shouldSkipTick()).toBe(false);
  });

  // Twenty cases failing at once is one broken service, not twenty broken
  // cases, and should cost one log line rather than twenty.
  it('trips when most of a tick fails, and reports once', () => {
    const b = new TickBreaker();
    expect(b.record(20, 20, 'rate-limit')).toMatch(/20\/20 targets failed \(rate-limit\)/);
    expect(b.tripped).toBe(true);
  });

  it('skips exactly the cooldown, then allows a tick through', () => {
    const b = new TickBreaker({ threshold: 0.5, cooldownTicks: 3, minSamples: 3 });
    b.record(10, 10, 'rate-limit');
    expect([b.shouldSkipTick(), b.shouldSkipTick(), b.shouldSkipTick()]).toEqual([
      true,
      true,
      true,
    ]);
    expect(b.shouldSkipTick()).toBe(false);
  });

  it('does not trip on a tick too small to mean anything', () => {
    const b = new TickBreaker();
    expect(b.record(2, 2, 'rate-limit')).toBeNull();
    expect(b.tripped).toBe(false);
  });

  it('stays quiet on a repeat trip for the same reason', () => {
    const b = new TickBreaker();
    expect(b.record(10, 10, 'rate-limit')).not.toBeNull();
    expect(b.record(10, 10, 'rate-limit')).toBeNull();
  });

  it('speaks up again once a healthy tick has cleared it', () => {
    const b = new TickBreaker();
    b.record(10, 10, 'rate-limit');
    b.record(10, 0, null);
    expect(b.record(10, 10, 'rate-limit')).not.toBeNull();
  });
});

describe('dominantKind', () => {
  it('picks the kind behind most of the failures', () => {
    expect(dominantKind(['rate-limit', 'rate-limit', 'auth'])).toBe('rate-limit');
  });

  it('is null when nothing failed', () => {
    expect(dominantKind([])).toBeNull();
  });
});
