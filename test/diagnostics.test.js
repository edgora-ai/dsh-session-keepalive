import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiagnostics, DIAGNOSTICS_KEY } from '../src/diagnostics.js';
import { createRetentionPool } from '../src/pool.js';

const EVENT_FIELDS = new Set(['at', 'type', 'reason', 'retained', 'maxSessions', 'idleMs', 'idleForMs', 'errorCode']);
const EVENT_TYPES = ['start', 'release', 'settings', 'connection', 'hidden', 'visible', 'offline', 'online', 'pagehide', 'pageshow', 'retain-error', 'skipped-capacity', 'stop'];
const START_REASONS = ['fresh', 'plugin-reload', 'page-reload', 'new-document', 'browser-discard', 'history-restore'];
const RELEASE_REASONS = ['expired', 'capacity', 'settings-expired', 'settings-capacity', 'replaced', 'removed', 'session-error', 'retain-rejected', 'paused', 'manual', 'disposed'];

function memoryStorage(initial) {
  const values = new Map(initial === undefined ? [] : [[DIAGNOSTICS_KEY, initial]]);
  const writes = [];
  return {
    writes,
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { writes.push({ key, value }); values.set(key, value); },
  };
}

function fakeClock(start = 0) {
  let time = start;
  let nextTimer = 0;
  const timers = new Map();
  return {
    now: () => time,
    schedule(fn, delay) {
      const id = ++nextTimer;
      timers.set(id, { fn, at: time + delay });
      return id;
    },
    cancel: (id) => timers.delete(id),
    advance(ms) {
      time += ms;
      for (const [id, task] of [...timers]) {
        if (task.at > time) continue;
        timers.delete(id);
        task.fn();
      }
    },
    get pending() { return timers.size; },
  };
}

function createTestDiagnostics(options = {}) {
  const clock = fakeClock();
  return createDiagnostics({ schedule: clock.schedule, cancel: clock.cancel, ...options });
}

function summary(patch = {}) {
  return { enabled: true, retained: 2, maxSessions: 8, idleMs: 1800000, hits: 3, failures: 1, generations: 4, ...patch };
}

function persisted(storage) {
  const raw = storage.getItem(DIAGNOSTICS_KEY);
  assert.equal(typeof raw, 'string');
  return JSON.parse(raw);
}

function assertSafeEvents(events) {
  for (const event of events) {
    assert.ok(EVENT_TYPES.includes(event.type));
    assert.ok(Number.isFinite(event.at) && event.at >= 0);
    for (const key of Object.keys(event)) assert.ok(EVENT_FIELDS.has(key), `unexpected event field: ${key}`);
    if (event.reason !== undefined) assert.ok([...START_REASONS, ...RELEASE_REASONS].includes(event.reason));
    if (event.errorCode !== undefined) {
      assert.equal(typeof event.errorCode, 'string');
      assert.ok(event.errorCode.length <= 80);
      assert.match(event.errorCode, /^[a-z][a-z0-9_-]*(?:\/[a-z0-9_-]+)?$/i);
    }
  }
}

function savedJournal() {
  const storage = memoryStorage();
  let time = 100;
  const diagnostics = createTestDiagnostics({ storage, now: () => time, pageId: 'page-before' });
  diagnostics.observe(summary());
  time = 110;
  diagnostics.record({ type: 'release', reason: 'capacity', retained: 2 });
  time = 120;
  diagnostics.dispose();
  return storage.getItem(DIAGNOSTICS_KEY);
}

test('diagnostics work without a browser or storage and use the default clock', () => {
  const before = Date.now();
  const diagnostics = createTestDiagnostics();
  const snapshot = diagnostics.getSnapshot();
  assert.ok(snapshot.startedAt >= before && snapshot.startedAt <= Date.now());
  assert.equal(snapshot.startReason, 'fresh');
  assert.equal(snapshot.previousState, null);
  assert.equal(snapshot.state, null);
  assert.equal(snapshot.storageAvailable, false);
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.events[0].type, 'start');
  assert.equal(snapshot.events[0].reason, 'fresh');
  assert.ok(Object.isFrozen(snapshot.events));
  assert.strictEqual(diagnostics.getSnapshot(), snapshot);
  assert.doesNotThrow(() => {
    diagnostics.record({ type: 'offline' });
    diagnostics.observe(summary());
    diagnostics.dispose();
  });
});

