import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlugin } from '../src/ui.js';

// A hook-only interaction harness: element descriptors, no browser/DOM or React dependency.
function hooks() {
  const instances = new Map();
  let active;
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(initial) {
      const owner = active, index = owner.index++;
      const seat = owner.seats[index] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [seat.value, (next) => {
        const value = typeof next === 'function' ? next(seat.value) : next;
        if (!Object.is(value, seat.value)) { seat.value = value; owner.dirty = true; }
      }];
    },
    useRef(initial) {
      const index = active.index++;
      return active.seats[index] ??= { current: initial };
    },
    useEffect(effect, deps) {
      const owner = active, index = owner.index++;
      const seat = owner.seats[index] ??= {};
      if (!same(seat.deps, deps)) {
        owner.effects.push(() => { seat.cleanup?.(); seat.cleanup = effect(); });
        seat.deps = deps;
      }
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      const owner = active;
      React.useEffect(() => subscribe(() => { owner.dirty = true; }), [subscribe]);
      return getSnapshot();
    },
  };
  function render(Component, props = {}) {
    const owner = instances.get(Component) ?? { seats: [], dirty: true };
    instances.set(Component, owner);
    let tree;
    for (let round = 0; round < 20; round++) {
      owner.index = 0; owner.effects = []; owner.dirty = false; active = owner;
      try { tree = Component(props); } finally { active = undefined; }
      for (const effect of owner.effects) effect();
      if (!owner.dirty) return tree;
    }
    throw new Error('Hook harness did not settle');
  }
  return { React, render, dispose() { for (const owner of instances.values()) for (const seat of owner.seats) seat?.cleanup?.(); } };
}

function descendants(node) {
  if (!node || typeof node !== 'object') return [];
  return [node, ...(node.children ?? []).flatMap(descendants)];
}
const text = (node) => node && typeof node === 'object' ? (node.children ?? []).map(text).join('') : node === false || node == null ? '' : String(node);

function fixture(t, initial = {}) {
  const renderer = hooks(), disposers = [], listeners = new Set(), calls = [];
  let snapshot = { status: 'ready', writable: true, revision: 1, value: { maxSessions: 8, idleMinutes: 30 }, ...initial };
  let composer, mutate = async () => true;
  const form = {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    mutate(ops, revision) { calls.push({ ops, revision }); return mutate(ops, revision); },
  };
  const ctx = {
    sessions: { binding: () => undefined, retain: () => { throw new Error('UI tests must not open sessions'); } },
    effect(effect) { disposers.push(effect()); }, on() {},
    configForms: { get: (key) => { assert.equal(key, 'local-session-keepalive'); return form; } },
    locale: { register: () => () => {}, bind: () => (key) => key, subscribe: () => () => {}, getSnapshot: () => 'en' },
    slots: { inject: (_key, effect) => disposers.push(effect()), register: (_options, Component) => { composer = Component; return () => {}; } },
  };
  createPlugin(renderer.React).apply(ctx);
  const composerTree = renderer.render(composer, { sessionId: 'test', useSession: (selector) => selector({ openState: 'cold', removed: false }) });
  const editor = descendants(composerTree).find((node) => typeof node.type === 'function');
  assert.ok(editor, 'composer exposes its settings editor');
  let tree;
  const render = () => (tree = renderer.render(editor.type));
  const fields = () => descendants(tree).filter((node) => node.type === 'input');
  const button = (label) => {
    const result = descendants(tree).find((node) => node.type === 'button' && text(node) === label);
    assert.ok(result, `button ${label} is present`); return result;
  };
  const update = (patch) => { snapshot = { ...snapshot, ...patch }; for (const listener of [...listeners]) listener(); };
  render();
  t.after(() => { renderer.dispose(); for (const disposer of disposers.reverse()) disposer?.(); });
  return {
    calls, render, fields, button, update,
    behavior(fn) { mutate = fn; },
    change(index, value) { fields()[index].props.onChange({ target: { value } }); render(); },
    click(label) { button(label).props.onClick(); render(); },
    async settle() { await Promise.resolve(); await Promise.resolve(); render(); },
    values: () => fields().map((node) => node.props.value),
    messages: () => descendants(tree).filter((node) => node.props.role).map(text),
  };
}

