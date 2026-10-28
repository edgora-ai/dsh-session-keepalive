import test from 'node:test';
import assert from 'node:assert/strict';
import { createRetentionPool } from '../src/pool.js';

function fixture(options = {}) {
  let time = 0, next = 0;
  const timers = new Map(), bindings = new Map(), references = [], errors = [], events = [];
  function add(id, openState = 'open') {
    let state = { openState, removed: false };
    const listeners = new Set();
    const binding = { session: { getSnapshot: () => state, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } } };
    bindings.set(id, binding);
    return { binding, update(patch) { state = { ...state, ...patch }; for (const fn of [...listeners]) fn(); }, listeners };
  }
  const sessions = {
    binding: (id) => bindings.get(id),
    retain(id, { source }) {
      assert.equal(source, 'localSessionKeepalive');
      const ref = { id, binding: bindings.get(id), released: 0, release() { this.released++; } };
      ref.ready = new Promise((resolve, reject) => { ref.resolve = resolve; ref.reject = reject; });
      references.push(ref);
      return ref;
    },
  };
  const pool = createRetentionPool(sessions, {
    idleMs: 100, now: () => time,
    schedule(fn, delay) { const id = ++next; timers.set(id, { fn, at: time + delay }); return id; },
    cancel: (id) => timers.delete(id), reportError: (error) => errors.push(error), reportEvent: (event) => events.push(event), ...options,
  });
  function advance(ms) {
    time += ms;
    for (;;) {
      const due = [...timers].find(([, task]) => task.at <= time);
      if (!due) break;
      timers.delete(due[0]); due[1].fn();
    }
  }
  return { pool, sessions, add, advance, timers, references, errors, events };
}

test('only already-open sessions can be retained', () => {
  const f = fixture();
  for (const state of ['cold', 'loading', 'error']) { f.add(state, state); f.pool.attach(state)(); }
  f.pool.attach('missing')();
  const removed = f.add('removed'); removed.update({ removed: true }); f.pool.attach('removed')();
  assert.equal(f.references.length, 0); f.pool.dispose();
});

test('returning reuses a reference and idle expiration resets after last detach', () => {
  const f = fixture(); f.add('A');
  f.pool.attach('A')(); f.advance(90);
  const detach = f.pool.attach('A'); f.advance(200);
  assert.equal(f.references.length, 1); assert.equal(f.references[0].released, 0);
  assert.equal(f.pool.getSnapshot().hits, 1);
  detach(); detach(); f.advance(99); assert.equal(f.references[0].released, 0);
  f.advance(1); assert.equal(f.references[0].released, 1);
  assert.equal(f.pool.getSnapshot().retained, 0); assert.equal(f.timers.size, 0); f.pool.dispose();
});

test('LRU eviction keeps the total cap including visible sessions', () => {
  const f = fixture({ maxSessions: 3 }); for (const id of ['A', 'B', 'C', 'D']) f.add(id);
  f.pool.attach('A')(); f.advance(1); f.pool.attach('B')(); f.advance(1);
  const c = f.pool.attach('C'); f.advance(1); f.pool.attach('A')();
  f.pool.attach('D');
  assert.equal(f.pool.getSnapshot().retained, 3);
  assert.equal(f.references.find((r) => r.id === 'B').released, 1);
  assert.equal(f.references.find((r) => r.id === 'C').released, 0);
  c(); f.pool.dispose();
  assert.ok(f.references.every((r) => r.released === 1));
});

test('visible entries never exceed the hard cap and clearIdle preserves them', () => {
  const f = fixture({ maxSessions: 1 }); f.add('A'); f.add('B');
  const first = f.pool.attach('A'), second = f.pool.attach('A');
  first(); f.pool.clearIdle(); f.pool.attach('B')(); f.advance(1000);
  assert.equal(f.references.length, 1); assert.equal(f.references[0].released, 0);
  second(); f.pool.clearIdle(); assert.equal(f.references[0].released, 1); f.pool.dispose();
});