test('startup records an injected timestamp and uses the exported storage key', () => {
  const storage = memoryStorage();
  const diagnostics = createTestDiagnostics({ storage, now: () => 1234 });
  const snapshot = diagnostics.getSnapshot();
  assert.equal(snapshot.startedAt, 1234);
  assert.equal(snapshot.storageAvailable, true);
  assert.deepEqual(snapshot.events, [{ at: 1234, type: 'start', reason: 'fresh' }]);
  assert.equal(typeof DIAGNOSTICS_KEY, 'string');
  assert.ok(DIAGNOSTICS_KEY.length > 0);
  assert.equal(storage.writes.length, 0, 'startup is part of the first persistence batch');
  diagnostics.flush();
  assert.equal(storage.writes.length, 1);
  assert.ok(storage.writes.every(({ key, value }) => key === DIAGNOSTICS_KEY && typeof value === 'string'));
  assert.deepEqual(persisted(storage).events, snapshot.events);
  diagnostics.dispose();
});

for (const [name, options, expected] of [
  ['same document', { pageId: 'page-before' }, 'plugin-reload'],
  ['same document after reload navigation', { pageId: 'page-before', navigation: 'reload' }, 'plugin-reload'],
  ['same document originally discarded by browser', { pageId: 'page-before', discarded: true }, 'plugin-reload'],
  ['different document', { pageId: 'page-after' }, 'new-document'],
  ['page reload', { pageId: 'page-after', navigation: 'reload' }, 'page-reload'],
  ['history restore', { pageId: 'page-after', navigation: 'back_forward' }, 'history-restore'],
  ['discarded reload', { pageId: 'page-after', navigation: 'reload', discarded: true }, 'browser-discard'],
]) {
  test(`startup distinguishes ${name} and reloads only the previous observed summary`, () => {
    const storage = memoryStorage(savedJournal());
    const diagnostics = createTestDiagnostics({ storage, now: () => 200, ...options });
    const snapshot = diagnostics.getSnapshot();
    assert.equal(snapshot.startedAt, 200);
    assert.equal(snapshot.startReason, expected);
    assert.equal(snapshot.state, null);
    assert.deepEqual(snapshot.previousState, summary());
    assert.deepEqual(snapshot.events[0], { at: 200, type: 'start', reason: expected });
    assert.deepEqual(snapshot.events.slice(1), [
      { at: 120, type: 'stop' },
      { at: 110, type: 'release', reason: 'capacity', retained: 2 },
      { at: 100, type: 'start', reason: 'fresh' },
    ]);
    diagnostics.observe(summary({ retained: 1, hits: 9 }));
    assert.deepEqual(diagnostics.getSnapshot().state, summary({ retained: 1, hits: 9 }));
    assert.deepEqual(diagnostics.getSnapshot().previousState, summary());
    assert.equal(snapshot.state, null, 'an old snapshot must not be mutated by observe');
    diagnostics.dispose();
  });
}

for (const [options, expected] of [
  [{}, 'fresh'],
  [{ navigation: 'reload' }, 'page-reload'],
  [{ navigation: 'reload', discarded: true }, 'browser-discard'],
]) {
  test(`startup without a saved journal reports ${expected}`, () => {
    const diagnostics = createTestDiagnostics({ storage: memoryStorage(), now: () => 100, pageId: 'new-page', ...options });
    assert.equal(diagnostics.getSnapshot().startReason, expected);
    assert.equal(diagnostics.getSnapshot().previousState, null);
    diagnostics.dispose();
  });
}

test('observe copies only summary fields and the next document sees the latest observed state', () => {
  const storage = memoryStorage();
  const diagnostics = createTestDiagnostics({ storage, now: () => 100, pageId: 'page-a' });
  const input = { ...summary(), sessionId: 'SESSION_SECRET', sessions: ['SESSION_SECRET'], url: 'https://private.example/chat', text: 'PRIVATE_CHAT_TEXT', extra: { message: 'PRIVATE_CHAT_TEXT' } };
  diagnostics.observe(input);
  const observed = diagnostics.getSnapshot();
  assert.deepEqual(observed.state, summary());
  input.retained = 0;
  input.hits = 999;
  assert.deepEqual(observed.state, summary());
  diagnostics.observe(summary({ retained: 1, generations: 5 }));
  diagnostics.flush();
  assert.deepEqual(persisted(storage).state, summary({ retained: 1, generations: 5 }));
  diagnostics.dispose();
  const next = createTestDiagnostics({ storage, now: () => 200, pageId: 'page-b' });
  assert.equal(next.getSnapshot().state, null);
  assert.deepEqual(next.getSnapshot().previousState, summary({ retained: 1, generations: 5 }));
  const raw = storage.getItem(DIAGNOSTICS_KEY);
  for (const secret of ['SESSION_SECRET', 'https://private.example/chat', 'PRIVATE_CHAT_TEXT', 'sessionId', 'sessions', 'extra']) {
    assert.ok(!raw.includes(secret), `persisted summary leaked ${secret}`);
  }
  diagnostics.dispose();
  next.dispose();
});

