import test from 'node:test';
import assert from 'node:assert/strict';
import { Config } from '../index.js';
import { DEFAULT_SETTINGS, parseSettings, settingsOperations, followSettings } from '../src/settings.js';
import { registerSettingsTool } from '../src/tool.js';

test('native schema exposes bounded volatile defaults and rejects bad values', () => {
  const defaults = Config({});
  assert.equal(defaults.maxSessions.get(), 8); assert.equal(defaults.idleMinutes.get(), 30);
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    assert.equal(Config.dict[key].meta.volatile, true);
    for (const value of [-1, 0, 1.5, Infinity, '8', true]) assert.throws(() => Config({ [key]: value }));
  }
  assert.throws(() => Config({ maxSessions: 33 })); assert.throws(() => Config({ idleMinutes: 241 }));
});

test('numeric editor parsing and atomic operations have strict bounds', () => {
  assert.deepEqual(parseSettings({ maxSessions: '12', idleMinutes: '60' }), { maxSessions: 12, idleMinutes: 60 });
  for (const bad of ['', 'no', 0, 33, 1.5, Infinity, null, true, [], {}]) assert.throws(() => parseSettings({ maxSessions: bad, idleMinutes: 30 }));
  for (const bad of ['', 0, 241, 1.5, null]) assert.throws(() => parseSettings({ maxSessions: 8, idleMinutes: bad }));
  assert.deepEqual(settingsOperations(DEFAULT_SETTINGS), [
    { op: 'set', path: ['maxSessions'], value: 8 }, { op: 'set', path: ['idleMinutes'], value: 30 },
  ]);
  assert.deepEqual(settingsOperations({}, true), [
    { op: 'unset', path: ['maxSessions'] }, { op: 'unset', path: ['idleMinutes'] },
  ]);
});

test('only accepted settings update the pool; duplicate notices and unload are safe', () => {
  let snapshot = { status: 'loading' }, listener, disposed = false;
  const seen = [];
  const form = { getSnapshot: () => snapshot, subscribe(fn) { listener = fn; return () => disposed = true; } };
  const stop = followSettings(form, { configure: (value) => seen.push(value) });
  assert.equal(seen.length, 0);
  snapshot = { status: 'ready', value: DEFAULT_SETTINGS }; listener(); listener();
  assert.deepEqual(seen, [{ maxSessions: 8, idleMs: 1800000 }]);
  snapshot = { status: 'ready', value: { maxSessions: 12, idleMinutes: 60 } }; listener();
  assert.deepEqual(seen[1], { maxSessions: 12, idleMs: 3600000 });
  snapshot = { status: 'unavailable' }; listener(); assert.equal(seen.length, 2);
  stop(); assert.equal(disposed, true);
});

function toolFixture(mode = 'danger-full-access') {
  let tool, revision = 1, value = { ...DEFAULT_SETTINGS }, calls = 0;
  const ctx = {
    tools: { register: (definition) => { tool = definition; return () => {}; } },
    sandboxPolicy: { resolve: () => ({ mode }) },
    settings: {
      describe: () => [{ ns: 'local-session-keepalive', value, revision }],
      async mutate(ns, ops, expected) {
        assert.equal(ns, 'local-session-keepalive');
        if (expected !== revision) throw new Error('stale revision');
        calls++;
        for (const op of ops) value = { ...value, [op.path[0]]: op.op === 'set' ? op.value : DEFAULT_SETTINGS[op.path[0]] };
        revision++;
      },
    },
  };
  registerSettingsTool(ctx);
  return { tool, calls: () => calls, exec: { signal: new AbortController().signal } };
}

test('agent and UI mutations share native settings and support reset/conflicts', async () => {
  const f = toolFixture();
  assert.deepEqual(await f.tool.execute({ action: 'get' }, f.exec), { ...DEFAULT_SETTINGS, revision: 1, scope: 'profile' });
  const changed = await f.tool.execute({ action: 'set', maxSessions: 12, expectedRevision: 1 }, f.exec);
  assert.equal(changed.maxSessions, 12); assert.equal(changed.idleMinutes, 30);
  await assert.rejects(f.tool.execute({ action: 'set', idleMinutes: 90, expectedRevision: 1 }, f.exec), /stale/);
  assert.equal(f.calls(), 1);
  const reset = await f.tool.execute({ action: 'reset', expectedRevision: 2 }, f.exec);
  assert.equal(reset.maxSessions, 8); assert.equal(reset.idleMinutes, 30);
  await assert.rejects(f.tool.execute({ action: 'set', maxSessions: 33 }, f.exec));
  assert.equal(f.calls(), 2);
});

test('settings writes fail closed outside full access or after cancellation', async () => {
  for (const mode of ['read-only', 'workspace-write']) {
    const f = toolFixture(mode);
    await f.tool.execute({ action: 'get' }, f.exec);
    await assert.rejects(f.tool.execute({ action: 'set', maxSessions: 12 }, f.exec), /Full access/);
    await assert.rejects(f.tool.execute({ action: 'reset' }, f.exec), /Full access/);
    assert.equal(f.calls(), 0);
  }
  const f = toolFixture(); const controller = new AbortController(); controller.abort();
  await assert.rejects(f.tool.execute({ action: 'reset' }, { signal: controller.signal })); assert.equal(f.calls(), 0);
});