test('save sends one atomic numeric operation batch with the edited draft revision', async (t) => {
  const f = fixture(t);
  let finish;
  f.behavior(() => new Promise((resolve) => { finish = resolve; }));
  f.change(0, '12'); f.change(1, '45'); f.click('save');
  assert.deepEqual(f.calls, [{ ops: [
    { op: 'set', path: ['maxSessions'], value: 12 },
    { op: 'set', path: ['idleMinutes'], value: 45 },
  ], revision: 1 }]);
  assert.ok(f.fields().every((field) => field.props.disabled));
  assert.equal(f.button('saving').props.disabled, true);
  f.button('saving').props.onClick();
  assert.equal(f.calls.length, 1, 'in-flight save is guarded even if callback is invoked directly');
  f.update({ revision: 2, value: { maxSessions: 12, idleMinutes: 45 } }); finish(true);
  await f.settle();
  assert.deepEqual(f.values(), [12, 45]); assert.ok(f.messages().includes('saved'));
  assert.equal(f.button('save').props.disabled, false);
});

test('invalid ranges and noninteger drafts do not mutate the settings', async (t) => {
  for (const [index, value] of [[0, '0'], [0, '33'], [0, '2.5'], [0, ''], [1, '0'], [1, '241'], [1, '1.5']]) {
    await t.test(`field ${index} rejects ${JSON.stringify(value)}`, async (t) => {
      const f = fixture(t); f.change(index, value); f.click('save'); await f.settle();
      assert.equal(f.calls.length, 0); assert.equal(f.values()[index], value);
      assert.ok(f.messages().includes('invalid')); assert.equal(f.button('save').props.disabled, false);
    });
  }
});

for (const [name, behavior, expected] of [
  ['false result', async () => false, 'refused'],
  ['rejected mutation', async () => { throw new Error('offline'); }, 'failed offline'],
]) test(`${name} preserves edited values and makes retry available`, async (t) => {
  const f = fixture(t); f.behavior(behavior);
  f.change(0, '11'); f.change(1, '50'); f.click('save'); await f.settle();
  assert.deepEqual(f.values(), ['11', '50']); assert.equal(f.calls.length, 1);
  assert.ok(f.messages().includes(expected)); assert.equal(f.button('save').props.disabled, false);
  assert.equal(f.button('reload').props.disabled, false);
});

test('remote update preserves a dirty draft and its stale revision until explicit reload', async (t) => {
  const f = fixture(t); f.behavior(async () => false); f.change(0, '15');
  f.update({ revision: 2, value: { maxSessions: 6, idleMinutes: 60 } }); f.render();
  assert.deepEqual(f.values(), ['15', 30]); assert.ok(f.messages().includes('stale'));
  f.click('save'); await f.settle();
  assert.equal(f.calls[0].revision, 1, 'must not attach the new revision to an old draft');
  assert.deepEqual(f.values(), ['15', 30]);
  f.click('reload'); assert.deepEqual(f.values(), [6, 60]);
  assert.ok(!f.messages().includes('stale')); assert.ok(!f.messages().includes('refused'));
  f.change(1, '90'); f.click('save'); await f.settle(); assert.equal(f.calls[1].revision, 2);
});

test('clean fields follow remote values without becoming stale', (t) => {
  const f = fixture(t);
  f.update({ revision: 2, value: { maxSessions: 4, idleMinutes: 15 } }); f.render();
  assert.deepEqual(f.values(), [4, 15]); assert.ok(!f.messages().includes('stale'));
});

test('read-only form disables controls and guards direct callbacks', async (t) => {
  const f = fixture(t, { writable: false });
  assert.ok(f.fields().every((field) => field.props.disabled));
  assert.equal(f.button('save').props.disabled, true); assert.equal(f.button('reset').props.disabled, true);
  assert.ok(f.messages().includes('readOnly'));
  f.button('save').props.onClick(); f.button('reset').props.onClick();
  f.fields()[0].props.onKeyDown({ key: 'Enter', stopPropagation() {}, preventDefault() {} });
  await f.settle(); assert.equal(f.calls.length, 0);
});

test('restore defaults unsets both overrides atomically rather than writing fixed values', async (t) => {
  const f = fixture(t); f.change(0, 'invalid');
  f.behavior(async () => { f.update({ revision: 2, value: { maxSessions: 8, idleMinutes: 30 } }); return true; });
  f.click('reset'); await f.settle();
  assert.deepEqual(f.calls, [{ ops: [
    { op: 'unset', path: ['maxSessions'] }, { op: 'unset', path: ['idleMinutes'] },
  ], revision: 1 }]);
  assert.deepEqual(f.values(), [8, 30]); assert.ok(f.messages().includes('saved'));
});