test('record accepts the lifecycle event vocabulary and both reason vocabularies', () => {
  let time = 100;
  const diagnostics = createTestDiagnostics({ now: () => time });
  for (const type of EVENT_TYPES) {
    time++;
    diagnostics.record({ type });
    assert.deepEqual(diagnostics.getSnapshot().events[0], { at: time, type });
  }
  for (const reason of RELEASE_REASONS) {
    time++;
    diagnostics.record({ type: 'release', reason });
    assert.equal(diagnostics.getSnapshot().events[0].reason, reason);
  }
  for (const reason of START_REASONS) {
    diagnostics.record({ type: 'start', reason });
    assert.equal(diagnostics.getSnapshot().events[0].reason, reason);
  }
  assertSafeEvents(diagnostics.getSnapshot().events);
  diagnostics.dispose();
});

test('record stamps now and persists only safe whitelisted metadata', () => {
  const storage = memoryStorage();
  const diagnostics = createTestDiagnostics({ storage, now: () => 4242 });
  diagnostics.record({
    at: 1, type: 'release', reason: 'settings-capacity', retained: 2, maxSessions: 4,
    idleMs: 5000, idleForMs: 42, errorCode: 'session/not-found',
    sessionId: 'SESSION_SECRET', sessionIds: ['SESSION_SECRET'], id: 'SESSION_SECRET',
    url: 'https://private.example/chat', text: 'PRIVATE_CHAT_TEXT', title: 'PRIVATE_CHAT_TEXT',
    message: 'PRIVATE_ERROR_MESSAGE', error: new Error('PRIVATE_ERROR_MESSAGE'),
    nested: { sessionId: 'SESSION_SECRET' },
  });
  const expected = { at: 4242, type: 'release', reason: 'settings-capacity', retained: 2, maxSessions: 4, idleMs: 5000, idleForMs: 42, errorCode: 'session/not-found' };
  assert.deepEqual(diagnostics.getSnapshot().events[0], expected);
  diagnostics.flush();
  assert.deepEqual(persisted(storage).events[0], expected);
  assertSafeEvents(persisted(storage).events);
  const raw = storage.getItem(DIAGNOSTICS_KEY);
  for (const secret of ['SESSION_SECRET', 'https://private.example/chat', 'PRIVATE_CHAT_TEXT', 'PRIVATE_ERROR_MESSAGE', 'sessionId', 'nested']) {
    assert.ok(!raw.includes(secret), `event journal leaked ${secret}`);
  }
  diagnostics.dispose();
});

test('unsafe reasons, error codes and values cannot turn whitelisted fields into a text channel', () => {
  const storage = memoryStorage();
  const diagnostics = createTestDiagnostics({ storage, now: () => 100 });
  for (const errorCode of ['', 'private error message', 'private\nmessage', '雪', { code: 'SESSION_SECRET' }, null, 123, 'a'.repeat(81), 'https://private.example/session/secret', 'file:///private/secret', '//private.example/secret', '/Users/private/secret', '../private', 'www.private.example', 'data:private', 'gateway/internal:private']) {
    diagnostics.record({ type: 'retain-error', reason: 'PRIVATE_REASON_TEXT', retained: 'SESSION_SECRET', maxSessions: { id: 'SESSION_SECRET' }, idleMs: 'PRIVATE_CHAT_TEXT', idleForMs: Infinity, errorCode });
    const event = diagnostics.getSnapshot().events[0];
    assert.equal(event.reason, undefined);
    assert.equal(event.retained, undefined);
    assert.equal(event.maxSessions, undefined);
    assert.equal(event.idleMs, undefined);
    assert.equal(event.idleForMs, undefined);
    assertSafeEvents([event]);
    if (errorCode !== 'a'.repeat(81)) assert.equal(event.errorCode, undefined);
  }
  const longestCode = 'A'.repeat(80);
  diagnostics.record({ type: 'retain-error', errorCode: longestCode });
  assert.equal(diagnostics.getSnapshot().events[0].errorCode, longestCode);
  diagnostics.flush();
  const raw = storage.getItem(DIAGNOSTICS_KEY);
  for (const secret of ['PRIVATE_REASON_TEXT', 'SESSION_SECRET', 'PRIVATE_CHAT_TEXT', 'private error message', 'private\\nmessage']) assert.ok(!raw.includes(secret));
  assertSafeEvents(persisted(storage).events);
  diagnostics.dispose();
});

