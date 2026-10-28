/** Bounded, tab-local owners of EXISTING open Session generations. No event cache. */
export function createRetentionPool(sessions, {
  maxSessions = 8,
  idleMs = 30 * 60 * 1000,
  now = () => performance.now(),
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (timer) => clearTimeout(timer),
  reportError = () => {},
  reportEvent = () => {},
} = {}) {
  if (!Number.isInteger(maxSessions) || maxSessions < 1) throw new Error('Invalid maxSessions');
  if (!Number.isFinite(idleMs) || idleMs <= 0) throw new Error('Invalid idleMs');
  const entries = new Map(); // Only native references count toward maxSessions.
  // Active view registrations survive capacity demotion, but never their final detach.
  // A record has one native observer whether retained, pending, or retained-and-visible.
  const demands = new Map();
  const listeners = new Set();
  let enabled = true;
  let disposed = false;
  let timer, timerDeadline, timerToken;
  let settling = false, settleAgain = false;
  let releasing = 0; // Synchronous diagnostics/cleanup may reenter before release finishes.
  let hits = 0;
  let failures = 0;
  let generations = 0;
  let snapshot;

  function notifyError(error) {
    try { reportError(error); } catch { /* Error reporting must not break ownership. */ }
  }
  function cleanup(fn) {
    try { fn?.(); } catch (error) { notifyError(error); }
  }
  function publish() {
    const next = { enabled, retained: entries.size, maxSessions, idleMs, hits, failures, generations };
    if (snapshot && Object.keys(next).every((key) => next[key] === snapshot[key])) return;
    snapshot = Object.freeze(next);
    for (const listener of [...listeners]) {
      try { listener(); } catch (error) { notifyError(error); }
    }
  }
  function record(type, details = {}) {
    // Diagnostics are best-effort and must never affect reference ownership.
    try { reportEvent({ type, retained: entries.size, maxSessions, idleMs, ...details }); } catch { /* ignore diagnostics failures */ }
  }
  function tracked(entry) {
    return entries.get(entry.id) === entry || demands.get(entry.id) === entry;
  }
  function unobserve(entry) {
    const unsubscribe = entry.unsubscribe;
    entry.unsubscribe = undefined;
    cleanup(unsubscribe);
  }
  function release(entry, reason, error) {
    if (entries.get(entry.id) !== entry) return;
    releasing++;
    try {
      entries.delete(entry.id); // Invalidate before cleanup can synchronously publish.
      const reference = entry.reference;
      entry.reference = undefined;
      record('release', { reason, idleForMs: entry.viewers.size === 0 ? Math.max(0, now() - entry.idleSince) : 0,
        ...(typeof error?.code === 'string' ? { errorCode: error.code } : {}) });
      if (!tracked(entry)) unobserve(entry);
      cleanup(() => reference.release());
    } finally {
      releasing--;
    }
  }
  function forget(entry, reason, error) {
    if (!tracked(entry)) return;
    if (demands.get(entry.id) === entry) demands.delete(entry.id);
    release(entry, reason, error);
    unobserve(entry);
    entry.viewers.clear();
  }
  function armTimer() {
    let deadline = Infinity;
    if (!disposed) for (const entry of entries.values()) {
      if (entry.viewers.size === 0) deadline = Math.min(deadline, entry.idleSince + idleMs);
    }
    if (timer !== undefined && timerDeadline === deadline) return;
    if (timer !== undefined) cancel(timer);
    timer = timerDeadline = timerToken = undefined;
    if (deadline === Infinity) return;
    const token = Symbol('idle-timer');
    timerToken = token;
    timerDeadline = deadline;
    timer = schedule(() => {
      if (timerToken !== token) return; // A canceled callback may already be queued.
      timer = timerDeadline = timerToken = undefined;
      sweep();
    }, Math.max(0, deadline - now()));
  }
  function expire(reason) {
    const time = now();
    for (const entry of [...entries.values()]) {
      if (entry.viewers.size === 0 && time - entry.idleSince >= idleMs) release(entry, reason);
    }
  }
  function sweep() {
    expire('expired');
    settle();
  }
  function fail(entry, error, reason = 'retain-rejected') {
    if (disposed || !tracked(entry)) return;
    failures++;
    forget(entry, reason, error);
    settle();
    notifyError(error);
  }
  function inspectState(entry) {
    if (disposed || !tracked(entry)) return;
    try {
      if (sessions.binding(entry.id) !== entry.binding) {
        forget(entry, 'replaced');
      } else {
        const latest = entry.binding.session.getSnapshot();
        if (latest.removed) {
          forget(entry, 'removed');
        } else if (latest.openState === 'error') {
          fail(entry, latest.openError ?? new Error('Session stream failed'), 'session-error');
          return;
        } else if (!entry.reference && latest.openState !== 'open') {
          // Pending demand must not become an observer/retry for a cold session.
          forget(entry, 'not-open');
        } else {
          return;
        }
      }
      settle();
    } catch (error) {
      fail(entry, error, 'session-error');
    }
  }
  function observe(entry) {
    if (entry.unsubscribe || entry.observing || !tracked(entry)) return;
    entry.observing = true;
    try {
      const unsubscribe = entry.binding.session.subscribe(() => inspectState(entry));
      // subscribe() may synchronously delete/fail this generation before returning.
      if (tracked(entry)) {
        entry.unsubscribe = unsubscribe;
        inspectState(entry);
      } else {
        cleanup(unsubscribe);
      }
    } catch (error) {
      fail(entry, error);
    } finally {
      entry.observing = false;
    }
  }
  function acquire(entry) {
    let reference;
    try {
      reference = sessions.retain(entry.id, { source: 'localSessionKeepalive' });
    } catch (error) {
      if (tracked(entry)) {
        failures++;
        record('retain-error', typeof error?.code === 'string' ? { errorCode: error.code } : {});
        forget(entry, 'retain-error', error);
        notifyError(error);
      }
      return;
    }
    // Always observe rejection, even if a synchronous callback invalidated this demand.
    reference.ready.catch((error) => {
      if (entries.get(entry.id) === entry && entry.reference === reference) fail(entry, error);
    });
    if (disposed || !enabled || demands.get(entry.id) !== entry || entries.size + releasing >= maxSessions) {
      cleanup(() => reference.release());
      return;
    }
    entry.reference = reference;
    entries.set(entry.id, entry);
    // Never adopt a different generation just because retain() returned one.
    if (reference.binding !== entry.binding || sessions.binding(entry.id) !== entry.binding) {
      forget(entry, 'replaced');
    } else {
      const state = entry.binding.session.getSnapshot();
      if (state.removed || state.openState !== 'open') forget(entry, state.removed ? 'removed' : 'not-open');
    }
  }
  function settle() {
    if (settling) { settleAgain = true; return; }
    settling = true;
    try {
      do {
        settleAgain = false;
        if (!disposed && enabled) for (const entry of [...demands.values()]) {
          if (demands.get(entry.id) !== entry) continue;
          if (!entry.reference) {
            inspectState(entry);
            if (!tracked(entry)) continue;
            if (entries.size + releasing >= maxSessions) {
              let oldest;
              for (const candidate of entries.values()) {
                if (candidate.viewers.size === 0 && (!oldest || candidate.lastUsed < oldest.lastUsed)) oldest = candidate;
              }
              if (oldest) release(oldest, 'capacity');
            }
            if (entries.size + releasing < maxSessions) {
              acquire(entry);
            } else if (!entry.skippedCapacity) {
              entry.skippedCapacity = true;
              record('skipped-capacity');
            }
          }
          observe(entry);
        }
        armTimer();
        publish();
      } while (settleAgain);
    } finally {
      settling = false;
    }
  }
  function attach(id) {
    if (disposed || !enabled || !id) return () => {};
    sweep(); // Handles browser timer throttling while a tab is hidden.
    const binding = sessions.binding(id);
    const state = binding?.session.getSnapshot();
    // Never open a cold, failed or unvisited session speculatively.
    if (!binding || !state || state.removed || state.openState !== 'open') return () => {};
    let entry = demands.get(id) ?? entries.get(id);
    if (entry && entry.binding !== binding) {
      forget(entry, 'replaced');
      entry = undefined;
    }
    if (entry) {
      if (entry.reference && entry.viewers.size === 0) hits++;
    } else {
      entry = { id, binding, reference: undefined, viewers: new Set(), lastUsed: now(), idleSince: now(),
        unsubscribe: undefined, observing: false, skippedCapacity: false };
    }
    const token = Symbol('visible-view');
    entry.viewers.add(token);
    entry.lastUsed = now();
    demands.set(id, entry);
    settle();
    let detached = false;
    return () => {
      if (detached) return;
      detached = true;
      if (disposed || demands.get(id) !== entry) return;
      entry.viewers.delete(token);
      if (entry.viewers.size === 0) {
        demands.delete(id);
        if (entries.get(id) === entry) entry.idleSince = now();
        else unobserve(entry);
      }
      settle();
    };
  }
  publish();
  return {
    attach,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    configure({ maxSessions: nextMax, idleMs: nextIdle }) {
      if (disposed) throw new Error('Retention pool is disposed');
      if (!Number.isInteger(nextMax) || nextMax < 1) throw new Error('Invalid maxSessions');
      if (!Number.isFinite(nextIdle) || nextIdle <= 0) throw new Error('Invalid idleMs');
      // Only this plugin's references are released; visible registrations/native owners survive.
      maxSessions = nextMax;
      idleMs = nextIdle;
      expire('settings-expired');
      const candidates = [...entries.values()].sort((a, b) =>
        Number(a.viewers.size > 0) - Number(b.viewers.size > 0) || a.lastUsed - b.lastUsed);
      for (const entry of candidates) {
        if (entries.size <= maxSessions) break;
        release(entry, 'settings-capacity');
      }
      settle();
      record('settings');
    },
    setEnabled(value) {
      if (disposed || enabled === Boolean(value)) return;
      enabled = Boolean(value);
      if (!enabled) for (const entry of new Set([...entries.values(), ...demands.values()])) forget(entry, 'paused');
      settle();
    },
    clearIdle() {
      if (disposed) return;
      for (const entry of [...entries.values()]) if (entry.viewers.size === 0) release(entry, 'manual');
      settle();
    },
    noteGeneration() {
      if (disposed) return;
      generations++;
      publish();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      for (const entry of new Set([...entries.values(), ...demands.values()])) forget(entry, 'disposed');
      armTimer();
      publish();
    },
  };
}
