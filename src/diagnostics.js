/** Small tab-local metadata journal. Never persist chat, Session ids, URLs or error messages. */
export const DIAGNOSTICS_KEY = 'local-session-keepalive:diagnostics:v1';
const EVENT_TYPES = new Set(['start', 'release', 'settings', 'connection', 'hidden', 'visible', 'offline', 'online', 'pagehide', 'pageshow', 'retain-error', 'skipped-capacity', 'stop']);
const REASONS = new Set(['fresh', 'plugin-reload', 'page-reload', 'new-document', 'browser-discard', 'history-restore', 'expired', 'capacity', 'settings-expired', 'settings-capacity', 'replaced', 'removed', 'session-error', 'retain-rejected', 'paused', 'manual', 'disposed']);
const MAX_EVENTS = 20;
const finite = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const count = (value) => Number.isSafeInteger(value) && value >= 0;

function cleanState(value) {
  if (!value || typeof value.enabled !== 'boolean' || !count(value.retained) || value.retained > 32 ||
      !count(value.maxSessions) || value.maxSessions < 1 || value.maxSessions > 32 ||
      !finite(value.idleMs) || value.idleMs < 1 || value.idleMs > 240 * 60000) return null;
  return Object.freeze({ enabled: value.enabled, retained: value.retained, maxSessions: value.maxSessions,
    idleMs: value.idleMs, hits: count(value.hits) ? value.hits : 0,
    failures: count(value.failures) ? value.failures : 0, generations: count(value.generations) ? value.generations : 0 });
}
function cleanEvent(value, at) {
  if (!value || !EVENT_TYPES.has(value.type) || !finite(at)) return null;
  const event = { at, type: value.type };
  if (REASONS.has(value.reason)) event.reason = value.reason;
  for (const key of ['retained', 'maxSessions']) if (count(value[key]) && value[key] <= 32) event[key] = value[key];
  for (const key of ['idleMs', 'idleForMs']) if (finite(value[key])) event[key] = value[key];
  if (typeof value.errorCode === 'string' && value.errorCode.length <= 80 && /^[a-z][a-z0-9_-]*(?:\/[a-z0-9_-]+)?$/i.test(value.errorCode)) event.errorCode = value.errorCode;
  return Object.freeze(event);
}

/**
 * Snapshots update synchronously and stay referentially stable until a real change.
 * Persistence and subscriber notifications share one fixed 100ms batch: later
 * mutations do not postpone it. schedule(fn, ms) must return a cancellable handle
 * for a one-shot asynchronous callback; cancel(handle) removes that callback.
 * flush() cancels the pending task and synchronously saves/notifies the latest
 * snapshot; mutations made by subscribers start a new batch. hidden/pagehide
 * records flush automatically. dispose() appends stop,
 * drops subscribers and flushes once; it owns cleanup of the only batch timer.
 */