test('invalid event types do not publish, persist or replace a stable snapshot', () => {
  const storage = memoryStorage();
  const diagnostics = createTestDiagnostics({ storage, now: () => 100 });
  let calls = 0;
  diagnostics.subscribe(() => calls++);
  const snapshot = diagnostics.getSnapshot();
  const writes = storage.writes.length;
  for (const event of [undefined, null, {}, [], 'release', { type: 'PRIVATE_CHAT_TEXT' }, { type: 'RELEASE' }, { type: 'toString' }]) {
    assert.doesNotThrow(() => diagnostics.record(event));
    assert.strictEqual(diagnostics.getSnapshot(), snapshot);
  }
  assert.equal(calls, 0);
  assert.equal(storage.writes.length, writes);
  diagnostics.dispose();
});

test('events stay newest-first, immutable and bounded in memory and persistent storage', () => {
  const storage = memoryStorage();
  let time = 0;
  const diagnostics = createTestDiagnostics({ storage, now: () => time });
  const firstEvents = diagnostics.getSnapshot().events;
  for (let i = 1; i <= 100; i++) {
    time = i;
    diagnostics.record({ type: 'release', reason: 'expired', retained: 1, maxSessions: 8, idleMs: 1800000, idleForMs: i, errorCode: 'E'.repeat(80), text: 'PRIVATE_LARGE_TEXT'.repeat(2000) });
    assert.ok(diagnostics.getSnapshot().events.length <= 20);
    assert.equal(storage.writes.length, 0, 'a burst should not serialize each bounded event array');
  }
  diagnostics.flush();
  assert.equal(storage.writes.length, 1);
  assert.ok(storage.getItem(DIAGNOSTICS_KEY).length < 16000, 'serialized metadata must remain bounded regardless of input text');
  const snapshot = diagnostics.getSnapshot();
  assert.equal(snapshot.events.length, 20);
  assert.deepEqual(snapshot.events.map(({ at }) => at), Array.from({ length: 20 }, (_, i) => 100 - i));
  assert.deepEqual(persisted(storage).events, snapshot.events);
  assert.ok(Object.isFrozen(snapshot.events));
  assert.throws(() => snapshot.events.push({ type: 'online', at: 101 }), TypeError);
  assert.deepEqual(firstEvents, [{ at: 0, type: 'start', reason: 'fresh' }]);
  assert.ok(!storage.getItem(DIAGNOSTICS_KEY).includes('PRIVATE_LARGE_TEXT'));
  diagnostics.dispose();
});

test('untrusted stored events and summaries are whitelisted and bounded again on startup', () => {
  const saved = JSON.parse(savedJournal());
  saved.text = 'PRIVATE_CHAT_TEXT';
  saved.state = { ...summary(), sessionId: 'SESSION_SECRET', text: 'PRIVATE_CHAT_TEXT' };
  saved.events = Array.from({ length: 40 }, (_, i) => ({
    at: 1000 - i, type: i % 5 === 0 ? 'not-an-event' : 'retain-error', reason: 'PRIVATE_REASON_TEXT',
    retained: 2, errorCode: 'PRIVATE ERROR MESSAGE', sessionId: 'SESSION_SECRET', url: 'https://private.example',
  }));
  const storage = memoryStorage(JSON.stringify(saved));
  const diagnostics = createTestDiagnostics({ storage, now: () => 2000, pageId: 'page-after' });
  const snapshot = diagnostics.getSnapshot();
  assert.deepEqual(snapshot.previousState, summary());
  assert.equal(snapshot.state, null);
  assert.equal(snapshot.events[0].type, 'start');
  assert.ok(snapshot.events.some(({ type }) => type === 'retain-error'), 'valid prior events should survive sanitation');
  assert.ok(snapshot.events.length <= 20);
  assert.ok(Object.isFrozen(snapshot.events));
  assertSafeEvents(snapshot.events);
  diagnostics.flush();
  assertSafeEvents(persisted(storage).events);
  assert.ok(persisted(storage).events.length <= 20);
  const raw = storage.getItem(DIAGNOSTICS_KEY);
  for (const secret of ['PRIVATE_CHAT_TEXT', 'SESSION_SECRET', 'PRIVATE_REASON_TEXT', 'PRIVATE ERROR MESSAGE', 'https://private.example', 'not-an-event']) assert.ok(!raw.includes(secret));
  diagnostics.dispose();
});

