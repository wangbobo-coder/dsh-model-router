/**
 * 模型路由的设置页：一个页面把「什么时候走本地、什么时候走云端」讲清楚并就地可改。
 *
 * 页面只通过本包自己在 Host 注册的本机路由读写，所以设置页、`model_router` 工具
 * 和真正的路由判定共用同一份配置与同一份运行状态，不存在第二个真相。
 *
 * 版式沿用设置里相邻几页的语言：标题行 + 状态条 + 一组带边框的卡片 + 底部操作。
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-model-router',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useMemo, useCallback, useRef } = React;

    const NS = 'model-router';
    const BASE = '/api/dsh-model-router';

    /* ------------------------------------------------------------ locale -- */

    const DICT = {
      en: {
        title: 'Model Router',
        desc: 'Every request is routed between a local model and the DeepSeek cloud model. Development stays local; a turn that needs web search or research automatically goes to the cloud, then comes back.',
        'btn.refresh': 'Refresh',
        'btn.save': 'Save',
        'btn.saving': 'Saving…',
        'btn.reset': 'Restore defaults',
        'btn.probe': 'Test cloud route',
        'btn.probing': 'Testing…',
        'btn.close': 'Close',

        'state.loading': 'Reading routing configuration…',
        'state.failed': 'Could not read the configuration',
        'state.retry': 'Retry',

        'sum.mode': 'Mode',
        'sum.cloud': 'Cloud route',
        'sum.cooldown': 'Cloud cooldown',
        'sum.hit': 'Cloud turns',

        'card.basic': 'Switch and mode',
        'card.basic.desc': 'The switch stops the plugin from touching any request. Mode decides what automatic routing does when it is unsure.',
        'field.enabled': 'Enable automatic routing',
        'field.enabled.hint': 'Off means requests pass through exactly as the model selector says.',
        'field.mode': 'Fallback mode',
        'field.mode.hint': 'Only used when a turn carries no research intent — automatic routing picks this side.',
        'mode.auto': 'Automatic',
        'mode.local': 'Always local',
        'mode.cloud': 'Always cloud',

        'card.local': 'Local model',
        'card.local.desc': 'The everyday side: your own machine. Leave both empty to keep whatever the model selector in the chat header has chosen.',
        'field.localProvider': 'Local provider',
        'field.localModel': 'Local model',
        'field.follow': 'Follow the model selector',
        'field.follow.hint': 'Recommended. The chat header then stays the single place that decides which local model you are on.',

        'card.cloud': 'Cloud model',
        'card.cloud.desc': 'The research side. Automatic picks the first registered cloud route, so copying this profile to another machine keeps working.',
        'field.cloudProvider': 'Cloud provider',
        'field.cloudModel': 'Cloud model',
        'field.cloudModel.hint': 'Automatic prefers a model whose id looks like a pro/reasoning tier.',
        'field.keepControls': 'Keep sampling controls when switching',
        'field.keepControls.hint': 'Off drops the inherited temperature and token limits so the cloud model uses its own defaults.',

        'card.intent': 'What counts as research',
        'card.intent.desc': 'A turn is sent to the cloud when its text matches a keyword, contains a link, or after it has already called one of the research tools below.',
        'field.keywords': 'Research keywords',
        'field.keywords.hint': 'Separated by commas or newlines. Chinese and English are matched the same way.',
        'field.tools': 'Research tools',
        'field.tools.hint': 'Exact tool names; a trailing * works as a wildcard (mcp__* matches every MCP tool).',
        'field.sticky': 'Keep the cloud for',
        'field.sticky.unit': 'turn(s)',
        'field.sticky.hint': 'Once a turn goes cloud, later steps of that turn stay there so the model does not change mid-thought.',

        'card.fault': 'When the cloud is unavailable',
        'card.fault.desc': 'A signed-out account, a missing key or an exhausted quota must not strand the conversation — the request falls back to the local model instead.',
        'field.fallback': 'Fall back to local on cloud failure',
        'field.fallback.hint': 'Off means a cloud failure surfaces as an error.',
        'field.cooldown': 'Cooldown',
        'field.cooldown.unit': 'min',
        'field.cooldown.hint': 'After a cloud failure, automatic routing avoids the cloud for this long.',
        'field.log': 'Log each routing decision',
        'field.log.hint': 'One line per real switch in the Host log, useful when a turn went somewhere unexpected.',

        'card.recent': 'Recent routing decisions',
        'card.recent.desc': 'Filled in live by the running plugin, newest last.',
        'card.recent.empty': 'No request has been routed yet in this session.',
        'col.turn': 'Turn',
        'col.route': 'Route',
        'col.reason': 'Reason',
        'col.model': 'Model',
        'stat.requests': 'requests',
        'stat.cloud': 'cloud',
        'stat.local': 'local',
        'stat.failures': 'cloud failures',

        'toast.saved': 'Saved. Routing uses the new configuration now.',
        'toast.reset': 'Defaults restored.',
        'toast.probed': 'Cloud route resolves to {target}',
        'toast.probe.none': 'No cloud route is registered in this profile.',
        'toast.copy': 'Copy',
        'toast.copied': 'Copied',

        'note.unmanaged': 'The settings service is not mounted here, so changes live in memory only and are lost on restart.',
        'note.dirty': 'Unsaved changes',
        'note.auto': 'Automatic',
        'route.auto': 'automatic',
        'route.local': 'local',
        'route.cloud': 'cloud',
      },
      zh: {
        title: '模型路由',
        desc: '每次请求都会在本地模型和 DeepSeek 云端模型之间自动选择：日常开发留在本地，一轮对话需要联网搜索或调研时自动切到云端，用完再切回来。',
        'btn.refresh': '刷新',
        'btn.save': '保存',
        'btn.saving': '保存中…',
        'btn.reset': '恢复默认',
        'btn.probe': '测试云端路由',
        'btn.probing': '测试中…',
        'btn.close': '关闭',

        'state.loading': '正在读取路由配置…',
        'state.failed': '读取配置失败',
        'state.retry': '重试',

        'sum.mode': '当前模式',
        'sum.cloud': '云端路由',
        'sum.cooldown': '云端冷却',
        'sum.hit': '云端轮次',

        'card.basic': '开关与模式',
        'card.basic.desc': '关掉开关，插件就完全不介入请求。模式决定「判断不出意图」时默认走哪一边。',
        'field.enabled': '启用自动路由',
        'field.enabled.hint': '关闭后请求完全按你在模型选择器里选的走。',
        'field.mode': '默认走向',
        'field.mode.hint': '只有这一轮看不出调研意图时才生效。',
        'mode.auto': '自动判断',
        'mode.local': '总是本地',
        'mode.cloud': '总是云端',

        'card.local': '本地模型',
        'card.local.desc': '日常开发这一侧，跑在你自己机器上。两项都留空就跟随聊天头部模型选择器里选的那个。',
        'field.localProvider': '本地 provider',
        'field.localModel': '本地模型',
        'field.follow': '跟随模型选择器',
        'field.follow.hint': '推荐。这样「当前在用哪个本地模型」永远只有聊天头部一个地方决定。',

        'card.cloud': '云端模型',
        'card.cloud.desc': '联网调研这一侧。自动会挑第一条真正注册了的云端路由，把这份配置复制到别的机器也照样能用。',
        'field.cloudProvider': '云端 provider',
        'field.cloudModel': '云端模型',
        'field.cloudModel.hint': '自动时优先挑 id 里带 pro / reason 的那档模型。',
        'field.keepControls': '切换时保留采样参数',
        'field.keepControls.hint': '关闭时会丢掉继承来的 temperature 和 maxTokens，让云端模型用自己的默认值。',

        'card.intent': '什么算调研',
        'card.intent.desc': '一轮对话的文字命中关键词、含有链接，或者已经调用过下面的研究类工具，就会走云端。',
        'field.keywords': '调研关键词',
        'field.keywords.hint': '用逗号或换行分隔，中英文一视同仁。',
        'field.tools': '研究类工具',
        'field.tools.hint': '写工具名，结尾的 * 是通配符（mcp__* 命中所有 MCP 工具）。',
        'field.sticky': '留在云端的时长',
        'field.sticky.unit': '轮',
        'field.sticky.hint': '一轮走了云端，这一轮后面几步也留在云端，避免说到一半换模型。',

        'card.fault': '云端不可用时',
        'card.fault.desc': '没登录、没凭据、额度用完，都不该把对话卡死——直接降级回本地继续。',
        'field.fallback': '云端失败时降级到本地',
        'field.fallback.hint': '关闭后云端失败会作为错误抛出来。',
        'field.cooldown': '冷却时长',
        'field.cooldown.unit': '分钟',
        'field.cooldown.hint': '云端失败后，这段时间内自动路由不再选云端。',
        'field.log': '记录每次路由决策',
        'field.log.hint': '每次真正换路由在 Host 日志里打一行，排查「这轮怎么走了那边」时有用。',

        'card.recent': '最近的路由决策',
        'card.recent.desc': '由运行中的插件实时写入，最新的在最后。',
        'card.recent.empty': '本会话还没有发生过路由。',
        'col.turn': '轮次',
        'col.route': '走向',
        'col.reason': '原因',
        'col.model': '模型',
        'stat.requests': '次请求',
        'stat.cloud': '云端',
        'stat.local': '本地',
        'stat.failures': '云端失败',

        'toast.saved': '已保存，路由立刻按新配置生效。',
        'toast.reset': '已恢复默认配置。',
        'toast.probed': '云端路由解析为 {target}',
        'toast.probe.none': '当前 profile 没有注册任何云端路由。',
        'toast.copy': '复制',
        'toast.copied': '已复制',

        'note.unmanaged': '这个环境没有挂载 settings 服务，改动只存在内存里，重启即失效。',
        'note.dirty': '有未保存的改动',
        'note.auto': '自动',
        'route.auto': '自动',
        'route.local': '本地',
        'route.cloud': '云端',
      },
    };

    function makeT(getActive) {
      return function t(key, params) {
        const table = DICT[getActive()] ?? DICT.en;
        let text = table[key] ?? DICT.en[key] ?? key;
        if (params) {
          for (const [name, value] of Object.entries(params)) {
            text = text.split(`{${name}}`).join(String(value));
          }
        }
        return text;
      };
    }

    /* --------------------------------------------------------------- api -- */

    async function api(path, body) {
      const init = body === undefined
        ? { method: 'GET' }
        : {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-dsh-model-router': '1' },
            body: JSON.stringify(body ?? {}),
          };
      const response = await fetch(`${BASE}/${path}`, init);
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (!response.ok || !payload || payload.ok !== true) {
        const message = (payload && payload.error) || `${response.status} ${response.statusText}`;
        throw new Error(message);
      }
      return payload.data;
    }

    /* -------------------------------------------------------------- utils -- */

    const splitList = (text) =>
      String(text ?? '')
        .split(/[,，、\n]/)
        .map((item) => item.trim())
        .filter(Boolean);

    const joinList = (list) => (Array.isArray(list) ? list.join(', ') : '');

    const msToMin = (ms) => Math.max(0, Math.round(Number(ms || 0) / 60000));

    const modeOf = (value) => (value === 'local' || value === 'cloud' ? value : 'auto');

    /** 把磁盘上的配置转成表单草稿（数字换成更顺手的单位）。 */
    function toDraft(config) {
      return {
        enabled: config.enabled !== false,
        mode: modeOf(config.mode),
        localProvider: config.localProvider ?? '',
        localModel: config.localModel ?? '',
        cloudProvider: config.cloudProvider ?? 'auto',
        cloudModel: config.cloudModel ?? 'auto',
        keepControlsOnSwitch: Boolean(config.keepControlsOnSwitch),
        researchKeywords: joinList(config.researchKeywords),
        researchTools: joinList(config.researchTools),
        stickyTurns: Number(config.stickyTurns ?? 1),
        fallbackToLocalOnCloudFailure: config.fallbackToLocalOnCloudFailure !== false,
        cloudCooldownMin: msToMin(config.cloudCooldownMs),
        logRouting: config.logRouting !== false,
      };
    }

    /** 草稿回写成配置对象。 */
    function fromDraft(draft) {
      return {
        enabled: Boolean(draft.enabled),
        mode: modeOf(draft.mode),
        localProvider: String(draft.localProvider ?? '').trim(),
        localModel: String(draft.localModel ?? '').trim(),
        cloudProvider: String(draft.cloudProvider ?? 'auto').trim() || 'auto',
        cloudModel: String(draft.cloudModel ?? 'auto').trim() || 'auto',
        keepControlsOnSwitch: Boolean(draft.keepControlsOnSwitch),
        researchKeywords: splitList(draft.researchKeywords),
        researchTools: splitList(draft.researchTools),
        stickyTurns: Math.max(1, Math.round(Number(draft.stickyTurns) || 1)),
        fallbackToLocalOnCloudFailure: Boolean(draft.fallbackToLocalOnCloudFailure),
        cloudCooldownMs: Math.max(0, Math.round(Number(draft.cloudCooldownMin) || 0)) * 60000,
        logRouting: Boolean(draft.logRouting),
      };
    }

    const sameDraft = (a, b) => JSON.stringify(a) === JSON.stringify(b);

    /* ------------------------------------------------------------- styles -- */

    const CSS = `
.mdr-root { box-sizing: border-box; display: flex; width: 100%; min-width: 0; flex-direction: column; gap: 14px;
  padding: 2px 0 36px; color: var(--dsw-alias-label-primary); font-family: inherit; }
.mdr-main { display: flex; min-width: 0; flex-direction: column; gap: 14px; container-type: inline-size; }

.mdr-head { display: flex; flex-direction: column; gap: 14px; }
.mdr-title-row { display: flex; align-items: center; gap: 8px 12px; min-width: 0; flex-wrap: wrap; }
.mdr-title-block { min-width: 0; flex: 1 1 auto; }
.mdr-h1 { margin: 0; font-size: 24px; line-height: 32px; font-weight: 600; letter-spacing: -.4px; }
.mdr-desc { margin: 12px 0 0; color: var(--dsw-alias-label-secondary); font-size: 14px; line-height: 22px; max-width: 76ch; }
.mdr-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; flex: none; margin-left: auto; }
.mdr-dirty { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; line-height: 18px;
  color: var(--dsw-alias-state-warn-primary); }

.mdr-btn { appearance: none; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center;
  gap: 6px; height: 30px; padding: 0 11px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px;
  line-height: 18px; cursor: pointer; white-space: nowrap; transition: background .12s ease, border-color .12s ease; }
.mdr-btn:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary); }
.mdr-btn:disabled { opacity: .5; cursor: default; }
.mdr-btn.primary { background: var(--dsw-alias-brand-primary); border-color: transparent; color: #fff; }
.mdr-btn.quiet { background: transparent; }

.mdr-sum { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1px; overflow: hidden;
  border: 0.5px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-border-l1); }
.mdr-sum-cell { display: flex; flex-direction: column; gap: 2px; padding: 10px 12px; min-width: 0;
  background: var(--dsw-alias-bg-layer-1); }
.mdr-sum-label { font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.mdr-sum-value { font-size: 14px; line-height: 20px; font-weight: 600; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.mdr-sum-value.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-weight: 500; font-size: 13px; }
.mdr-sum-value.ok { color: var(--dsw-alias-state-success-primary); }
.mdr-sum-value.warn { color: var(--dsw-alias-state-warn-primary); }

.mdr-card { box-sizing: border-box; border: 0.5px solid var(--dsw-alias-border-l1); border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1); padding: 14px 16px 16px; display: flex; flex-direction: column; gap: 14px; }
.mdr-card-head { display: flex; flex-direction: column; gap: 4px; }
.mdr-card-title { margin: 0; font-size: 14px; line-height: 20px; font-weight: 600; }
.mdr-card-desc { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); max-width: 86ch; }

.mdr-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 16px; align-items: start; }
.mdr-grid.one { grid-template-columns: minmax(0, 1fr); }
.mdr-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.mdr-label { font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-secondary); }
.mdr-hint { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary); opacity: .85; }
.mdr-input, .mdr-select, .mdr-area { appearance: none; box-sizing: border-box; width: 100%; font: inherit;
  font-size: 13px; line-height: 18px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base);
  border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 8px; padding: 6px 9px; min-width: 0; }
.mdr-input:focus, .mdr-select:focus, .mdr-area:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.mdr-input:disabled, .mdr-select:disabled, .mdr-area:disabled { opacity: .55; }
.mdr-select { height: 32px; padding-right: 26px;
  background-image: linear-gradient(45deg, transparent 50%, currentColor 50%), linear-gradient(135deg, currentColor 50%, transparent 50%);
  background-position: calc(100% - 15px) 13px, calc(100% - 10px) 13px; background-size: 5px 5px, 5px 5px;
  background-repeat: no-repeat; }
.mdr-area { min-height: 66px; resize: vertical; font-family: inherit; }
.mdr-row { display: flex; align-items: center; gap: 10px; min-width: 0; }
.mdr-row.between { justify-content: space-between; }

.mdr-toggle { display: flex; align-items: center; gap: 10px; min-width: 0; cursor: pointer; }
.mdr-toggle-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.mdr-switch { position: relative; flex: none; width: 32px; height: 18px; border-radius: 9px;
  background: var(--dsw-alias-border-l2); transition: background .15s ease; }
.mdr-switch[data-on="true"] { background: var(--dsw-alias-brand-primary); }
.mdr-switch-thumb { position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%;
  background: #fff; transition: transform .15s ease; }
.mdr-switch[data-on="true"] .mdr-switch-thumb { transform: translateX(14px); }

.mdr-table { width: 100%; border-collapse: collapse; font-size: 12px; line-height: 18px; }
.mdr-table th { text-align: left; font-weight: 500; color: var(--dsw-alias-label-secondary); padding: 0 8px 6px 0;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1); white-space: nowrap; }
.mdr-table td { padding: 6px 8px 6px 0; border-bottom: 0.5px solid var(--dsw-alias-border-l1); vertical-align: top; }
.mdr-table tr:last-child td { border-bottom: 0; }
.mdr-table td.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.mdr-pill { display: inline-flex; align-items: center; height: 18px; padding: 0 7px; border-radius: 5px;
  font-size: 11px; line-height: 18px; font-weight: 500; }
.mdr-pill.cloud { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 18%, transparent);
  color: var(--dsw-alias-state-warn-primary); }
.mdr-pill.local { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 18%, transparent);
  color: var(--dsw-alias-state-success-primary); }
.mdr-pill.auto { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); }

.mdr-empty { padding: 12px 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.mdr-note { display: flex; gap: 8px; align-items: flex-start; padding: 9px 12px; border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2); font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.mdr-note.warn { color: var(--dsw-alias-state-warn-primary); }

.mdr-center { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px;
  padding: 64px 16px; color: var(--dsw-alias-label-secondary); font-size: 13px; text-align: center; }

.mdr-toast { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); z-index: 40;
  max-width: min(560px, calc(100vw - 32px)); padding: 9px 14px; border-radius: 8px; font-size: 13px;
  line-height: 19px; color: #fff; background: #1f2430; box-shadow: 0 8px 24px rgba(0,0,0,.3); }

@container (max-width: 620px) {
  .mdr-sum { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .mdr-grid { grid-template-columns: minmax(0, 1fr); }
}
`;

    /* -------------------------------------------------------------- parts -- */

    function Switch(props) {
      return h('span', { className: 'mdr-switch', 'data-on': props.on ? 'true' : 'false' },
        h('span', { className: 'mdr-switch-thumb' }));
    }

    function Toggle(props) {
      return h('label', { className: 'mdr-toggle' },
        h('input', {
          type: 'checkbox',
          checked: Boolean(props.value),
          disabled: props.disabled,
          onChange: (event) => props.onChange(event.target.checked),
          style: { position: 'absolute', opacity: 0, width: 0, height: 0, pointerEvents: 'none' },
        }),
        h(Switch, { on: props.value }),
        h('span', { className: 'mdr-toggle-text' },
          h('span', { className: 'mdr-label', style: { color: 'var(--dsw-alias-label-primary)' } }, props.label),
          props.hint ? h('span', { className: 'mdr-hint' }, props.hint) : null));
    }

    function Card(props) {
      return h('section', { className: 'mdr-card' },
        h('div', { className: 'mdr-card-head' },
          h('h2', { className: 'mdr-card-title' }, props.title),
          props.desc ? h('p', { className: 'mdr-card-desc' }, props.desc) : null),
        props.children);
    }

    function Field(props) {
      return h('div', { className: 'mdr-field' },
        h('label', { className: 'mdr-label' }, props.label),
        props.children,
        props.hint ? h('span', { className: 'mdr-hint' }, props.hint) : null);
    }

    /* --------------------------------------------------------------- page -- */

    function ModelRouterPage(props) {
      const ctx = props.__ctx;
      const t = makeT(() => ctx.locale.getLocale().active);

      const [state, setState] = useState(null);
      const [draft, setDraft] = useState(null);
      const [error, setError] = useState(null);
      const [loading, setLoading] = useState(true);
      const [busy, setBusy] = useState(false);
      const [probing, setProbing] = useState(false);
      const [toast, setToast] = useState(null);
      const [showRaw, setShowRaw] = useState(false);

      const alive = useRef(true);
      useEffect(() => () => { alive.current = false; }, []);

      const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
          const data = await api('state');
          if (!alive.current) return;
          setState(data);
          setDraft(toDraft(data.config));
        } catch (err) {
          if (alive.current) setError(err && err.message ? err.message : String(err));
        } finally {
          if (alive.current) setLoading(false);
        }
      }, []);

      useEffect(() => { void load(); }, [load]);

      useEffect(() => {
        if (!toast) return undefined;
        const timer = setTimeout(() => setToast(null), 3200);
        return () => clearTimeout(timer);
      }, [toast]);

      const dirty = useMemo(() => {
        if (!state || !draft) return false;
        return !sameDraft(draft, toDraft(state.config));
      }, [draft, state]);

      const patch = useCallback((key, value) => {
        setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
      }, []);

      const save = useCallback(async () => {
        if (!draft || busy) return;
        setBusy(true);
        try {
          const data = await api('config', fromDraft(draft));
          if (!alive.current) return;
          setState(data);
          setDraft(toDraft(data.config));
          setToast(t('toast.saved'));
        } catch (err) {
          if (alive.current) setToast(err && err.message ? err.message : String(err));
        } finally {
          if (alive.current) setBusy(false);
        }
      }, [busy, draft, t]);

      const reset = useCallback(async () => {
        if (busy) return;
        setBusy(true);
        try {
          const data = await api('reset', {});
          if (!alive.current) return;
          setState(data);
          setDraft(toDraft(data.config));
          setToast(t('toast.reset'));
        } catch (err) {
          if (alive.current) setToast(err && err.message ? err.message : String(err));
        } finally {
          if (alive.current) setBusy(false);
        }
      }, [busy, t]);

      const probe = useCallback(async () => {
        if (probing) return;
        setProbing(true);
        try {
          const data = await api('probe', {});
          if (!alive.current) return;
          setState(data);
          const target = data.target;
          setToast(target ? t('toast.probed', { target: `${target.provider} / ${target.model}` }) : t('toast.probe.none'));
        } catch (err) {
          if (alive.current) setToast(err && err.message ? err.message : String(err));
        } finally {
          if (alive.current) setProbing(false);
        }
      }, [probing, t]);

      if (loading && !state) {
        return h('div', { className: 'mdr-root' }, h('style', null, CSS),
          h('div', { className: 'mdr-center' }, t('state.loading')));
      }

      if (error && !state) {
        return h('div', { className: 'mdr-root' }, h('style', null, CSS),
          h('div', { className: 'mdr-center' },
            h('div', null, `${t('state.failed')}: ${error}`),
            h('button', { className: 'mdr-btn', onClick: () => void load() }, t('state.retry'))));
      }

      const config = state.config;
      const target = state.cloudTarget;
      const cooling = Number(state.cooldown) > 0;
      const stats = state.stats ?? {};
      const providers = state.providers ?? [];
      const models = state.models ?? {};
      const modelList = models[draft.cloudProvider] ?? [];
      const localModelList = models[draft.localProvider] ?? [];
      const followLocal = !draft.localProvider && !draft.localModel;

      const sumCells = [
        { label: t('sum.mode'), value: t(`mode.${draft.mode}`), cls: '' },
        { label: t('sum.cloud'), value: target ? `${target.provider} / ${target.model}` : '—', cls: target ? 'mono' : 'mono warn' },
        { label: t('sum.cooldown'), value: cooling ? `${Math.round(state.cooldown / 1000)}s` : '—', cls: cooling ? 'warn' : 'ok' },
        { label: t('sum.hit'), value: `${stats.routedCloud ?? 0} / ${stats.requests ?? 0}`, cls: '' },
      ];

      const recentRows = (state.recent ?? []).slice().reverse();

      return h('div', { className: 'mdr-root' },
        h('style', null, CSS),
        h('div', { className: 'mdr-main' },

          /* -------------------------------------------------------- header -- */
          h('header', { className: 'mdr-head' },
            h('div', { className: 'mdr-title-row' },
              h('div', { className: 'mdr-title-block' },
                h('h1', { className: 'mdr-h1' }, t('title')),
                h('p', { className: 'mdr-desc' }, t('desc'))),
              h('div', { className: 'mdr-actions' },
                dirty ? h('span', { className: 'mdr-dirty' }, `● ${t('note.dirty')}`) : null,
                h('button', { className: 'mdr-btn quiet', onClick: () => void load(), disabled: busy }, t('btn.refresh')),
                h('button', { className: 'mdr-btn quiet', onClick: () => void reset(), disabled: busy || !draft }, t('btn.reset')),
                h('button', { className: 'mdr-btn primary', onClick: () => void save(), disabled: busy || !dirty },
                  busy ? t('btn.saving') : t('btn.save')))),
            h('div', { className: 'mdr-sum' },
              sumCells.map((cell, index) => h('div', { className: 'mdr-sum-cell', key: index },
                h('span', { className: 'mdr-sum-label' }, cell.label),
                h('span', { className: `mdr-sum-value ${cell.cls}` }, cell.value))))),

          !state.managed ? h('div', { className: 'mdr-note warn' }, t('note.unmanaged')) : null,

          /* --------------------------------------------------------- basic -- */
          h(Card, { title: t('card.basic'), desc: t('card.basic.desc') },
            h('div', { className: 'mdr-grid' },
              h(Field, { label: t('field.enabled'), hint: t('field.enabled.hint') },
                h(Toggle, {
                  value: draft.enabled,
                  onChange: (value) => patch('enabled', value),
                  label: draft.enabled ? t('field.enabled') : t('field.enabled'),
                })),
              h(Field, { label: t('field.mode'), hint: t('field.mode.hint') },
                h('select', {
                  className: 'mdr-select',
                  value: draft.mode,
                  disabled: !draft.enabled,
                  onChange: (event) => patch('mode', event.target.value),
                }, ['auto', 'local', 'cloud'].map((value) =>
                  h('option', { key: value, value }, t(`mode.${value}`))))))),

          /* --------------------------------------------------------- local -- */
          h(Card, { title: t('card.local'), desc: t('card.local.desc') },
            h('div', { className: 'mdr-grid' },
              h(Field, { label: t('field.localProvider'), hint: t('field.follow.hint') },
                h('select', {
                  className: 'mdr-select',
                  value: draft.localProvider,
                  disabled: !draft.enabled,
                  onChange: (event) => {
                    patch('localProvider', event.target.value);
                    patch('localModel', '');
                  },
                },
                  h('option', { value: '' }, `— ${t('field.follow')} —`),
                  providers.map((id) => h('option', { key: id, value: id }, id)))),
              h(Field, { label: t('field.localModel') },
                localModelList.length
                  ? h('select', {
                      className: 'mdr-select',
                      value: draft.localModel,
                      disabled: !draft.enabled || followLocal,
                      onChange: (event) => patch('localModel', event.target.value),
                    },
                      h('option', { value: '' }, `— ${t('field.follow')} —`),
                      localModelList.map((id) => h('option', { key: id, value: id }, id)))
                  : h('input', {
                      className: 'mdr-input',
                      value: draft.localModel,
                      placeholder: t('note.auto'),
                      disabled: !draft.enabled || followLocal,
                      onChange: (event) => patch('localModel', event.target.value),
                    }))),
            followLocal
              ? h('div', { className: 'mdr-note' }, t('field.follow.hint'))
              : null),

          /* --------------------------------------------------------- cloud -- */
          h(Card, { title: t('card.cloud'), desc: t('card.cloud.desc') },
            h('div', { className: 'mdr-grid' },
              h(Field, { label: t('field.cloudProvider') },
                h('select', {
                  className: 'mdr-select',
                  value: draft.cloudProvider,
                  disabled: !draft.enabled,
                  onChange: (event) => {
                    patch('cloudProvider', event.target.value);
                    patch('cloudModel', 'auto');
                  },
                },
                  h('option', { value: 'auto' }, `— ${t('note.auto')} —`),
                  providers.map((id) => h('option', { key: id, value: id }, id)))),
              h(Field, { label: t('field.cloudModel'), hint: t('field.cloudModel.hint') },
                modelList.length && draft.cloudProvider !== 'auto'
                  ? h('select', {
                      className: 'mdr-select',
                      value: draft.cloudModel,
                      disabled: !draft.enabled,
                      onChange: (event) => patch('cloudModel', event.target.value),
                    },
                      h('option', { value: 'auto' }, `— ${t('note.auto')} —`),
                      modelList.map((id) => h('option', { key: id, value: id }, id)))
                  : h('input', {
                      className: 'mdr-input',
                      value: draft.cloudModel === 'auto' ? '' : draft.cloudModel,
                      placeholder: t('note.auto'),
                      disabled: !draft.enabled,
                      onChange: (event) => patch('cloudModel', event.target.value || 'auto'),
                    }))),
            h('div', { className: 'mdr-row between' },
              h(Toggle, {
                value: draft.keepControlsOnSwitch,
                disabled: !draft.enabled,
                onChange: (value) => patch('keepControlsOnSwitch', value),
                label: t('field.keepControls'),
                hint: t('field.keepControls.hint'),
              }),
              h('button', { className: 'mdr-btn', onClick: () => void probe(), disabled: probing || busy },
                probing ? t('btn.probing') : t('btn.probe')))),

          /* -------------------------------------------------------- intent -- */
          h(Card, { title: t('card.intent'), desc: t('card.intent.desc') },
            h('div', { className: 'mdr-grid' },
              h(Field, { label: t('field.keywords'), hint: t('field.keywords.hint') },
                h('textarea', {
                  className: 'mdr-area',
                  value: draft.researchKeywords,
                  disabled: !draft.enabled,
                  spellCheck: false,
                  onChange: (event) => patch('researchKeywords', event.target.value),
                })),
              h(Field, { label: t('field.tools'), hint: t('field.tools.hint') },
                h('textarea', {
                  className: 'mdr-area',
                  value: draft.researchTools,
                  disabled: !draft.enabled,
                  spellCheck: false,
                  onChange: (event) => patch('researchTools', event.target.value),
                }))),
            h('div', { className: 'mdr-grid' },
              h(Field, { label: t('field.sticky'), hint: t('field.sticky.hint') },
                h('div', { className: 'mdr-row' },
                  h('input', {
                    className: 'mdr-input',
                    type: 'number',
                    min: 1,
                    step: 1,
                    style: { maxWidth: 96 },
                    value: draft.stickyTurns,
                    disabled: !draft.enabled,
                    onChange: (event) => patch('stickyTurns', event.target.value),
                  }),
                  h('span', { className: 'mdr-hint' }, t('field.sticky.unit')))))),

          /* --------------------------------------------------------- fault -- */
          h(Card, { title: t('card.fault'), desc: t('card.fault.desc') },
            h('div', { className: 'mdr-grid' },
              h(Field, { label: t('field.fallback'), hint: t('field.fallback.hint') },
                h(Toggle, {
                  value: draft.fallbackToLocalOnCloudFailure,
                  disabled: !draft.enabled,
                  onChange: (value) => patch('fallbackToLocalOnCloudFailure', value),
                  label: t('field.fallback'),
                })),
              h(Field, { label: t('field.cooldown'), hint: t('field.cooldown.hint') },
                h('div', { className: 'mdr-row' },
                  h('input', {
                    className: 'mdr-input',
                    type: 'number',
                    min: 0,
                    step: 1,
                    style: { maxWidth: 96 },
                    value: draft.cloudCooldownMin,
                    disabled: !draft.enabled,
                    onChange: (event) => patch('cloudCooldownMin', event.target.value),
                  }),
                  h('span', { className: 'mdr-hint' }, t('field.cooldown.unit'))))),
            h(Field, { label: t('field.log'), hint: t('field.log.hint') },
              h(Toggle, {
                value: draft.logRouting,
                disabled: !draft.enabled,
                onChange: (value) => patch('logRouting', value),
                label: t('field.log'),
              }))),

          /* -------------------------------------------------------- recent -- */
          h(Card, { title: t('card.recent'), desc: t('card.recent.desc') },
            recentRows.length
              ? h('table', { className: 'mdr-table' },
                  h('thead', null, h('tr', null,
                    h('th', null, t('col.turn')),
                    h('th', null, t('col.route')),
                    h('th', null, t('col.reason')),
                    h('th', null, t('col.model')))),
                  h('tbody', null, recentRows.map((row, index) => h('tr', { key: index },
                    h('td', null, `${row.turn ?? '—'}.${row.step ?? '—'}`),
                    h('td', null, h('span', { className: `mdr-pill ${row.route}` }, t(`route.${row.route}`))),
                    h('td', { className: 'mono' }, row.reason ?? ''),
                    h('td', { className: 'mono' }, row.model ?? '')))))
              : h('div', { className: 'mdr-empty' }, t('card.recent.empty')),
            h('div', { className: 'mdr-row' },
              h('span', { className: 'mdr-hint' },
                `${stats.requests ?? 0} ${t('stat.requests')} · ${stats.routedCloud ?? 0} ${t('stat.cloud')} · ${stats.routedLocal ?? 0} ${t('stat.local')} · ${stats.cloudFailures ?? 0} ${t('stat.failures')}`),
              h('button', {
                className: 'mdr-btn quiet',
                style: { marginLeft: 'auto' },
                onClick: () => setShowRaw(!showRaw),
              }, showRaw ? 'YAML' : 'JSON'),
              h('button', {
                className: 'mdr-btn quiet',
                onClick: () => {
                  const text = JSON.stringify(showRaw ? config : fromDraft(draft), null, 2);
                  if (navigator.clipboard && navigator.clipboard.writeText) {
                    void navigator.clipboard.writeText(text).then(() => setToast(t('toast.copied')), () => {});
                  }
                },
              }, t('toast.copy'))),
            showRaw
              ? h('pre', {
                  className: 'mdr-area mono',
                  style: { margin: 0, overflow: 'auto', maxHeight: 260, fontSize: 11.5, lineHeight: '17px' },
                }, JSON.stringify(config, null, 2))
              : null)),

        toast ? h('div', { className: 'mdr-toast' }, toast) : null);
    }

    /* -------------------------------------------------------------- apply -- */

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = makeT(() => ctx.locale.getLocale().active);
        ctx.effect(() => ctx.locale.register(NS, DICT), 'model-router dictionaries');
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'model-router',
          order: 27,
          label: () => t('title'),
          locale: NS,
        }, (ownerProps) => h(ModelRouterPage, { ...ownerProps, __ctx: ctx })));
      },
    };
  },
});
