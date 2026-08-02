"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createAdaptiveLimiter } = require("../src/rpc/limiter");
const { isOverload } = require("../src/rpc/client");

test("isOverload flags 520/5xx/429/timeout, not 4xx or generic errors", () => {
  assert.equal(
    isOverload(
      Object.assign(new Error("server response 520 <none>"), {
        code: "SERVER_ERROR",
        info: { responseStatus: "520 <none>" },
      }),
    ),
    true,
  );
  assert.equal(isOverload({ status: 429 }), true);
  assert.equal(isOverload({ code: "TIMEOUT" }), true);
  assert.equal(isOverload(new Error("request timeout exceeded")), true);
  assert.equal(isOverload({ status: 404 }), false);
  assert.equal(isOverload(new Error("execution reverted")), false);
  assert.equal(isOverload(null), false);
});

test("adaptive limiter: multiplicative decrease on overload, once per cooldown", () => {
  let t = 0;
  const changes = [];
  const lim = createAdaptiveLimiter(4, {
    min: 1,
    decreaseCooldownMs: 100,
    now: () => t,
    onChange: (limit, reason) => changes.push([limit, reason]),
  });
  assert.equal(lim.current(), 4);
  lim.onOverload(); // 4 -> 2
  assert.equal(lim.current(), 2);
  lim.onOverload(); // within cooldown: ignored
  assert.equal(lim.current(), 2);
  t = 200;
  lim.onOverload(); // 2 -> 1
  assert.equal(lim.current(), 1);
  t = 400;
  lim.onOverload(); // already at floor: ignored
  assert.equal(lim.current(), 1);
  assert.deepEqual(changes, [
    [2, "overload"],
    [1, "overload"],
  ]);
});

test("adaptive limiter: additive increase after sustained success, capped at ceiling", () => {
  const lim = createAdaptiveLimiter(3, {
    min: 1,
    decreaseCooldownMs: 100,
    increaseAfter: 2,
    now: () => 0,
  });
  lim.onOverload(); // 3 -> 1 (3 - ceil(3/2))
  assert.equal(lim.current(), 1);
  lim.onSuccess(); // 1/2
  assert.equal(lim.current(), 1);
  lim.onSuccess(); // 2/2 -> +1
  assert.equal(lim.current(), 2);
  lim.onSuccess();
  lim.onSuccess(); // -> ceiling 3
  assert.equal(lim.current(), 3);
  lim.onSuccess();
  lim.onSuccess(); // stays at ceiling
  assert.equal(lim.current(), 3);
});

test("adaptive limiter runs at most `current()` tasks concurrently", async () => {
  const lim = createAdaptiveLimiter(2, { now: () => 0 });
  let running = 0;
  let maxRunning = 0;
  const gates = [];
  const task = () =>
    new Promise((resolve) => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      gates.push(() => {
        running -= 1;
        resolve();
      });
    });
  const all = [lim.schedule(task), lim.schedule(task), lim.schedule(task)];
  await Promise.resolve();
  assert.equal(maxRunning, 2, "ceiling of 2 respected while a 3rd waits");
  // Release in waves: a freed slot lets the queued task start (async finally ->
  // pump), which pushes its own gate — so flush microtasks between releases.
  for (let i = 0; i < 4; i += 1) {
    while (gates.length) gates.shift()();
    await Promise.resolve();
    await Promise.resolve();
  }
  await Promise.all(all);
  assert.equal(maxRunning, 2);
});