test('malformed stored summaries and individual events are ignored without leaking their fields', () => {
  const saved = JSON.parse(savedJournal());
  saved.state.retained = 'SESSION_SECRET';
  saved.events = [null, {}, { type: 'release', at: 'SESSION_SECRET', reason: 'expired' }, { type: 'release', at: -1 }, { type: 'retain-error', at: 50, errorCode: 'PRIVATE ERROR MESSAGE' }];
  const storage = memoryStorage(JSON.stringify(saved));
  let diagnostics;
  assert.doesNotThrow(() => diagnostics = createTestDiagnostics({ storage, now: () => 200, pageId: 'page-after' }));
  const snapshot = diagnostics.getSnapshot();
  assert.equal(snapshot.previousState, null);
  assert.equal(snapshot.state, null);
  assert.deepEqual(snapshot.events, [{ at: 200, type: 'start', reason: 'new-document' }, { at: 50, type: 'retain-error' }]);
  diagnostics.flush();
  assert.ok(!storage.getItem(DIAGNOSTICS_KEY).includes('SESSION_SECRET'));
  assert.ok(!storage.getItem(DIAGNOSTICS_KEY).includes('PRIVATE ERROR MESSAGE'));
  diagnostics.dispose();
});

test('missing, malformed, wrong-shaped and oversized journals never prevent local diagnostics', () => {
  for (const raw of ['', '{', 'null', '[]', '42', '"not-a-journal"', '{}', '{"version":1,"pageId":"old","events":"not-an-array"}', ' '.repeat(21000)]) {
    const storage = memoryStorage(raw);
    let diagnostics;
    assert.doesNotThrow(() => diagnostics = createTestDiagnostics({ storage, now: () => 100, pageId: 'page-new' }));
    assert.equal(diagnostics.getSnapshot().startReason, 'fresh');
    assert.equal(diagnostics.getSnapshot().previousState, null);
    assert.equal(diagnostics.getSnapshot().state, null);
    assert.equal(diagnostics.getSnapshot().storageAvailable, true, 'corrupt metadata must not disable working storage');
    assert.deepEqual(diagnostics.getSnapshot().events, [{ at: 100, type: 'start', reason: 'fresh' }]);
    diagnostics.flush();
    assert.deepEqual(persisted(storage).events, diagnostics.getSnapshot().events, 'bad metadata should be replaced by the new start event');
    assert.doesNotThrow(() => {
      diagnostics.observe(summary());
      diagnostics.record({ type: 'online' });
      diagnostics.dispose();
    });
  }
});

test('subscriptions see stable snapshots, can unsubscribe, and do not hear updates after disposal', () => {
  let time = 100;
  const diagnostics = createTestDiagnostics({ storage: memoryStorage(), now: () => time });
  const seen = [];
  const unsubscribe = diagnostics.subscribe(() => seen.push(diagnostics.getSnapshot()));
  const initial = diagnostics.getSnapshot();
  assert.equal(seen.length, 0);
  assert.strictEqual(diagnostics.getSnapshot(), initial);
  time++;
  diagnostics.record({ type: 'online' });
  const recorded = diagnostics.getSnapshot();
  assert.notStrictEqual(recorded, initial);
  assert.deepEqual(seen, [], 'snapshots change immediately, listeners are batched');
  assert.strictEqual(diagnostics.getSnapshot(), recorded);
  diagnostics.observe(summary());
  const observed = diagnostics.getSnapshot();
  assert.notStrictEqual(observed, recorded);
  assert.strictEqual(observed.events, recorded.events, 'state-only changes reuse the immutable event array');
  diagnostics.observe({ ...summary(), ignoredExtra: 'PRIVATE_CHAT_TEXT' });
  assert.strictEqual(diagnostics.getSnapshot(), observed);
  diagnostics.flush();
  assert.deepEqual(seen, [observed], 'observe and record publish their latest combined result once');
  assert.strictEqual(diagnostics.getSnapshot(), observed, 'successful persistence does not churn snapshots');
  diagnostics.flush();
  assert.equal(seen.length, 1);
  unsubscribe();
  unsubscribe();
  diagnostics.record({ type: 'offline' });
  diagnostics.flush();
  assert.equal(seen.length, 1);
  diagnostics.dispose();
  assert.equal(seen.length, 1);
});

test('dispose appends one stop, drops listeners, and makes later mutations and subscriptions inert', () => {
  const storage = memoryStorage();
  let time = 100;
  const diagnostics = createTestDiagnostics({ storage, now: () => time });
  diagnostics.observe(summary());
  let calls = 0;
  const unsubscribe = diagnostics.subscribe(() => calls++);
  time = 200;
  diagnostics.dispose();
  const stopped = diagnostics.getSnapshot();
  assert.deepEqual(stopped.events[0], { at: 200, type: 'stop' });
  assert.equal(stopped.events.filter(({ type }) => type === 'stop').length, 1);
  assert.deepEqual(persisted(storage).events, stopped.events);
  const writes = storage.writes.length;
  const callsAfterDispose = calls;
  diagnostics.subscribe(() => calls++);
  time = 300;
  assert.doesNotThrow(() => {
    diagnostics.dispose();
    diagnostics.record({ type: 'online' });
    diagnostics.observe(summary({ retained: 0 }));
    unsubscribe();
  });
  assert.strictEqual(diagnostics.getSnapshot(), stopped);
  assert.equal(storage.writes.length, writes);
  assert.equal(calls, callsAfterDispose);
});

