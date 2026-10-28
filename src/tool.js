import { parseSettings, settingsOperations } from './settings.js';

export function registerSettingsTool(ctx) {
  const ns = 'local-session-keepalive';
  const read = () => {
    const current = ctx.settings.describe().find((item) => item.ns === ns);
    if (!current) throw new Error('Session keep-alive settings are not available');
    return current;
  };
  return ctx.tools.register({
    name: 'session_keepalive_settings',
    description: 'Read, change, or reset session keep-alive limits shared by this DSH profile. Writes require Full access. Returns accepted limits and revision; never changes chat history.',
    parameters: {
      type: 'object', properties: {
        action: { type: 'string', enum: ['get', 'set', 'reset'] },
        maxSessions: { type: 'integer', description: 'For set: 1–32 retained sessions including current. Omitted keeps the saved value.' },
        idleMinutes: { type: 'integer', description: 'For set: 1–240 idle minutes before release. Omitted keeps the saved value.' },
        expectedRevision: { type: 'integer', description: 'For writes: nonnegative integer revision from a previous read; stale revisions are refused.' },
      }, required: ['action'], additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { maxSessions: { type: 'number' }, idleMinutes: { type: 'number' }, revision: { type: 'number' }, scope: { type: 'string' } }, required: ['maxSessions', 'idleMinutes', 'revision', 'scope'], additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (!args || !['get', 'set', 'reset'].includes(args.action)) throw new Error('Invalid action');
      if (args.action !== 'get') {
        const policy = ctx.sandboxPolicy.resolve(exec.agent ? { session: exec.agent.session } : {});
        if (policy.mode !== 'danger-full-access') throw new Error('Changing profile-shared settings requires Full access; use the settings UI otherwise.');
        exec.signal.throwIfAborted();
        const current = read();
        if (args.expectedRevision !== undefined && (!Number.isInteger(args.expectedRevision) || args.expectedRevision < 0)) throw new Error('Invalid expectedRevision');
        const values = { ...current.value };
        if (args.action === 'set') {
          for (const key of ['maxSessions', 'idleMinutes']) {
            if (args[key] !== undefined) {
              if (typeof args[key] !== 'number') throw new Error(`${key} must be a number`);
              values[key] = args[key];
            }
          }
          parseSettings(values);
        }
        await ctx.settings.mutate(ns, settingsOperations(values, args.action === 'reset'), args.expectedRevision ?? current.revision);
      }
      const current = read();
      return { ...parseSettings(current.value), revision: current.revision, scope: 'profile' };
    },
  });
}
