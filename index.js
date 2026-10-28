import z from '@deepseek-ai/schemastery';
import { registerSettingsTool } from './src/tool.js';

export const Config = z.object({
  maxSessions: z.natural().min(1).max(32).default(8).description('保温会话数量 / Retained sessions (includes current)').volatile(),
  idleMinutes: z.natural().min(1).max(240).default(30).description('闲置释放分钟数 / Idle minutes before release').volatile(),
});

/** Config is persisted by native Settings; no chat, task, or transport changes. */
export const inject = ['settings', 'tools', 'sandboxPolicy'];
export function apply(ctx) {
  ctx.effect(() => registerSettingsTool(ctx));
}