test('pause releases all references and resume allows a new acquisition', () => {
  const f = fixture(); f.add('A'); const oldDetach = f.pool.attach('A');
  f.pool.setEnabled(false); oldDetach(); f.pool.attach('A')();
  assert.equal(f.references.length, 1); assert.equal(f.references[0].released, 1);
  f.pool.setEnabled(true); f.pool.attach('A')();
  assert.equal(f.references.length, 2); f.pool.dispose(); f.pool.dispose();
  assert.equal(f.timers.size, 0); assert.ok(f.references.every((r) => r.released === 1));
});

test('removed and failed snapshots release subscriptions immediately', () => {
  for (const patch of [{ removed: true }, { openState: 'error' }]) {
    const f = fixture(); const state = f.add('A'); f.pool.attach('A'); state.update(patch);
    assert.equal(f.references[0].released, 1); assert.equal(state.listeners.size, 0);
    assert.equal(f.pool.getSnapshot().retained, 0); f.pool.dispose();
  }
});

test('ready rejection and retain throw do not leave retained entries', async () => {
  const f = fixture(); f.add('A'); f.pool.attach('A'); f.references[0].reject(new Error('failed'));
  await Promise.resolve(); assert.equal(f.references[0].released, 1);
  assert.equal(f.pool.getSnapshot().retained, 0); assert.equal(f.errors.length, 1);
  f.sessions.retain = () => { throw new Error('closed'); }; f.pool.attach('A')();
  assert.equal(f.pool.getSnapshot().failures, 2); assert.equal(f.timers.size, 0); f.pool.dispose();
});

test('stale generation rejection and stale detach cannot release its replacement', async () => {
  const f = fixture(); f.add('A'); const detach = f.pool.attach('A');
  f.add('A'); f.pool.attach('A'); detach(); f.references[0].reject(new Error('old'));
  await Promise.resolve();
  assert.equal(f.references[0].released, 1); assert.equal(f.references[1].released, 0);
  assert.equal(f.pool.getSnapshot().retained, 1); assert.equal(f.errors.length, 0); f.pool.dispose();
});


test('default capacity retains eight sessions and evicts the oldest for the ninth', () => {
  const f = fixture();
  for (const id of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']) {
    f.add(id); f.pool.attach(id)();
    assert.ok(f.pool.getSnapshot().retained <= 8);
  }
  assert.equal(f.pool.getSnapshot().maxSessions, 8);
  assert.equal(f.pool.getSnapshot().retained, 8);
  assert.equal(f.references[0].released, 1);
  assert.ok(f.references.slice(1).every((r) => r.released === 0));
  f.pool.dispose();
});

test('configuration grows capacity without dropping warm references', () => {
  const f = fixture({ maxSessions: 1 }); f.add('A'); f.add('B'); f.pool.attach('A')();
  f.pool.configure({ maxSessions: 2, idleMs: 100 }); f.pool.attach('B')();
  assert.equal(f.pool.getSnapshot().retained, 2);
  assert.ok(f.references.every((r) => r.released === 0)); f.pool.dispose();
});

test('configuration shrinks idle entries in LRU order before visible entries', () => {
  const f = fixture(); for (const id of ['A', 'B', 'C']) f.add(id);
  f.pool.attach('A'); f.advance(1); f.pool.attach('B')(); f.advance(1); f.pool.attach('C')();
  f.pool.configure({ maxSessions: 2, idleMs: 100 });
  assert.equal(f.references[1].released, 1); assert.equal(f.references[0].released, 0);
  f.pool.configure({ maxSessions: 1, idleMs: 100 });
  assert.equal(f.references[2].released, 1); assert.equal(f.pool.getSnapshot().retained, 1);
  f.pool.dispose();
});

test('shrinking below visible count releases only surplus plugin references', () => {
  const f = fixture(); f.add('A'); f.add('B');
  const detach = f.pool.attach('A'); f.advance(1); f.pool.attach('B');
  f.pool.configure({ maxSessions: 1, idleMs: 100 }); detach();
  assert.equal(f.references[0].released, 1); assert.equal(f.references[1].released, 0);
  assert.equal(f.pool.getSnapshot().retained, 1); f.pool.dispose();
});

