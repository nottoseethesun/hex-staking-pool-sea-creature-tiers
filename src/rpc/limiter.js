/**
 * @file src/rpc/limiter.js
 * @description Bounded-concurrency schedulers for the RPC client.
 *
 *   createLimiter(max)          a fixed FIFO concurrency gate.
 *   createAdaptiveLimiter(cap)  the same, but self-tuning: it automatically eases
 *                               the in-flight limit down when the endpoint signals
 *                               overload (HTTP 520/5xx/429/timeout) and ramps it
 *                               back up after sustained success — classic AIMD
 *                               (multiplicative decrease, additive increase). The
 *                               configured concurrency is the ceiling; the floor
 *                               is 1. This needs no operator input: the app finds
 *                               a polite rate for a flaky endpoint on its own.
 */

"use strict";

/**
 * A FIFO concurrency limiter. `schedule(fn)` runs `fn` when a slot is free.
 * @param {number} max
 * @returns {(fn: () => Promise<any>) => Promise<any>}
 */
function createLimiter(max) {
  let active = 0;
  const queue = [];
  const pump = () => {
    while (active < max && queue.length > 0) {
      const task = queue.shift();
      active += 1;
      task();
    }
  };
  return function schedule(fn) {
    return new Promise((resolve, reject) => {
      queue.push(() => {
        fn()
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            pump();
          });
      });
      pump();
    });
  };
}

/**
 * A self-tuning FIFO limiter. Starts at the ceiling and, driven by `onOverload`
 * / `onSuccess` signals from the caller, adapts the in-flight limit between 1 and
 * the ceiling: one multiplicative decrease per overload burst (bounded by a
 * cooldown so a flood of concurrent failures counts once), one additive +1 after
 * every `increaseAfter` successes. `onChange(limit, reason)` fires whenever the
 * limit moves so the client can log it.
 * @param {number} ceiling max concurrency (the configured value)
 * @param {{ min?: number, decreaseCooldownMs?: number, increaseAfter?: number,
 *   now?: () => number, onChange?: (limit: number, reason: string) => void }} [opts]
 * @returns {{ schedule: Function, onOverload: Function, onSuccess: Function,
 *   current: () => number, ceiling: number }}
 */
function createAdaptiveLimiter(ceiling, opts = {}) {
  const min = Math.max(1, opts.min ?? 1);
  const cap = Math.max(min, Math.floor(ceiling) || min);
  const cooldownMs = opts.decreaseCooldownMs ?? 3000;
  const increaseAfter = Math.max(1, opts.increaseAfter ?? 24);
  const now = opts.now ?? Date.now;
  const onChange = opts.onChange ?? (() => {});
  let limit = cap;
  let active = 0;
  let successes = 0;
  let lastDecrease = -Infinity; // so the first overload is never in "cooldown"
  const queue = [];
  const pump = () => {
    while (active < limit && queue.length > 0) {
      const task = queue.shift();
      active += 1;
      task();
    }
  };
  const onOverload = () => {
    if (limit <= min) return;
    const t = now();
    if (t - lastDecrease < cooldownMs) return; // one decrease per burst
    lastDecrease = t;
    successes = 0;
    limit = Math.max(min, limit - Math.ceil(limit / 2));
    onChange(limit, "overload");
  };
  const onSuccess = () => {
    if (limit >= cap) return;
    successes += 1;
    if (successes < increaseAfter) return;
    successes = 0;
    limit += 1;
    pump(); // the higher limit may admit a queued task now
    onChange(limit, "recovered");
  };
  const schedule = (fn) =>
    new Promise((resolve, reject) => {
      queue.push(() => {
        fn()
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            pump();
          });
      });
      pump();
    });
  return {
    schedule,
    onOverload,
    onSuccess,
    current: () => limit,
    ceiling: cap,
  };
}

module.exports = { createLimiter, createAdaptiveLimiter };
