import test from 'node:test';
import assert from 'node:assert/strict';
import { createRetentionPool } from '../src/pool.js';

// Deterministic model checks: no network, real sleep, or browser dependencies.
for (const seed of [7, 41, 2026]) test(`retention invariants survive 1500 mixed operations (seed ${seed})`, async () => {
  let randomState = seed, time = 0, nextTimer = 0, max = 4, disposed = false;
  const random = (limit) => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState % limit;
  };
  const timers = new Map(), owners = new Set(), views = [], violations = [];
  const check = (condition, message) => { if (!condition) violations.push(message); };
  const sessions = new Map(Array.from({ length: 12 }, (_, i) => {
    const item = { id: `session-${i}`, listeners: new Set(), state: { openState: 'open', removed: false } };
    item.binding = { session: {
      getSnapshot: () => item.state,
      subscribe: (listener) => { item.listeners.add(listener); return () => item.listeners.delete(listener); },
    } };
    return [item.id, item];
  }));
  const service = {
    binding: (id) => sessions.get(id)?.binding,
    retain: (id) => {
      check(!disposed, 'cannot acquire after disposal');
      const item = sessions.get(id);
      check(item.state.openState === 'open', 'must not open a cold or failed session');
      check(!item.state.removed, 'must not retain a removed session');
      const owner = { id, released: false };
      owners.add(owner);
      check(owners.size <= max, 'hard cap also holds DURING each acquisition');
      return { binding: item.binding, ready: Promise.resolve(item.binding), release() {
        check(!owner.released, 'each owned reference is released once');
        owner.released = true; owners.delete(owner);
      } };
    },
  };
  const pool = createRetentionPool(service, {
    maxSessions: max, idleMs: 1000, now: () => time,
    schedule: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, at: time + delay }); return id; },
    cancel: (id) => timers.delete(id),
  });
  const advance = (duration) => {
    time += duration;
    let count = 0;
    while (true) {
      const due = [...timers].find(([, task]) => task.at <= time);
      if (!due) return;
      assert.ok(++count < 100, 'no same-deadline timer loop');
      timers.delete(due[0]); due[1].fn();
    }
  };
  try {
    for (let step = 0; step < 1500; step++) {
      const item = sessions.get(`session-${random(12)}`);
      switch (random(9)) {
        case 0: case 1: views.push(pool.attach(item.id)); break;
        case 2: if (views.length) views.splice(random(views.length), 1)[0](); break;
        case 3: max = random(8) + 1; pool.configure({ maxSessions: max, idleMs: (random(12) + 1) * 100 }); break;
        case 4: advance(random(1500)); break;
        case 5: pool.setEnabled(random(2) === 1); break;
        case 6: pool.clearIdle(); break;
        case 7: pool.noteGeneration(); break;
        case 8:
          item.state = random(2) ? { openState: 'error', removed: false } : { openState: 'open', removed: true };
          for (const listener of [...item.listeners]) listener();
          item.state = { openState: 'open', removed: false };
          for (const listener of [...item.listeners]) listener();
          break;
      }
      await Promise.resolve();
      assert.deepEqual(violations, [], `native callback invariants at step ${step}`);
      assert.equal(pool.getSnapshot().retained, owners.size, `snapshot count at step ${step}`);
      assert.ok(owners.size <= max, `hard cap at step ${step}`);
      assert.equal(new Set([...owners].map((owner) => owner.id)).size, owners.size, 'one owner per session generation');
      assert.ok(timers.size <= 1, 'at most one idle deadline timer');
      if (!pool.getSnapshot().enabled) assert.equal(owners.size, 0);
    }
  } finally {
    for (const detach of views) { detach(); detach(); }
    pool.dispose(); disposed = true;
  }
  assert.equal(owners.size, 0);
  assert.equal(timers.size, 0);
  assert.ok([...sessions.values()].every((item) => item.listeners.size === 0), 'no native subscriptions survive disposal');
  const detached = pool.attach('session-0'); detached();
  pool.noteGeneration(); pool.clearIdle(); pool.setEnabled(true); pool.dispose();
  await Promise.resolve();
  assert.equal(owners.size, 0);
  assert.deepEqual(violations, []);
});