test('changing idle deadline preserves elapsed idle time and cancels old timer', () => {
  const f = fixture(); f.add('A'); f.pool.attach('A')(); f.advance(60);
  f.pool.configure({ maxSessions: 8, idleMs: 200 });
  assert.equal(f.timers.size, 1); f.advance(100); assert.equal(f.references[0].released, 0);
  f.pool.configure({ maxSessions: 8, idleMs: 150 });
  assert.equal(f.references[0].released, 1); assert.equal(f.timers.size, 0); f.pool.dispose();
});

test('invalid configuration leaves limits and references unchanged', () => {
  const f = fixture(); f.add('A'); f.pool.attach('A')();
  for (const value of [0, -1, 1.5, Infinity, NaN]) {
    assert.throws(() => f.pool.configure({ maxSessions: value, idleMs: 50 }));
  }
  assert.throws(() => f.pool.configure({ maxSessions: 1, idleMs: 0 }));
  assert.equal(f.pool.getSnapshot().maxSessions, 8); assert.equal(f.pool.getSnapshot().idleMs, 100);
  assert.equal(f.references[0].released, 0); f.pool.dispose();
});

test('default idle deadline expires at thirty minutes, not before', () => {
  const f = fixture({ idleMs: undefined }); f.add('A'); f.pool.attach('A')();
  assert.equal(f.pool.getSnapshot().idleMs, 30 * 60 * 1000);
  f.advance(30 * 60 * 1000 - 1);
  assert.equal(f.pool.getSnapshot().retained, 1);
  assert.equal(f.references[0].released, 0);
  f.advance(1);
  assert.equal(f.pool.getSnapshot().retained, 0);
  assert.equal(f.references[0].released, 1);
  assert.equal(f.timers.size, 0); f.pool.dispose();
});


test('120 minute setting remains retained until exactly two hours of idle time', () => {
  const f = fixture(); f.add('A'); const detach = f.pool.attach('A');
  f.pool.configure({ maxSessions: 8, idleMs: 120 * 60000 });
  f.advance(121 * 60000);
  assert.equal(f.pool.getSnapshot().retained, 1, 'visible sessions do not expire');
  detach(); f.advance(120 * 60000 - 1);
  assert.equal(f.pool.getSnapshot().retained, 1);
  assert.equal(f.events.filter((event) => event.type === 'release').length, 0);
  f.advance(1);
  const expired = f.events.find((event) => event.type === 'release');
  assert.equal(expired.reason, 'expired');
  assert.equal(expired.idleForMs, 120 * 60000);
  assert.equal(expired.idleMs, 120 * 60000);
  assert.equal(expired.retained, 0); f.pool.dispose();
});

test('release diagnostics distinguish capacity, configuration, deletion, pause and manual actions', () => {
  const f = fixture({ maxSessions: 1 }); f.add('A'); f.add('B');
  f.pool.attach('A')(); f.advance(10); f.pool.attach('B')();
  assert.equal(f.events.at(-1).reason, 'capacity');
  f.pool.clearIdle(); assert.equal(f.events.at(-1).reason, 'manual');
  f.pool.attach('A')(); f.advance(20);
  f.pool.configure({ maxSessions: 1, idleMs: 10 });
  assert.equal(f.events.findLast((event) => event.type === 'release').reason, 'settings-expired');
  f.pool.configure({ maxSessions: 2, idleMs: 100 });
  f.pool.attach('A')(); f.pool.attach('B')();
  f.pool.configure({ maxSessions: 1, idleMs: 100 });
  assert.equal(f.events.findLast((event) => event.type === 'release').reason, 'settings-capacity');
  f.pool.setEnabled(false); assert.equal(f.events.at(-1).reason, 'paused');
  f.pool.setEnabled(true); const native = f.add('C'); f.pool.attach('C');
  native.update({ removed: true }); assert.equal(f.events.at(-1).reason, 'removed');
  f.pool.dispose();
});

