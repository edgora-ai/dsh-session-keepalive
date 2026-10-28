export const DEFAULT_SETTINGS = Object.freeze({ maxSessions: 8, idleMinutes: 30 });
export const SETTINGS_LIMITS = Object.freeze({ maxSessions: 32, idleMinutes: 240 });

export function parseSettings(value) {
  if (!value || ['maxSessions', 'idleMinutes'].some((key) => !['string', 'number'].includes(typeof value[key]))) throw new Error('Invalid setting type');
  const maxSessions = Number(value.maxSessions);
  const idleMinutes = Number(value.idleMinutes);
  if (!Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > SETTINGS_LIMITS.maxSessions ||
      !Number.isInteger(idleMinutes) || idleMinutes < 1 || idleMinutes > SETTINGS_LIMITS.idleMinutes) {
    throw new Error('Use whole numbers: 1–32 sessions and 1–240 idle minutes.');
  }
  return { maxSessions, idleMinutes };
}

export function settingsOperations(value, reset = false) {
  if (reset) return Object.keys(DEFAULT_SETTINGS).map((key) => ({ op: 'unset', path: [key] }));
  return Object.entries(parseSettings(value)).map(([key, value]) => ({ op: 'set', path: [key], value }));
}

export function followSettings(form, pool) {
  let last;
  const sync = () => {
    const snapshot = form.getSnapshot();
    if (snapshot.status !== 'ready' || !snapshot.value) return;
    const value = parseSettings(snapshot.value);
    if (last?.maxSessions === value.maxSessions && last?.idleMinutes === value.idleMinutes) return;
    pool.configure({ maxSessions: value.maxSessions, idleMs: value.idleMinutes * 60 * 1000 });
    last = value;
  };
  const unsubscribe = form.subscribe(sync);
  try { sync(); } catch (error) { unsubscribe(); throw error; }
  return unsubscribe;
}