export function createDiagnostics({ storage, now = () => Date.now(), pageId = 'unknown', navigation = 'navigate', discarded = false,
  schedule = (fn, ms) => setTimeout(fn, ms), cancel = (timer) => clearTimeout(timer) } = {}) {
  const listeners = new Set();
  let stored;
  let storageAvailable = Boolean(storage);
  let disposed = false;
  let state = null;
  let snapshot;
  let pending;
  let needsWrite = false;
  let needsNotify = false;
  let raw;
  try { raw = storage?.getItem(DIAGNOSTICS_KEY); } catch { storageAvailable = false; }
  if (typeof raw === 'string' && raw.length <= 20000) {
    try {
      const candidate = JSON.parse(raw);
      if (candidate?.version === 1 && typeof candidate.pageId === 'string' && Array.isArray(candidate.events)) stored = candidate;
    } catch { /* Ignore malformed metadata; replace it with a valid journal. */ }
  }
  const startedAt = now();
  const previousState = cleanState(stored?.state);
  const startReason = stored?.pageId === String(pageId) ? 'plugin-reload' : discarded ? 'browser-discard' :
    navigation === 'reload' ? 'page-reload' : navigation === 'back_forward' ? 'history-restore' : stored ? 'new-document' : 'fresh';
  // Only the latest connection indication is useful; noisy per-session resets
  // must not consume all slots and erase releases or page lifecycle evidence.
  let sawConnection = false;
  let events = Object.freeze((stored?.events ?? []).map((event) => cleanEvent(event, event?.at)).filter((event) => {
    if (!event) return false;
    if (event.type !== 'connection') return true;
    if (sawConnection) return false;
    sawConnection = true;
    return true;
  }).slice(0, MAX_EVENTS - 1));

  function updateSnapshot() {
    snapshot = Object.freeze({ startedAt, startReason, previousState, state, events, storageAvailable });
  }
  function drain() {
    let notify = needsNotify;
    needsNotify = false;
    const write = needsWrite;
    needsWrite = false;
    if (write && storageAvailable) {
      try {
        // Starting/stopping before the first observation must not erase the last
        // known summary. In-memory state remains null until a current observation.
        storage.setItem(DIAGNOSTICS_KEY, JSON.stringify({ version: 1, pageId: String(pageId).slice(0, 40), state: state ?? previousState, events }));
      } catch {
        storageAvailable = false;
        updateSnapshot();
        notify = true;
      }
    }
    if (notify) for (const listener of [...listeners]) {
      if (!listeners.has(listener)) continue;
      try { listener(); } catch { /* Diagnostics must not break retention or other observers. */ }
    }
  }
  function flush() {
    const task = pending;
    pending = undefined;
    if (task) {
      try { cancel(task.handle); } catch { /* The identity guard also makes stale callbacks inert. */ }
    }
    drain();
  }
  function publish() {
    updateSnapshot();
    needsWrite ||= storageAvailable;
    needsNotify ||= listeners.size > 0;
    if (pending || (!needsWrite && !needsNotify)) return;
    const task = {};
    pending = task;
    try {
      task.handle = schedule(() => {
        if (pending !== task) return;
        pending = undefined;
        drain();
      }, 100);
    } catch {
      // An unavailable scheduler is no reason to interrupt reference ownership.
      if (pending === task) { pending = undefined; drain(); }
    }
  }
  function record(event) {
    if (disposed) return;
    const clean = cleanEvent(event, now());
    if (!clean) return;
    const previous = clean.type === 'connection' ? events.filter(({ type }) => type !== 'connection') : events;
    events = Object.freeze([clean, ...previous].slice(0, MAX_EVENTS));
    publish();
    if (clean.type === 'hidden' || clean.type === 'pagehide') flush();
  }
  record({ type: 'start', reason: startReason });
  return {
    record,
    flush,
    observe(value) {
      if (disposed) return;
      const next = cleanState(value);
      if (!next) return;
      if (state && Object.keys(next).every((key) => next[key] === state[key])) return;
      state = next;
      publish();
    },
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (disposed) return;
      record({ type: 'stop' });
      disposed = true;
      listeners.clear();
      flush();
    },
  };
}

/** Storage can be blocked; metadata recording must never stop retention. */
export function browserDiagnosticsOptions() {
  let storage;
  try { storage = globalThis.sessionStorage; } catch { /* unavailable */ }
  return { storage, pageId: String(globalThis.performance?.timeOrigin ?? 'unknown'),
    navigation: globalThis.performance?.getEntriesByType?.('navigation')?.[0]?.type ?? 'navigate',
    discarded: globalThis.document?.wasDiscarded === true };
}

/** Observe page lifecycle only; never clear the pool or prevent navigation. */
export function observePageLifecycle(journal) {
  const bindings = [];
  const listen = (target, type, callback) => {
    if (!target?.addEventListener) return;
    target.addEventListener(type, callback);
    bindings.push(() => target.removeEventListener(type, callback));
  };
  for (const type of ['offline', 'online', 'pagehide', 'pageshow']) listen(globalThis.window, type, () => journal.record({ type }));
  listen(globalThis.document, 'visibilitychange', () => journal.record({ type: globalThis.document.visibilityState === 'hidden' ? 'hidden' : 'visible' }));
  return () => { for (const unbind of bindings) unbind(); };
}