test('terminal Session errors are counted and diagnosed, not silently dropped', () => {
  const f = fixture(); const native = f.add('A'); f.pool.attach('A')(); f.advance(12);
  const error = { code: 'gateway/internal', message: 'private message' };
  native.update({ openState: 'error', openError: error });
  assert.equal(f.pool.getSnapshot().failures, 1);
  assert.equal(f.references[0].released, 1);
  assert.deepEqual(f.errors, [error]);
  assert.deepEqual(f.events.at(-1), { type: 'release', retained: 0, maxSessions: 8, idleMs: 100,
    reason: 'session-error', idleForMs: 12, errorCode: 'gateway/internal' });
  assert.equal(JSON.stringify(f.events).includes('private message'), false);
  f.pool.dispose();
});

test('diagnostics failures cannot disrupt retention or cleanup', () => {
  const f = fixture({ reportEvent() { throw new Error('blocked diagnostic sink'); } });
  f.add('A'); f.pool.attach('A')();
  assert.doesNotThrow(() => f.pool.configure({ maxSessions: 1, idleMs: 20 }));
  f.advance(20); assert.equal(f.references[0].released, 1);
  assert.doesNotThrow(() => f.pool.dispose());
});

test('a capacity-blocked visible view is retained when another view leaves', () => {
  const f = fixture({ maxSessions: 1 }); f.add('A'); f.add('B');
  const a = f.pool.attach('A'), b = f.pool.attach('B');
  assert.equal(f.references.length, 1);
  a();
  assert.equal(f.references.length, 2, 'the still-visible B must not need another attach');
  assert.equal(f.references[0].released, 1);
  assert.equal(f.references[1].id, 'B');
  assert.equal(f.pool.getSnapshot().retained, 1);
  f.advance(500); assert.equal(f.references[1].released, 0);
  b(); f.advance(99); assert.equal(f.references[1].released, 0);
  f.advance(1); assert.equal(f.references[1].released, 1); f.pool.dispose();
});

test('increasing capacity retains pending visible views without effect churn', () => {
  const f = fixture({ maxSessions: 1 }); f.add('A'); f.add('B'); f.add('C');
  const a = f.pool.attach('A'), b = f.pool.attach('B'), c = f.pool.attach('C');
  f.pool.configure({ maxSessions: 3, idleMs: 100 });
  assert.deepEqual(f.references.map((ref) => ref.id), ['A', 'B', 'C']);
  assert.equal(f.pool.getSnapshot().retained, 3);
  assert.ok(f.references.every((ref) => ref.released === 0));
  a(); b(); c(); f.advance(100);
  assert.ok(f.references.every((ref) => ref.released === 1)); f.pool.dispose();
});

test('capacity demotion preserves every visible token until its own final detach', () => {
  const f = fixture({ maxSessions: 2 }); f.add('A'); f.add('B');
  const firstA = f.pool.attach('A'), secondA = f.pool.attach('A');
  f.advance(1); const b = f.pool.attach('B');
  f.pool.configure({ maxSessions: 1, idleMs: 100 });
  assert.equal(f.references[0].released, 1);
  f.pool.configure({ maxSessions: 2, idleMs: 100 });
  assert.equal(f.references.length, 3, 'A demand survives reference demotion');
  firstA(); firstA(); f.advance(200);
  assert.equal(f.references[2].released, 0, 'second A viewer is still visible');
  secondA(); f.advance(50); f.pool.noteGeneration();
  f.pool.configure({ maxSessions: 2, idleMs: 100 });
  f.advance(49); assert.equal(f.references[2].released, 0);
  f.advance(1); assert.equal(f.references[2].released, 1);
  b(); f.pool.dispose();
});

