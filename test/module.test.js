import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('built module loads, registers scoped slot and cleans up owned references', async () => {
  let module, component, releaseCount = 0, registrations = 0;
  const cleanup = [];
  const effects = [], effectDependencies = [], timers = new Map();
  let timerSequence = 0, storedJournal;
  const snapshot = { openState: 'open', removed: false };
  const session = { getSnapshot: () => snapshot, subscribe: () => () => {} };
  const binding = { session };
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useEffect: (effect, deps) => { effectDependencies.push(deps); effects.push(effect()); },
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  };
  const context = {
    window: { __ModuleLoader__: { load: (value) => { module = value; } } },
    setTimeout: (fn, ms) => { const id = ++timerSequence; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => timers.delete(id), performance, console,
    sessionStorage: { getItem: () => storedJournal, setItem: (_key, value) => { storedJournal = value; } },
  };
  vm.runInNewContext(await readFile(new URL('../client.js', import.meta.url), 'utf8'), context);
  assert.equal(module.id, '@local/dsh-session-keepalive');
  const plugin = module.factory((id) => { assert.equal(id, 'react'); return React; });
  const ctx = {
    configForms: { get: () => ({ getSnapshot: () => ({ status: 'ready', value: { maxSessions: 8, idleMinutes: 30 }, revision: 0, writable: true }), subscribe: () => () => {} }) },
    sessions: {
      binding: () => binding,
      retain: (_id, { source }) => {
        assert.equal(source, 'localSessionKeepalive');
        return { binding, ready: Promise.resolve(binding), release: () => releaseCount++ };
      },
    },
    effect: (effect) => cleanup.push(effect()),
    on: (event) => { assert.equal(event, 'connection/reset'); },
    locale: {
      register: (ns, dicts) => {
        assert.equal(ns, 'local-session-keepalive');
        assert.deepEqual(Object.keys(dicts.en).sort(), Object.keys(dicts.zh).sort());
        return () => {};
      },
      bind: () => (key) => key,
      subscribe: () => () => {},
      getSnapshot: () => ({ active: 'zh', revision: 0 }),
    },
    slots: {
      inject: (slot, effect) => {
        assert.equal(slot, 'conversation.composer.dock');
        cleanup.push(effect());
      },
      register: (options, value) => {
        registrations++;
        assert.equal(options.id, 'local-session-keepalive');
        component = value;
        return () => registrations--;
      },
    },
  };
  plugin.apply(ctx);
  assert.equal(registrations, 1);
  component({ sessionId: 'example', useSession: (selector) => selector(snapshot) });
  assert.equal(effectDependencies.length, 1);
  assert.deepEqual(Array.from(effectDependencies[0]), ['example', true, true], 'capacity updates must not detach and reattach a visible view');
  await Promise.resolve();
  assert.equal(releaseCount, 0);
  for (const effect of effects) effect?.();
  assert.equal(releaseCount, 0, 'view cleanup preserves a warm reference');
  for (const effect of cleanup.reverse()) effect?.();
  assert.equal(releaseCount, 1);
  assert.equal(registrations, 0);
  assert.equal(timers.size, 0, 'no retention or diagnostic timer survives plugin disposal');
  const journal = JSON.parse(storedJournal);
  assert.equal(journal.state.retained, 0, 'final diagnostic summary matches released references');
  assert.equal(journal.events[0].type, 'stop');
  assert.ok(journal.events.some((event) => event.type === 'release' && event.reason === 'disposed'));
});