test('one fixed-window task coalesces synchronous observe/record bursts without postponing writes', () => {
  const clock = fakeClock();
  const storage = memoryStorage();
  const diagnostics = createTestDiagnostics({ storage, ...clock });
  clock.advance(100);
  let calls = 0;
  diagnostics.subscribe(() => calls++);
  const writes = storage.writes.length;
  try {
    for (let i = 1; i <= 10; i++) {
      diagnostics.observe(summary({ generations: i }));
      diagnostics.record({ type: 'connection', ...summary({ generations: i }) });
      clock.advance(9);
    }
    assert.equal(storage.writes.length, writes, 'no synchronous serialization or storage write per mutation');
    assert.equal(calls, 0, 'listeners should not hear duplicate intermediate summaries');
    assert.equal(clock.pending, 1, 'one pending task, not one timer per event');
    clock.advance(10);
    assert.equal(storage.writes.length, writes + 1, 'continuous activity must not postpone the first deadline');
    assert.equal(calls, 1);
    assert.equal(persisted(storage).state.generations, 10);
    assert.strictEqual(diagnostics.getSnapshot(), diagnostics.getSnapshot());
    assert.equal(clock.pending, 0);
  } finally {
    diagnostics.dispose();
  }
});

test('throwing diagnostic listeners cannot interrupt native retention or starve other listeners', () => {
  const clock = fakeClock();
  const diagnostics = createTestDiagnostics({ ...clock });
  const binding = { session: { getSnapshot: () => ({ openState: 'open', removed: false }), subscribe: () => () => {} } };
  let releases = 0;
  const pool = createRetentionPool({
    binding: () => binding,
    retain: () => ({ binding, ready: Promise.resolve(), release: () => releases++ }),
  }, { ...clock, idleMs: 100, reportEvent: diagnostics.record });
  diagnostics.observe(pool.getSnapshot());
  clock.advance(100);
  const unsubscribe = pool.subscribe(() => diagnostics.observe(pool.getSnapshot()));
  const stopThrowing = diagnostics.subscribe(() => { throw new Error('diagnostic observer failed'); });
  let heard = 0;
  diagnostics.subscribe(() => heard++);
  try {
    let detach;
    assert.doesNotThrow(() => { detach = pool.attach('SESSION_SECRET'); });
    assert.equal(pool.getSnapshot().retained, 1);
    assert.doesNotThrow(() => clock.advance(100));
    assert.equal(heard, 1);
    detach();
    assert.doesNotThrow(() => clock.advance(100));
    assert.equal(releases, 1);
    assert.equal(pool.getSnapshot().retained, 0);
    assert.doesNotThrow(() => diagnostics.flush());
    assert.ok(heard >= 2);
    assert.doesNotThrow(() => diagnostics.dispose());
    assert.equal(clock.pending, 0);
  } finally {
    stopThrowing();
    unsubscribe();
    pool.dispose();
    diagnostics.dispose();
  }
});

test('connection spam keeps only its latest indication without evicting release or lifecycle evidence', () => {
  const clock = fakeClock(100);
  const storage = memoryStorage();
  const diagnostics = createTestDiagnostics({ storage, ...clock });
  try {
    diagnostics.record({ type: 'release', reason: 'expired', retained: 1 });
    diagnostics.record({ type: 'offline' });
    for (let i = 0; i < 100; i++) {
      clock.advance(1);
      diagnostics.record({ type: 'connection', retained: 2, text: 'PRIVATE_CHAT_TEXT' });
    }
    const snapshot = diagnostics.getSnapshot();
    assert.equal(snapshot.events.filter(({ type }) => type === 'connection').length, 1);
    assert.ok(snapshot.events.some(({ type }) => type === 'release'));
    assert.ok(snapshot.events.some(({ type }) => type === 'offline'));
    assert.deepEqual(snapshot.events[0], { at: 200, type: 'connection', retained: 2 });
    diagnostics.flush();
    assert.deepEqual(persisted(storage).events, snapshot.events);
  } finally {
    diagnostics.dispose();
  }
});

test('a startup without a current observation never erases the last recorded previous state', () => {
  const storage = memoryStorage(savedJournal());
  const clock = fakeClock(200);
  const diagnostics = createTestDiagnostics({ storage, ...clock, pageId: 'page-between' });
  assert.deepEqual(diagnostics.getSnapshot().previousState, summary());
  assert.equal(diagnostics.getSnapshot().state, null);
  diagnostics.dispose();
  assert.deepEqual(persisted(storage).state, summary());
  const next = createTestDiagnostics({ storage, ...clock, pageId: 'page-after' });
  try {
    assert.deepEqual(next.getSnapshot().previousState, summary());
    next.observe(summary({ retained: 0 }));
    next.dispose();
    assert.deepEqual(persisted(storage).state, summary({ retained: 0 }), 'a real empty pool must replace previous state');
  } finally {
    next.dispose();
  }
});