test('detaching pending demand removes its subscription and cannot later retain it', () => {
  const f = fixture({ maxSessions: 1 }); f.add('A'); const native = f.add('B');
  const a = f.pool.attach('A'), firstB = f.pool.attach('B'), secondB = f.pool.attach('B');
  assert.equal(native.listeners.size, 1, 'one observer per active pending generation');
  firstB(); assert.equal(native.listeners.size, 1);
  secondB(); secondB(); assert.equal(native.listeners.size, 0);
  a(); f.pool.configure({ maxSessions: 2, idleMs: 100 }); f.advance(100);
  assert.deepEqual(f.references.map((ref) => ref.id), ['A']);
  assert.equal(f.timers.size, 0); f.pool.dispose();
});

test('pending demand is discarded immediately when native state becomes unusable', () => {
  for (const patch of [{ removed: true }, { openState: 'cold' }, { openState: 'error' }]) {
    const f = fixture({ maxSessions: 1 }); f.add('A'); const native = f.add('B');
    const a = f.pool.attach('A'), b = f.pool.attach('B');
    assert.equal(native.listeners.size, 1);
    native.update(patch); assert.equal(native.listeners.size, 0);
    native.update({ removed: false, openState: 'open' });
    f.pool.configure({ maxSessions: 2, idleMs: 100 });
    assert.deepEqual(f.references.map((ref) => ref.id), ['A'], 'pool must not retry a terminal/cold demand');
    a(); b(); f.pool.dispose();
  }
});

test('a late rejection after demotion cannot release a new reference for the same generation', async () => {
  const f = fixture({ maxSessions: 2 }); f.add('A'); f.add('B');
  const a = f.pool.attach('A'); f.advance(1); const b = f.pool.attach('B');
  f.pool.configure({ maxSessions: 1, idleMs: 100 });
  f.pool.configure({ maxSessions: 2, idleMs: 100 });
  assert.equal(f.references.length, 3);
  f.references[0].reject(new Error('late rejection from released owner')); await Promise.resolve();
  assert.equal(f.references[0].released, 1);
  assert.equal(f.references[2].released, 0); assert.equal(f.pool.getSnapshot().failures, 0);
  a(); b(); f.pool.dispose();
  assert.ok(f.references.every((ref) => ref.released === 1));
});

test('pending generation changes do not open or subscribe to a replacement implicitly', () => {
  const f = fixture({ maxSessions: 1 }); f.add('A'); const old = f.add('B');
  const a = f.pool.attach('A'), b = f.pool.attach('B');
  const replacement = f.add('B');
  f.pool.configure({ maxSessions: 2, idleMs: 100 });
  assert.deepEqual(f.references.map((ref) => ref.id), ['A']);
  assert.equal(old.listeners.size, 0); assert.equal(replacement.listeners.size, 0);
  b(); a(); f.pool.dispose();
});

test('a binding change during retain cannot pin an unobserved generation', () => {
  const f = fixture(); f.add('A'); const retain = f.sessions.retain;
  f.sessions.retain = (id, options) => { f.add(id, 'cold'); return retain(id, options); };
  f.pool.attach('A')();
  assert.equal(f.references[0].released, 1);
  assert.equal(f.pool.getSnapshot().retained, 0); assert.equal(f.timers.size, 0);
  f.pool.dispose();
});

test('synchronous terminal notification during subscription setup cleans up the returned disposer', () => {
  const f = fixture(); const native = f.add('A');
  const subscribe = native.binding.session.subscribe;
  native.binding.session.subscribe = (listener) => {
    const unsubscribe = subscribe(listener);
    native.update({ removed: true });
    return unsubscribe;
  };
  f.pool.attach('A')();
  assert.equal(f.references[0].released, 1);
  assert.equal(native.listeners.size, 0, 'setup callback must not orphan its later-returned disposer');
  assert.equal(f.pool.getSnapshot().retained, 0); f.pool.dispose();
});

