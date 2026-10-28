import { createRetentionPool } from './pool.js';
import { createDiagnostics, browserDiagnosticsOptions, observePageLifecycle } from './diagnostics.js';
import { DEFAULT_SETTINGS, parseSettings, settingsOperations, followSettings } from './settings.js';

export function createPlugin(React) {
  const h = React.createElement;
  const namespace = 'local-session-keepalive';
  const dictionaries = {
    en: {
      title: 'Session keep-alive', paused: 'Paused', details: 'Keep recently opened sessions warm in this tab. No chat data is written to browser storage.',
      settings: 'Keep-alive settings', capacity: 'Sessions (1–32, including current)', idle: 'Idle minutes (1–240)',
      save: 'Save', saving: 'Saving…', reset: 'Restore inherited defaults', reload: 'Reload saved values', saved: 'Saved and applied',
      scope: 'Saved to this DSH profile and shared across its authenticated browsers. Larger values use more memory and live traffic.',
      unavailable: 'Settings are not available yet. If this follows an upgrade, restart DSH and refresh this page.',
      readOnly: 'This settings document is read-only.', invalid: 'Enter whole numbers: 1–32 sessions and 1–240 minutes.',
      refused: 'Not saved. The settings may have changed elsewhere or the Host refused the write. Your draft is preserved; reload saved values before retrying.',
      failed: 'Save failed; your draft is preserved.', stale: 'Saved settings changed elsewhere; your draft has been kept.',
      hits: 'Warm returns', generations: 'Connection-established events', failures: 'Retention errors',
      network: 'Connection events include initial establishment. Network reconnects still use DSH recovery and may reload history.',
      pause: 'Pause in this tab', resume: 'Resume in this tab', clear: 'Release inactive sessions',
      diagnostics: 'Cache diagnostics (no chat content)', diagnosticInfo: 'Up to 20 recent metadata events are kept in this tab. Connection events are merged into the latest entry; the connection counter remains cumulative. These explain releases and restarts; they do not restore chat history.',
      diagnosticUnavailable: 'This browser blocks diagnostic storage; events can only be shown until this page closes.', previous: 'Previously recorded retained count', actual: 'Applied limits', idleDuration: 'Idle minutes at release', remaining: 'Remaining',
      event_start: 'Plugin started', event_release: 'Reference released', event_settings: 'Settings applied', event_connection: 'Connection established',
      event_hidden: 'Page went to background', event_visible: 'Page returned to foreground', event_offline: 'Browser went offline', event_online: 'Browser came online',
      event_pagehide: 'Page hidden or leaving', event_pageshow: 'Page shown or restored', event_stop: 'Plugin stopped', event_retain_error: 'Retention failed', event_skipped_capacity: 'All retained slots occupied by visible views',
      reason_fresh: 'First diagnostic start', reason_plugin_reload: 'Plugin reloaded in the same page', reason_page_reload: 'Page reloaded', reason_new_document: 'A new page document started', reason_browser_discard: 'Browser discarded this tab', reason_history_restore: 'Back/forward navigation',
      reason_expired: 'Idle deadline reached', reason_capacity: 'Session count limit', reason_settings_expired: 'Reduced idle deadline', reason_settings_capacity: 'Reduced session count limit',
      reason_replaced: 'Native Session generation replaced', reason_removed: 'Session removed', reason_session_error: 'Session stream error', reason_retain_rejected: 'Retention readiness rejected', reason_paused: 'Paused in this tab', reason_manual: 'Manual release', reason_disposed: 'Plugin unloaded',
      limits: 'Refresh clears this tab’s cache. Retained sessions use additional memory and live subscriptions. Disable the bundle in Plugin Manager to turn it off permanently.',
    },
    zh: {
      title: '会话保温', paused: '已暂停', details: '仅保温本标签页已打开的会话，离开后按设定的闲置时间自动释放。不把聊天内容写入浏览器存储。',
      settings: '保温设置', capacity: '保温会话数量（1–32，含当前）', idle: '闲置释放分钟数（1–240）',
      save: '保存设置', saving: '正在保存…', reset: '恢复继承默认值', reload: '重新读取已保存值', saved: '已保存并应用',
      scope: '设置保存到当前 DSH profile，同一实例的已认证浏览器共享。数值越大，内存和实时流量开销越高。',
      unavailable: '设置暂不可用；如果刚升级插件，请重启 DSH 后刷新页面。',
      readOnly: '当前设置文档为只读。', invalid: '请输入整数：会话数 1–32，闲置分钟数 1–240。',
      refused: '未保存：设置可能已在别处变更，或服务端拒绝写入。草稿已保留，请先重新读取已保存值再修改。',
      failed: '保存失败，草稿已保留。', stale: '已保存设置已在别处变更，当前输入草稿已保留。',
      hits: '保温复用次数', generations: '连接建立事件', failures: '保温失败次数',
      network: '连接事件也可能包含首次建立。真实网络断线仍由 DSH 恢复，可能重新加载历史。',
      pause: '本标签页暂停', resume: '本标签页恢复', clear: '释放未显示的会话',
      diagnostics: '缓存诊断（不含聊天内容）', diagnosticInfo: '本标签页最多保留 20 条近期元数据记录；连接事件合并为最新一条，连接计数仍累计。记录用于区分释放原因和页面/插件重载，不会恢复聊天缓存。',
      diagnosticUnavailable: '浏览器禁止保存诊断记录；本次页面关闭后无法查看这些原因。', previous: '上次记录的保温数量', actual: '实际生效限制', idleDuration: '释放时已闲置分钟', remaining: '剩余',
      event_start: '插件启动', event_release: '缓存引用已释放', event_settings: '设置已应用', event_connection: '连接已建立',
      event_hidden: '页面转入后台', event_visible: '页面返回前台', event_offline: '浏览器离线', event_online: '浏览器恢复网络',
      event_pagehide: '页面隐藏或离开', event_pageshow: '页面显示或恢复', event_stop: '插件停止', event_retain_error: '保温失败', event_skipped_capacity: '所有保温名额被显示视图占用',
      reason_fresh: '首次启用诊断', reason_plugin_reload: '同一页面中插件重新加载', reason_page_reload: '页面重新加载', reason_new_document: '新页面文档已启动', reason_browser_discard: '浏览器回收了本标签页', reason_history_restore: '前进/后退导航',
      reason_expired: '闲置时限到期', reason_capacity: '会话数量达到上限', reason_settings_expired: '缩短闲置时限', reason_settings_capacity: '降低会话数量上限',
      reason_replaced: '原生会话实例被替换', reason_removed: '会话已移除', reason_session_error: '会话流发生错误', reason_retain_rejected: '保温就绪失败', reason_paused: '本标签页暂停', reason_manual: '手动释放', reason_disposed: '插件卸载或重载',
      limits: '刷新会清空本页缓存。保温会增加内存和实时订阅；要永久关闭，可在插件管理中禁用此插件包。',
    },
  };
  return {
    inject: ['slots', 'sessions', 'locale', 'configForms'],
    apply(ctx) {
      const diagnostics = createDiagnostics(browserDiagnosticsOptions());
      const pool = createRetentionPool(ctx.sessions, {
        reportError: (error) => console.error('[session-keepalive] retain failed', error),
        reportEvent: diagnostics.record,
      });
      ctx.effect(() => {
        const observe = () => diagnostics.observe(pool.getSnapshot());
        const unsubscribe = pool.subscribe(observe);
        observe();
        return () => { pool.dispose(); observe(); unsubscribe(); diagnostics.dispose(); };
      });
      ctx.effect(() => observePageLifecycle(diagnostics));
      const form = ctx.configForms.get(namespace);
      ctx.effect(() => followSettings(form, pool));
      ctx.effect(() => ctx.locale.register(namespace, dictionaries));
      ctx.on('connection/reset', () => { pool.noteGeneration(); diagnostics.record({ type: 'connection', ...pool.getSnapshot() }); });

      const t = ctx.locale.bind(namespace);
      const subscribeLocale = (listener) => ctx.locale.subscribe(listener);
      const getLocale = () => ctx.locale.getSnapshot();
      const subscribeForm = (listener) => form.subscribe(listener);
      const getForm = () => form.getSnapshot();
      const buttonStyle = {
        font: 'inherit', color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 6, padding: '4px 8px', cursor: 'pointer',
      };
      const draftFrom = (snapshot) => ({ ...DEFAULT_SETTINGS, ...snapshot.value, revision: snapshot.revision });
      function SettingsEditor() {
        const accepted = React.useSyncExternalStore(subscribeForm, getForm, getForm);
        const [draft, setDraft] = React.useState(() => draftFrom(accepted));
        const [dirty, setDirty] = React.useState(false);
        const [busy, setBusy] = React.useState(false);
        const [message, setMessage] = React.useState(null);
        const saving = React.useRef(false);
        const writable = accepted.status === 'ready' && accepted.writable && accepted.revision !== undefined;
        React.useEffect(() => {
          if (!dirty) setDraft(draftFrom(accepted));
        }, [accepted.value, accepted.revision, dirty]);
        const reload = () => { setDraft(draftFrom(getForm())); setDirty(false); setMessage(null); };
        const change = (key, value) => { setDraft((old) => ({ ...old, [key]: value })); setDirty(true); setMessage(null); };
        async function commit(reset = false) {
          if (saving.current || !writable) return;
          let ops;
          try { if (!reset) parseSettings(draft); ops = settingsOperations(draft, reset); }
          catch { setMessage({ error: true, text: t('invalid') }); return; }
          saving.current = true; setBusy(true); setMessage(null);
          try {
            const ok = await form.mutate(ops, draft.revision);
            if (!ok) { setMessage({ error: true, text: t('refused') }); return; }
            setDraft(draftFrom(getForm())); setDirty(false); setMessage({ text: t('saved') });
          } catch (error) {
            setMessage({ error: true, text: `${t('failed')} ${error instanceof Error ? error.message : String(error)}` });
          } finally { saving.current = false; setBusy(false); }
        }
        const field = (key, label, max) => h('label', { style: { display: 'grid', gap: 3, flex: '1 1 180px' } },
          t(label), h('input', {
            type: 'number', min: 1, max, step: 1, value: draft[key], disabled: busy || !writable,
            onChange: (event) => change(key, event.target.value),
            onKeyDown: (event) => { event.stopPropagation(); if (event.key === 'Enter') { event.preventDefault(); void commit(); } },
            style: { ...buttonStyle, cursor: 'text', width: '100%', boxSizing: 'border-box' },
          }));
        return h('section', { 'aria-label': t('settings'), style: { borderTop: '1px solid var(--dsw-alias-border-l1)', marginTop: 8, paddingTop: 8 } },
          h('strong', null, t('settings')),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, margin: '6px 0' } },
            field('maxSessions', 'capacity', 32), field('idleMinutes', 'idle', 240)),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
            h('button', { type: 'button', disabled: busy || !writable, style: buttonStyle, onClick: () => void commit() }, t(busy ? 'saving' : 'save')),
            h('button', { type: 'button', disabled: busy || !writable, style: buttonStyle, onClick: () => void commit(true) }, t('reset')),
            dirty && h('button', { type: 'button', disabled: busy, style: buttonStyle, onClick: reload }, t('reload'))),
          accepted.status !== 'ready' && h('p', { role: 'status' }, t('unavailable')),
          accepted.status === 'ready' && !accepted.writable && h('p', { role: 'status' }, t('readOnly')),
          dirty && draft.revision !== accepted.revision && h('p', { role: 'status' }, t('stale')),
          message && h('p', { role: message.error ? 'alert' : 'status', 'aria-live': 'polite' }, message.text),
          h('p', { style: { margin: '6px 0' } }, t('scope')));
      }
      function KeepAliveStatus({ sessionId, useSession }) {
        React.useSyncExternalStore(subscribeLocale, getLocale, getLocale);
        const open = useSession((state) => state.openState === 'open' && !state.removed);
        const state = React.useSyncExternalStore(pool.subscribe, pool.getSnapshot, pool.getSnapshot);
        const diagnostic = React.useSyncExternalStore(diagnostics.subscribe, diagnostics.getSnapshot, diagnostics.getSnapshot);
        React.useEffect(() => {
          if (open && state.enabled) return pool.attach(sessionId);
        }, [sessionId, open, state.enabled]);
        return h('details', {
          style: { fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)', maxWidth: '100%', padding: '2px 0' },
        },
        h('summary', { style: { cursor: 'pointer' } },
          t('title'), ' · ', state.enabled ? `${state.retained}/${state.maxSessions}` : t('paused')),
        h('div', { style: { padding: '8px 0', maxWidth: 540 } },
          h('p', { style: { margin: '0 0 6px' } }, t('details')),
          h('div', null, `${t('actual')} · ${t('capacity')}: ${state.maxSessions} · ${t('idle')}: ${state.idleMs / 60000}`),
          h('div', null, `${t('hits')}: ${state.hits} · ${t('generations')}: ${state.generations} · ${t('failures')}: ${state.failures}`),
          h('p', { style: { margin: '6px 0' } }, t('network')),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            h('button', { type: 'button', style: buttonStyle, onClick: () => pool.setEnabled(!state.enabled) }, t(state.enabled ? 'pause' : 'resume')),
            h('button', { type: 'button', style: buttonStyle, onClick: () => pool.clearIdle() }, t('clear'))),
          h('p', { style: { margin: '6px 0 0' } }, t('limits')), h(SettingsEditor),
          h('details', { style: { marginTop: 8, borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: 6 } },
            h('summary', { style: { cursor: 'pointer' } }, t('diagnostics')),
            h('p', { style: { margin: '6px 0' } }, t('diagnosticInfo')),
            !diagnostic.storageAvailable && h('p', { role: 'status' }, t('diagnosticUnavailable')),
            diagnostic.previousState && h('div', null, `${t('previous')}: ${diagnostic.previousState.retained}/${diagnostic.previousState.maxSessions}`),
            h('ol', { style: { margin: '6px 0', paddingInlineStart: 20, overflowWrap: 'anywhere' } },
              ...diagnostic.events.map((event, index) => h('li', { key: `${event.at}-${index}` }, [
                new Date(event.at).toLocaleString(), t(`event_${event.type.replaceAll('-', '_')}`),
                event.reason && t(`reason_${event.reason.replaceAll('-', '_')}`),
                event.retained !== undefined && `${t('remaining')}: ${event.retained}/${event.maxSessions ?? state.maxSessions}`,
                event.idleMs !== undefined && `${t('idle')}: ${event.idleMs / 60000}`,
                event.type === 'release' && event.idleForMs !== undefined && `${t('idleDuration')}: ${Math.floor(event.idleForMs / 60000)}`,
                event.errorCode,
              ].filter((part) => part !== undefined && part !== false).join(' · ')))))));

      }
      ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
        name: 'conversation.composer.dock', id: 'local-session-keepalive', order: 90,
      }, KeepAliveStatus));
    },
  };
}