for (const boundary of ['hidden', 'pagehide']) {
  test(`${boundary} records synchronously flush pending metadata and cancel the only batch timer`, () => {
    const clock = fakeClock(100);
    const storage = memoryStorage();
    const diagnostics = createTestDiagnostics({ storage, ...clock });
    let calls = 0;
    diagnostics.subscribe(() => calls++);
    diagnostics.observe(summary());
    diagnostics.record({ type: 'release', reason: 'expired', retained: 1 });
    assert.equal(clock.pending, 1);
    assert.equal(storage.writes.length, 0);
    diagnostics.record({ type: boundary });
    assert.equal(clock.pending, 0);
    assert.equal(storage.writes.length, 1);
    assert.equal(calls, 1);
    assert.deepEqual(persisted(storage).state, summary());
    assert.deepEqual(persisted(storage).events, diagnostics.getSnapshot().events);
    assert.equal(persisted(storage).events[0].type, boundary);
    const saved = diagnostics.getSnapshot();
    diagnostics.flush();
    clock.advance(100);
    assert.strictEqual(diagnostics.getSnapshot(), saved);
    assert.equal(storage.writes.length, 1, 'cancelled work must not write again');
    // A lifecycle flush does not dispose the journal; BFCache/foreground return
    // can keep recording without a new startup or restoring a retained Session.
    diagnostics.record({ type: 'pageshow' });
    diagnostics.observe(summary({ retained: 0 }));
    assert.equal(clock.pending, 1);
    diagnostics.dispose();
    assert.equal(clock.pending, 0);
    assert.equal(storage.writes.length, 2);
    assert.equal(persisted(storage).events[0].type, 'stop');
    assert.equal(persisted(storage).state.retained, 0);
    assert.equal(persisted(storage).events.filter(({ type }) => type === 'start').length, 1);
    assert.equal(calls, 1, 'disposed listeners do not receive the final write');
    clock.advance(100);
    assert.equal(storage.writes.length, 2);
  });
}

test('reentrant subscriber changes keep a trailing batch that disposal saves without a timer leak', () => {
  const clock = fakeClock();
  const storage = memoryStorage();
  const diagnostics = createTestDiagnostics({ storage, ...clock });
  let calls = 0;
  diagnostics.subscribe(() => {
    calls++;
    if (calls === 1) diagnostics.observe(summary({ retained: 1 }));
  });
  diagnostics.observe(summary({ retained: 2 }));
  clock.advance(100);
  assert.equal(calls, 1);
  assert.equal(clock.pending, 1);
  assert.equal(persisted(storage).state.retained, 2);
  assert.equal(diagnostics.getSnapshot().state.retained, 1);
  diagnostics.dispose();
  assert.equal(clock.pending, 0);
  assert.equal(persisted(storage).state.retained, 1);
  assert.equal(persisted(storage).events[0].type, 'stop');
  assert.equal(storage.writes.length, 2);
  assert.equal(calls, 1);
  const stopped = diagnostics.getSnapshot();
  diagnostics.dispose();
  diagnostics.flush();
  clock.advance(100);
  assert.strictEqual(diagnostics.getSnapshot(), stopped);
  assert.equal(storage.writes.length, 2);
  assert.equal(clock.pending, 0);
});

test('an already queued cancelled callback cannot drain a newer batch', () => {
  const clock = fakeClock();
  const callbacks = [];
  const storage = memoryStorage();
  const diagnostics = createTestDiagnostics({ storage, ...clock, schedule(fn, delay) {
    callbacks.push(fn);
    return clock.schedule(fn, delay);
  } });
  diagnostics.observe(summary());
  diagnostics.flush();
  assert.equal(clock.pending, 0);
  assert.equal(storage.writes.length, 1);
  diagnostics.record({ type: 'offline' });
  assert.equal(clock.pending, 1);
  callbacks[0]();
  assert.equal(storage.writes.length, 1);
  assert.equal(clock.pending, 1);
  diagnostics.dispose();
  assert.equal(storage.writes.length, 2);
  callbacks[1]();
  assert.equal(storage.writes.length, 2);
  assert.equal(clock.pending, 0);
});