test('throwing pool subscribers cannot strand visible tokens or prevent other notifications', () => {
  const f = fixture(); f.add('A'); const error = new Error('broken subscriber'); let notices = 0;
  f.pool.subscribe(() => { throw error; }); f.pool.subscribe(() => notices++);
  let detach;
  assert.doesNotThrow(() => { detach = f.pool.attach('A'); });
  assert.equal(notices, 1); assert.deepEqual(f.errors, [error]);
  detach(); f.advance(100);
  assert.equal(notices, 2); assert.equal(f.references[0].released, 1); f.pool.dispose();
});

test('throwing native unsubscribe cannot prevent reference release or peer cleanup', () => {
  const f = fixture(); const native = f.add('A'); f.add('B');
  const subscribe = native.binding.session.subscribe, error = new Error('broken unsubscribe');
  native.binding.session.subscribe = (listener) => {
    const unsubscribe = subscribe(listener);
    return () => { unsubscribe(); throw error; };
  };
  f.pool.attach('A'); f.pool.attach('B');
  assert.doesNotThrow(() => f.pool.dispose());
  assert.equal(native.listeners.size, 0); assert.deepEqual(f.errors, [error]);
  assert.ok(f.references.every((ref) => ref.released === 1)); f.pool.dispose();
  assert.ok(f.references.every((ref) => ref.released === 1));
});

test('throwing native release cannot prevent peer cleanup or cause a second release attempt', () => {
  const f = fixture(); f.add('A'); f.add('B'); f.pool.attach('A'); f.pool.attach('B');
  const error = new Error('broken release');
  f.references[0].release = function () { this.released++; throw error; };
  assert.doesNotThrow(() => f.pool.dispose());
  assert.deepEqual(f.errors, [error]); assert.ok(f.references.every((ref) => ref.released === 1));
  f.pool.dispose(); assert.ok(f.references.every((ref) => ref.released === 1));
});

test('throwing error reporting cannot escape native callbacks or promise rejection handlers', async () => {
  const f = fixture({ reportError() { throw new Error('broken error sink'); } });
  const native = f.add('A'); f.pool.attach('A');
  assert.doesNotThrow(() => native.update({ openState: 'error' }));
  f.add('B'); f.pool.attach('B'); f.references[1].reject(new Error('failed ready'));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.pool.getSnapshot().failures, 2);
  assert.ok(f.references.every((ref) => ref.released === 1)); f.pool.dispose();
});

test('unchanged external snapshots do not notify subscribers or change identity', () => {
  const f = fixture(); f.add('A'); const a = f.pool.attach('A');
  const initial = f.pool.getSnapshot(); let notices = 0; f.pool.subscribe(() => notices++);
  const secondA = f.pool.attach('A');
  f.pool.configure({ maxSessions: 8, idleMs: 100 }); f.pool.clearIdle(); secondA();
  assert.strictEqual(f.pool.getSnapshot(), initial);
  assert.equal(notices, 0);
  a(); assert.strictEqual(f.pool.getSnapshot(), initial);
  f.advance(100); assert.equal(notices, 1); f.pool.dispose();
});

test('unchanged idle deadlines keep the same armed timer across unrelated updates', () => {
  const f = fixture(); f.add('A'); f.add('B');
  f.pool.attach('A')(); const [originalTimer] = f.timers.keys();
  const b = f.pool.attach('B'); f.pool.attach('missing')(); f.pool.noteGeneration();
  f.pool.configure({ maxSessions: 8, idleMs: 100 });
  assert.deepEqual([...f.timers.keys()], [originalTimer]);
  f.advance(100); assert.equal(f.references[0].released, 1);
  assert.equal(f.references[1].released, 0); b(); f.pool.dispose();
});

test('late callbacks from canceled timers cannot replace the currently armed timer', () => {
  const f = fixture(); f.add('A'); f.pool.attach('A')();
  const oldTask = [...f.timers.values()][0];
  f.pool.configure({ maxSessions: 8, idleMs: 200 });
  const [currentTimer] = f.timers.keys(); oldTask.fn();
  assert.deepEqual([...f.timers.keys()], [currentTimer]);
  f.advance(199); assert.equal(f.references[0].released, 0);
  f.advance(1); assert.equal(f.references[0].released, 1); f.pool.dispose();
});

test('manual idle clearing and pause cannot resurrect departed or pending views', () => {
  const f = fixture({ maxSessions: 1 }); const a = f.add('A'), b = f.add('B');
  const detachA = f.pool.attach('A'), detachB = f.pool.attach('B');
  detachB(); detachA(); f.pool.clearIdle();
  f.pool.configure({ maxSessions: 8, idleMs: 100 }); f.pool.noteGeneration();
  assert.equal(f.references.length, 1); assert.equal(f.pool.getSnapshot().retained, 0);
  assert.equal(a.listeners.size, 0); assert.equal(b.listeners.size, 0);
  f.pool.configure({ maxSessions: 1, idleMs: 100 }); f.pool.attach('A'); f.pool.attach('B');
  f.pool.setEnabled(false); f.pool.setEnabled(true);
  f.pool.configure({ maxSessions: 8, idleMs: 100 });
  assert.equal(f.references.length, 2); assert.equal(a.listeners.size, 0); assert.equal(b.listeners.size, 0);
  f.pool.dispose();
});

test('failure frees capacity for another visible view without retrying the failed demand', async () => {
  const f = fixture({ maxSessions: 1 }); f.add('A'); f.add('B');
  const a = f.pool.attach('A'), b = f.pool.attach('B');
  f.references[0].reject(new Error('retained owner failed')); await Promise.resolve();
  assert.deepEqual(f.references.map((ref) => ref.id), ['A', 'B']);
  assert.equal(f.references[0].released, 1); assert.equal(f.references[1].released, 0);
  f.pool.configure({ maxSessions: 2, idleMs: 100 });
  assert.equal(f.references.length, 2); assert.equal(f.pool.getSnapshot().failures, 1);
  a(); b(); f.pool.dispose();
});

test('subscription setup failures observe late ready rejection and release just once', async () => {
  const f = fixture(); const native = f.add('A'), error = new Error('subscribe failed');
  native.binding.session.subscribe = () => { throw error; };
  assert.doesNotThrow(() => f.pool.attach('A')());
  assert.equal(f.references[0].released, 1); assert.deepEqual(f.errors, [error]);
  f.references[0].reject(new Error('late ready rejection')); await Promise.resolve();
  assert.equal(f.references[0].released, 1); assert.equal(f.pool.getSnapshot().failures, 1);
  f.pool.configure({ maxSessions: 9, idleMs: 100 });
  assert.equal(f.references.length, 1); f.pool.dispose();
});

test('a demoted view that leaves cannot be reacquired when capacity grows', () => {
  const f = fixture({ maxSessions: 2 }); const native = f.add('A'); f.add('B');
  const a = f.pool.attach('A'); f.advance(1); const b = f.pool.attach('B');
  f.pool.configure({ maxSessions: 1, idleMs: 100 });
  assert.equal(native.listeners.size, 1); a(); assert.equal(native.listeners.size, 0);
  f.pool.configure({ maxSessions: 2, idleMs: 100 });
  assert.equal(f.references.length, 2); b(); f.pool.dispose();
});

test('dispose clears pending observers and ignores subsequent rejection and stale detach', async () => {
  const f = fixture({ maxSessions: 1 }); const a = f.add('A'), b = f.add('B');
  const detachA = f.pool.attach('A'), detachB = f.pool.attach('B');
  f.pool.dispose(); detachA(); detachB();
  f.references[0].reject(new Error('rejection after teardown')); await Promise.resolve();
  assert.equal(f.references[0].released, 1); assert.deepEqual(f.errors, []);
  assert.equal(a.listeners.size, 0); assert.equal(b.listeners.size, 0);
  assert.equal(f.pool.getSnapshot().retained, 0); assert.equal(f.timers.size, 0);
});