test('deferred storage failure updates availability once without retry churn or observer exceptions', () => {
  const clock = fakeClock();
  let attempts = 0;
  const storage = { getItem: () => null, setItem() { attempts++; throw new Error('PRIVATE_ERROR_MESSAGE'); } };
  const diagnostics = createTestDiagnostics({ storage, ...clock });
  let calls = 0;
  diagnostics.subscribe(() => { throw new Error('PRIVATE_OBSERVER_MESSAGE'); });
  diagnostics.subscribe(() => calls++);
  const initial = diagnostics.getSnapshot();
  assert.equal(initial.storageAvailable, true);
  assert.doesNotThrow(() => clock.advance(100));
  const failed = diagnostics.getSnapshot();
  assert.equal(failed.storageAvailable, false);
  assert.notStrictEqual(failed, initial);
  assert.equal(initial.storageAvailable, true);
  assert.equal(calls, 1);
  assert.equal(attempts, 1);
  assert.equal(clock.pending, 0);
  diagnostics.observe(summary());
  diagnostics.record({ type: 'online' });
  assert.doesNotThrow(() => clock.advance(100));
  assert.equal(calls, 2);
  assert.equal(attempts, 1);
  assertSafeEvents(diagnostics.getSnapshot().events);
  assert.ok(!JSON.stringify(diagnostics.getSnapshot()).includes('PRIVATE_'));
  diagnostics.dispose();
  assert.equal(attempts, 1);
  assert.equal(clock.pending, 0);
});

test('startup coalesces stored connection spam before applying the 20-event bound', () => {
  const saved = JSON.parse(savedJournal());
  saved.events = [
    ...Array.from({ length: 18 }, (_, i) => ({ at: 200 - i, type: 'connection', url: 'https://private.example' })),
    { at: 180, type: 'release', reason: 'capacity', sessionId: 'SESSION_SECRET' },
    { at: 179, type: 'pagehide' },
  ];
  const storage = memoryStorage(JSON.stringify(saved));
  const diagnostics = createTestDiagnostics({ storage, now: () => 300, pageId: 'page-after' });
  assert.deepEqual(diagnostics.getSnapshot().events.map(({ type }) => type), ['start', 'connection', 'release', 'pagehide']);
  diagnostics.flush();
  assertSafeEvents(persisted(storage).events);
  assert.ok(!storage.getItem(DIAGNOSTICS_KEY).includes('SESSION_SECRET'));
  assert.ok(!storage.getItem(DIAGNOSTICS_KEY).includes('https://private.example'));
  diagnostics.dispose();
});

for (const [name, storage] of [
  ['unavailable', undefined],
  ['missing methods', {}],
  ['read failure', { getItem() { throw new Error('storage blocked'); }, setItem() { throw new Error('storage blocked'); } }],
  ['write failure', { getItem() { return null; }, setItem() { throw new Error('quota exceeded'); } }],
]) {
  test(`${name} storage does not throw or alter retention reuse and expiry`, () => {
    let time = 0;
    let nextTimer = 0;
    const timers = new Map();
    const references = [];
    const binding = { session: { getSnapshot: () => ({ openState: 'open', removed: false }), subscribe: () => () => {} } };
    const diagnostics = createTestDiagnostics({ storage, now: () => time });
    diagnostics.flush();
    assert.equal(diagnostics.getSnapshot().storageAvailable, false);
    const pool = createRetentionPool({
      binding: () => binding,
      retain() {
        const reference = { binding, ready: Promise.resolve(), released: 0, release() { this.released++; } };
        references.push(reference);
        return reference;
      },
    }, {
      idleMs: 100,
      now: () => time,
      schedule(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, at: time + delay }); return id; },
      cancel: (id) => timers.delete(id),
    });
    const unsubscribe = pool.subscribe(() => diagnostics.observe(pool.getSnapshot()));
    try {
      assert.doesNotThrow(() => {
        diagnostics.observe(pool.getSnapshot());
        pool.attach('SESSION_SECRET')();
        time = 50;
        pool.attach('SESSION_SECRET')();
        diagnostics.record({ type: 'offline' });
      });
      assert.equal(references.length, 1);
      assert.equal(references[0].released, 0);
      assert.equal(pool.getSnapshot().retained, 1);
      assert.equal(pool.getSnapshot().hits, 1);
      time = 150;
      for (const [id, task] of [...timers]) {
        if (task.at > time) continue;
        timers.delete(id);
        assert.doesNotThrow(() => task.fn());
      }
      assert.equal(references[0].released, 1);
      assert.equal(pool.getSnapshot().retained, 0);
      assert.equal(timers.size, 0);
      assert.deepEqual(diagnostics.getSnapshot().state, pool.getSnapshot());
      assert.ok(diagnostics.getSnapshot().events.some(({ type }) => type === 'offline'));
    } finally {
      unsubscribe();
      pool.dispose();
      diagnostics.dispose();
    }
  });
}