test('reentrant diagnostics cannot acquire beyond the cap before a releasing owner is gone', () => {
  let f, detachB, reentered = false, peak = 0;
  f = fixture({ maxSessions: 1, reportEvent(event) {
    if (event.type === 'release' && event.reason === 'manual' && !reentered) {
      reentered = true;
      detachB = f.pool.attach('B');
    }
  } });
  f.add('A'); f.add('B');
  const retain = f.sessions.retain;
  f.sessions.retain = (id, options) => {
    const reference = retain(id, options);
    peak = Math.max(peak, f.references.filter((ref) => ref.released === 0).length);
    return reference;
  };
  f.pool.attach('A')(); f.pool.clearIdle();
  assert.equal(peak, 1, 'capacity must include an owner until its release completes');
  assert.deepEqual(f.references.map((ref) => ref.id), ['A', 'B']);
  assert.equal(f.references[0].released, 1); assert.equal(f.references[1].released, 0);
  detachB(); f.pool.dispose();
});

test('mixed view, capacity, generation and lifecycle transitions preserve ownership bounds', () => {
  const f = fixture({ maxSessions: 2 }); const natives = [], views = [];
  const ids = ['A', 'B', 'C', 'D', 'E', 'F'];
  const add = (id) => { const native = f.add(id); natives.push(native); return native; };
  for (const id of ids) add(id);
  let seed = 0x21f43a;
  const coverage = { operations: Array(10).fill(0), removed: 0, error: 0, pause: 0, resume: 0 };
  // Scale the full uint32 value: low-bit modulo correlated operation and terminal choices.
  const random = (limit) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return Math.floor(seed / 0x100000000 * limit); };
  for (let step = 0; step < 600; step++) {
    const id = ids[random(ids.length)];
    const operation = random(10);
    coverage.operations[operation]++;
    switch (operation) {
      case 0: case 1:
        views.push({ binding: f.sessions.binding(id), detach: f.pool.attach(id) });
        break;
      case 2:
        if (views.length) views.splice(random(views.length), 1)[0].detach();
        break;
      case 3:
        f.pool.configure({ maxSessions: 1 + random(4), idleMs: 50 + random(100) });
        break;
      case 4: f.advance(random(100)); break;
      case 5: {
        const native = natives.findLast((item) => item.binding === f.sessions.binding(id));
        const removed = random(2) === 1;
        coverage[removed ? 'removed' : 'error']++;
        native.update(removed ? { removed: true } : { openState: 'error' });
        break;
      }
      case 6: add(id); break;
      case 7: f.pool.clearIdle(); break;
      case 8: {
        const enabled = random(3) !== 0;
        coverage[enabled ? 'resume' : 'pause']++;
        f.pool.setEnabled(enabled);
        break;
      }
      case 9: f.pool.noteGeneration(); break;
    }
    const retained = f.references.filter((ref) => ref.released === 0);
    assert.equal(retained.length, f.pool.getSnapshot().retained, `retained count at step ${step}`);
    assert.ok(retained.length <= f.pool.getSnapshot().maxSessions, `capacity at step ${step}`);
    assert.equal(new Set(retained.map((ref) => ref.id)).size, retained.length);
    assert.ok(f.references.every((ref) => ref.released <= 1), `single release at step ${step}`);
    assert.ok(f.timers.size <= 1, `single timer at step ${step}`);
    for (const native of natives) {
      assert.ok(native.listeners.size <= 1, `single observer at step ${step}`);
      if (!retained.some((ref) => ref.binding === native.binding) && !views.some((view) => view.binding === native.binding)) {
        assert.equal(native.listeners.size, 0, `no departed demand at step ${step}`);
      }
    }
  }
  assert.ok(coverage.operations.every((hits) => hits > 0), 'every top-level operation is exercised');
  for (const branch of ['removed', 'error', 'pause', 'resume']) assert.ok(coverage[branch] > 0, `${branch} branch must be exercised`);
  for (const view of views) view.detach();
  f.pool.clearIdle(); f.pool.dispose();
  assert.ok(f.references.every((ref) => ref.released === 1));
  assert.ok(natives.every((native) => native.listeners.size === 0));
  assert.equal(f.timers.size, 0);
});
