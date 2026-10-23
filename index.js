/**
 * dsh-model-router — 在本地模型与 DeepSeek 官方云端模型之间自动路由每次请求。
 *
 * 场景：日常开发走本地模型（便宜、离线、无网络依赖）；一旦这一轮需要联网搜索 /
 * 调研，就自动把请求切到云端官方模型，用它的联网能力把资料取回来。
 *
 * 机制：
 *   · `agent/pre-step`（waterfall）在消息进入 step 前做意图判定；
 *   · `agent/request`（waterfall）拿到基线配置后，按判定结果替换 provider/model；
 *   · 判定走云端的 turn 内黏住，工具结果回来后的后续 step 仍在云端，避免中途换模型；
 *   · 本 turn 已调用过 web_search / web_fetch 等研究类工具时，后续 step 也留在云端；
 *   · 云端不可用（未登录 / 无凭据 / 模型不支持）时自动降级回本地，并冷却一段时间，
 *     不会让整轮对话因为云端鉴权失败而卡死；
 *   · `model_router` 工具用来查看当前路由，或把会话临时钉到某一边。
 *
 * 云端 provider / model 默认是 `auto`：启动后从 `ctx.llm.listProviders()` 与
 * `listModels()` 里挑一条真实存在的云端路由，因此换一个 profile 也能用，不必改配置。
 * 所有会话状态只在内存里，插件卸载或会话结束即失效，不落盘。
 */

import z from '@deepseek-ai/schemastery';

export const name = 'model-router';

/** `llm` 是路由必需的；`tools` 只用于注册 model_router 工具，缺了照常工作。 */
export const inject = ['llm'];

const AUTO = 'auto';
const LOCAL = 'local';
const CLOUD = 'cloud';

/** 设置命名空间：设置页与「插件配置」都按这个名字找本插件。 */
const NAMESPACE = 'model-router';

/** 配置页与设置面板共用的 HTTP 前缀（package-private，走本机 webServer）。 */
const ROUTE = '/api/dsh-model-router';

/** 云端路由的候选 id，按优先级排列（哪个真的注册了就用哪个）。 */
const CLOUD_PROVIDER_CANDIDATES = ['deepseek-account', 'deepseek-official', 'llm-deepseek'];

/**
 * 云端默认模型：官方目录里的 DeepSeek-V4.1-Flash（1017 版本）。
 *
 * 注意 id 不叫 `deepseek-v4.1-flash-1017` —— 那只是 UI 里加徽标的装饰插件包名
 * （`@deepseek-ai/dsh-client-ui-deepseek-model-label-1017`）。它匹配的是
 * provider `deepseek-account` / `deepseek-official` 上 `model.id === 'deepseek-flash'`
 * 且显示名 `DeepSeek-V4.1-Flash` 的那一条，也就是这里用的 id。
 */
const CLOUD_DEFAULT_MODEL = 'deepseek-flash';

/** 这些失败码说明云端这一侧不可用，应降级回本地而不是反复重试。 */
const CLOUD_UNAVAILABLE_CODES = [
  'ACCOUNT_SIGN_IN_REQUIRED',
  'ACCOUNT_TOKEN_INVALID',
  'MISSING_CREDENTIAL',
  'INVALID_CREDENTIAL',
  'AUTH',
  'QUOTA',
  'ACCOUNT_QUOTA',
  'MODEL_UNSUPPORTED',
  'CLIENT_UPGRADE_REQUIRED',
  'DUPLICATE_ADAPTER',
  'TRANSPORT'
];

/**
 * 把字段标记成「live 字段」（volatile）。
 *
 * 这一版 DSH 的设置页只把 volatile 字段投影成可编辑表单项（isVolatilePath /
 * volatileForm），非 volatile 字段需要重挂载插件才能改。给字段打上 volatile 后：
 *   · 特性支持的运行时 → 解析出来的是活引用 `{ get() }`，改完立刻生效，由
 *     `unwrapConfig` 解包；
 *   · 不支持的运行时 → meta 只是被忽略，值仍是普通数据，行为和以前一致。
 * 两种情形都不会抛错，所以用特性探测来调用。
 */
const CAN_VOLATILE = (() => {
  try {
    return typeof z.any().extra === 'function';
  } catch {
    return false;
  }
})();

/** 标记一个字段为 live（见 {@link CAN_VOLATILE}）。 */
function vol(schema) {
  if (!CAN_VOLATILE) return schema;
  try {
    return schema.extra('volatile', true);
  } catch {
    return schema;
  }
}

export const Config = z.object({
  enabled: vol(z.boolean().default(true).description('总开关。关掉后本插件完全不介入，请求按原样放行。')),
  mode: vol(
    z
      .union([z.const('auto'), z.const('local'), z.const('cloud')])
      .default('auto')
      .description('auto = 按意图自动判定；local / cloud = 全部强制走某一边。')
  ),

  localProvider: vol(
    z.string().default('').description('本地路由 provider id。留空 = 不干预（沿用当前选中的模型）。')
  ),
  localModel: vol(z.string().default('').description('本地路由 model id。留空 = 不干预。')),

  cloudProvider: vol(
    z
      .string()
      .default(AUTO)
      .description('云端 provider id。auto = 自动从已注册路由里挑 deepseek-account / deepseek-official。')
  ),
  cloudModel: vol(
    z
      .string()
      .default(CLOUD_DEFAULT_MODEL)
      .description(
        '云端 model id。默认 deepseek-flash（目录里的 DeepSeek-V4.1-Flash，带 1017 徽标）；auto = 按目录自动挑。'
      )
  ),

  keepControlsOnSwitch: vol(
    z
      .boolean()
      .default(false)
      .description('切到云端时是否沿用基线的 temperature / maxTokens / reasoningEffort。两条路由能力不同，默认关。')
  ),

  researchKeywords: vol(
    z
      .array(z.string())
      .default([
      '联网', '上网', '搜索', '搜一下', '搜下', '查一下', '查一查', '查询', '检索',
      '调研', '研究一下', '最新', '近期', '新闻', '资讯', '官网', '文档链接', '网址',
      '引用来源', '出处', '研究报告', '评测', '对比一下', '实时',
      'search', 'web search', 'look up', 'lookup', 'research', 'browse', 'crawl',
      'latest', 'recent', 'news', 'release notes', 'changelog', 'official docs',
      'google', 'bing', 'duckduckgo', 'arxiv', 'github issue', 'stackoverflow'
    ])
    .description('命中这些词（不区分大小写）就判定「这一轮需要联网」，走云端。')
  ),

  researchTools: vol(
    z
      .array(z.string())
      .default(['web_search', 'web_fetch', 'x_search', 'read_page', 'mcp__*'])
      .description('本 turn 调用过这些工具（支持结尾 * 通配）就留在云端。')
  ),

  researchMode: vol(
    z
      .union([z.const('inline'), z.const('subagent')])
      .default('subagent')
      .description(
        'subagent = 调研轮次开一个云端子智能体去查，主会话留在本地（默认）；inline = 主会话自己切到云端。'
      )
  ),

  researchSubagentProvider: vol(
    z.string().default('spawn').description('子智能体 provider 名，取自 ctx.subagents.list()。')
  ),

  researchTimeoutMs: vol(
    z.number().default(180000).description('子智能体调研超时（毫秒）。超时则放弃本次调研，主会话照常本地继续。')
  ),

  researchMaxDepth: vol(
    z.number().default(1).description('子智能体可再往下委派的最大深度（1 = 不允许孙智能体）。')
  ),

  researchPrompt: vol(
    z
      .string()
      .default('')
      .description('子智能体任务提示词模板，{question} 会替换成当前请求原文。留空用内置模板。')
  ),

  stickyTurns: vol(
    z.number().default(1).description('切到云端后黏住多少个 turn（1 = 仅当前 turn）。')
  ),

  fallbackToLocalOnCloudFailure: vol(
    z
      .boolean()
      .default(true)
      .description('云端鉴权/配额/模型不支持类失败时自动降级到本地，并冷却一段时间。')
  ),

  cloudCooldownMs: vol(
    z
      .number()
      .default(600000)
      .description('云端失败后的冷却时长（毫秒），期间自动路由不再选云端。')
  ),

  logRouting: vol(z.boolean().default(true).description('每次真实换路由都打一行日志。'))
});

export function apply(ctx, config) {
  /** 入口原始配置。字段可能是 volatile 活引用，统一由 unwrapConfig 解包。 */
  let configRef = config;
  /** 没有 configEditor 时的内存覆盖层（例如纯 CLI 环境）。 */
  let memoryOverride = null;
  /** 当前生效配置：入口 `config` 是基线，profile 里写入的用户层覆盖后实时替换。 */
  let cfg = normalize(unwrapConfig(config));
  const log = (...args) => {
    if (cfg.logRouting) console.log('[model-router]', ...args);
  };

  /** sessionId -> 'auto' | 'local' | 'cloud'：model_router 工具写入的人工钉住。 */
  const overrides = new Map();
  /** sessionId -> { route, turn, reason }：本 turn 的判定结果，供 agent/request 消费。 */
  const pending = new Map();
  /** sessionId -> turn：云端黏住到哪个 turn 为止。 */
  const stuck = new Map();
  /** sessionId 集合：正在跑子智能体调研，期间不再重复外包。 */
  const inflight = new Set();

  const stats = {
    requests: 0,
    routedCloud: 0,
    routedLocal: 0,
    cloudFailures: 0,
    researchSpawns: 0,
    researchOk: 0,
    researchFailed: 0,
    researchEmpty: 0,
    lastRoute: undefined,
    lastReason: undefined
  };

  /** 最近若干次路由决策，供 model_router status 展示，便于确认「这一轮到底走了哪边」。 */
  const recent = [];
  function record(entry) {
    recent.push(entry);
    if (recent.length > 8) recent.shift();
  }

  /** 解析后的云端目标，带缓存；路由目录变化时按 TTL 重算。 */
  let cloudTarget;
  let cloudResolvedAt = 0;
  let cooldownUntil = 0;

  async function resolveCloudTarget(force) {
    if (!force && cloudTarget && Date.now() - cloudResolvedAt < 60_000) return cloudTarget;
    cloudResolvedAt = Date.now();

    let providers = [];
    try {
      providers = (await ctx.llm.listProviders()) || [];
    } catch (err) {
      log('listProviders 失败:', err && err.message);
    }
    const ids = providers.map((p) => (typeof p === 'string' ? p : p && p.id)).filter(Boolean);

    let provider = '';
    if (cfg.cloudProvider !== AUTO) {
      provider = cfg.cloudProvider;
    } else {
      provider = CLOUD_PROVIDER_CANDIDATES.find((id) => ids.includes(id)) || '';
      if (!provider) {
        // 没有已知候选：退而选任一「不是本地路由」的路由，避免硬编码失效。
        provider = ids.find((id) => id !== cfg.localProvider) || '';
      }
    }
    if (!provider) {
      cloudTarget = undefined;
      log('未找到可用的云端路由，自动路由只保留本地。已注册:', ids.join(', ') || '(none)');
      return undefined;
    }

    let model = cfg.cloudModel !== AUTO ? cfg.cloudModel : '';
    if (!model) {
      try {
        const models = (await ctx.llm.listModels(provider)) || [];
        const list = models.map((m) => (typeof m === 'string' ? m : m && m.id)).filter(Boolean);
        // auto 也优先 V4.1-Flash（deepseek-flash），其次任意 flash，最后才取第一个。
        model =
          list.find((id) => id === CLOUD_DEFAULT_MODEL) ||
          list.find((id) => /flash/i.test(id)) ||
          list[0] ||
          '';
      } catch (err) {
        log(`listModels(${provider}) 失败:`, err && err.message);
      }
      if (!model) model = CLOUD_DEFAULT_MODEL;
    }

    cloudTarget = { provider, model };
    log(`云端路由解析为 ${provider}/${model}`);
    return cloudTarget;
  }

  // 启动时预热一次，把解析结果尽早写进日志。
  void resolveCloudTarget(true);

  // ── step 判定 ────────────────────────────────────────────────────────────
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    try {
      if (!cfg.enabled || !decision || decision.kind !== 'enter') return decision;

      const sid = String(payload.agent && payload.agent.id ? payload.agent.id : 'global');
      // 优先用真正要进入这一步的 messages；有些决策不携带 messages，则回退到 payload。
      const entering = Array.isArray(decision.messages) && decision.messages.length ? decision.messages : payload.messages;
      const text = messagesText(entering);
      const verdict = classify(text, cfg, pinnedFor(sid));

      if (!verdict) return decision;

      // 子智能体调研模式：把「调研」这件事外包出去，主会话原地不动。
      const handled = await maybeDelegateResearch(payload, decision, sid, text, verdict);
      if (handled) return handled;

      pending.set(sid, { route: verdict.route, turn: payload.turn, reason: verdict.reason });
    } catch (err) {
      log('pre-step 判定失败，放行:', err && err.message);
    }
    return decision;
  });

  /**
   * 调研轮次外包给云端子智能体。
   *
   * 命中条件（全部满足才外包，否则返回 undefined 走原来的 inline 路由）：
   * - `researchMode === 'subagent'`
   * - 判定结果是云端（本地轮次没有外包的意义）
   * - 不是人工钉住（用户明确要求主会话走云端时尊重其意图）
   * - 只在 turn 的第一步触发，避免同一步骤重复开子智能体
   * - 当前会话是顶层会话：子智能体自己也会发请求，不设防会无限套娃
   * - 云端路由可用且不在冷却期
   *
   * 成功时返回一份新的 decision：调研结论作为插件消息并入本步输入，
   * 主会话仍用本地模型继续。失败时返回 undefined，退回 inline 路由。
   */
  async function maybeDelegateResearch(payload, decision, sid, text, verdict) {
    if (cfg.researchMode !== 'subagent') return undefined;
    if (verdict.route !== CLOUD) return undefined;
    if (verdict.reason === 'manual-pin') return undefined;
    // pre-step 的 step 从 1 起算（phase.step + 1），只在 turn 的第一步外包。
    if (payload.step !== 1) return undefined;
    if (!text || !text.trim()) return undefined;
    if (isChildSession(payload.agent)) return undefined;
    if (inflight.has(sid)) return undefined;
    if (cooldownUntil > Date.now()) return undefined;

    const subagents = typeof ctx.get === 'function' ? ctx.get('subagents') : undefined;
    if (!subagents || typeof subagents.start !== 'function') {
      log('subagents 服务不可用，退回主会话 inline 路由');
      return undefined;
    }
    const provider = cfg.researchSubagentProvider;
    try {
      if (typeof subagents.list === 'function' && !subagents.list().includes(provider)) {
        log(`子智能体 provider "${provider}" 未注册，已注册:`, subagents.list().join(', ') || '(none)');
        return undefined;
      }
    } catch (err) {
      log('subagents.list() 失败:', err && err.message);
    }

    const target = await resolveCloudTarget(false);
    if (!target) return undefined;

    inflight.add(sid);
    stats.researchSpawns += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.researchTimeoutMs);
    const onAbort = () => controller.abort();
    try {
      if (payload.signal && typeof payload.signal.addEventListener === 'function') {
        if (payload.signal.aborted) return undefined;
        payload.signal.addEventListener('abort', onAbort, { once: true });
      }

      log(`turn ${payload.turn}: 调研外包给子智能体 ${provider} (${target.provider}/${target.model})`);
      const run = await subagents.start(provider, {
        label: `调研：${firstLine(text, 40)}`,
        prompt: [{ type: 'text', text: buildResearchPrompt(text, cfg.researchPrompt) }],
        parent: payload.agent,
        signal: controller.signal,
        agentOptions: { provider: target.provider, model: target.model },
        maxDepth: cfg.researchMaxDepth
      });

      let result;
      try {
        result = await run.result;
      } finally {
        try {
          await run.dispose();
        } catch (err) {
          log('子智能体 dispose 失败:', err && err.message);
        }
      }

      const answer = contentToText(result && result.output);
      const stopReason = (result && result.stopReason) || 'unknown';

      if (!answer.trim()) {
        stats.researchEmpty += 1;
        log(`turn ${payload.turn}: 子智能体未产出内容 (stopReason=${stopReason})，退回 inline 路由`);
        return undefined;
      }

      stats.researchOk += 1;
      record({
        turn: payload.turn,
        step: payload.step,
        route: LOCAL,
        reason: `research-subagent:${stopReason}`,
        model: `${target.provider}/${target.model} → 子智能体`
      });

      // 主会话保持本地：清掉可能残留的云端黏住，并按本地处理本次请求。
      stuck.delete(sid);
      pending.set(sid, { route: LOCAL, turn: payload.turn, reason: 'research-subagent' });

      return {
        ...decision,
        messages: [...decision.messages, buildResearchMessage(text, answer, target, stopReason)]
      };
    } catch (err) {
      stats.researchFailed += 1;
      const aborted = controller.signal.aborted;
      log(`turn ${payload.turn}: 子智能体调研${aborted ? '超时' : '失败'}：${err && err.message}`);
      // 外包失败不阻断对话：退回 inline 路由，让主会话自己判断要不要查。
      return undefined;
    } finally {
      clearTimeout(timer);
      if (payload.signal && typeof payload.signal.removeEventListener === 'function') {
        payload.signal.removeEventListener('abort', onAbort);
      }
      inflight.delete(sid);
    }
  }

  // ── 真正的路由 ───────────────────────────────────────────────────────────
  ctx.on('agent/request', async (payload, next) => {
    const base = await next();
    if (!cfg.enabled || !base) return base;

    let route = LOCAL;
    let reason = 'default-local';
    let sid = 'global';
    try {
      sid = String(payload.agent && payload.agent.id ? payload.agent.id : 'global');
      const turn = payload.turn;
      stats.requests += 1;

      const pinned = pinnedFor(sid);
      const decision = pending.get(sid);
      if (pinned !== AUTO) {
        // 人工钉住优先于一切：即使 pre-step 这次没跑或没写 pending，也必须生效。
        route = pinned;
        reason = 'manual-pin';
        pending.delete(sid);
      } else if (decision && decision.turn === turn) {
        pending.delete(sid);
        route = decision.route;
        reason = decision.reason;
      } else if (isStuck(sid, turn)) {
        route = CLOUD;
        reason = 'sticky-turn';
      } else if (calledResearchTool(payload.agent, turn, cfg)) {
        route = CLOUD;
        reason = 'research-tool';
      }

      if (route === CLOUD) {
        if (cooldownUntil > Date.now()) {
          route = LOCAL;
          reason = 'cloud-cooldown';
        } else {
          const target = await resolveCloudTarget(false);
          if (!target) {
            route = LOCAL;
            reason = 'no-cloud-route';
          }
        }
      }

      if (route === CLOUD) stuck.set(sid, turn + cfg.stickyTurns - 1);
    } catch (err) {
      log('路由判定失败，保持基线:', err && err.message);
      return base;
    }

    if (route !== CLOUD) {
      stats.routedLocal += 1;
      stats.lastRoute = LOCAL;
      stats.lastReason = reason;
      record({ turn: payload.turn, step: payload.step, route: LOCAL, reason, model: `${base.provider}/${base.model}` });
      // forceLocal：配置了明确的本地 provider/model 时才强制，否则尊重 UI 里选中的模型。
      if (cfg.localProvider && cfg.localModel && (base.provider !== cfg.localProvider || base.model !== cfg.localModel)) {
        return { provider: cfg.localProvider, model: cfg.localModel };
      }
      return base;
    }

    const target = cloudTarget;
    if (!target) return base;
    if (base.provider === target.provider && base.model === target.model) {
      stats.lastRoute = CLOUD;
      stats.lastReason = `${reason}:already-cloud`;
      record({ turn: payload.turn, step: payload.step, route: CLOUD, reason: `${reason}:already-cloud`, model: `${target.provider}/${target.model}` });
      return base;
    }

    stats.routedCloud += 1;
    stats.lastRoute = CLOUD;
    stats.lastReason = reason;
    record({ turn: payload.turn, step: payload.step, route: CLOUD, reason, model: `${target.provider}/${target.model}` });
    log(`turn ${payload.turn}/step ${payload.step}: ${base.provider}/${base.model} → ${target.provider}/${target.model} (${reason})`);
    return cfg.keepControlsOnSwitch ? { ...base, ...target } : { provider: target.provider, model: target.model };
  });

  // ── 云端失败 → 冷却并降级 ────────────────────────────────────────────────
  ctx.on('agent/request-error', async (payload, next) => {
    try {
      if (cfg.enabled && cfg.fallbackToLocalOnCloudFailure && cloudTarget && payload.provider === cloudTarget.provider) {
        const code = payload.failure && payload.failure.code;
        if (!code || CLOUD_UNAVAILABLE_CODES.includes(code)) {
          stats.cloudFailures += 1;
          cooldownUntil = Date.now() + cfg.cloudCooldownMs;
          const sid = String(payload.agent && payload.agent.id ? payload.agent.id : 'global');
          stuck.delete(sid);
          pending.delete(sid);
          log(`云端失败 (${code || 'unknown'})，${Math.round(cfg.cloudCooldownMs / 1000)}s 内降级到本地`);
        }
      }
    } catch (err) {
      log('request-error 处理失败:', err && err.message);
    }
    return next();
  });

  // ── 人工钉住 / 状态查询 ──────────────────────────────────────────────────
  ctx.inject(['tools'], (scoped) => {
    scoped.tools.register({
      name: 'model_router',
      description:
        '查看或临时改变当前会话的模型路由。action=status 返回配置与最近一次真实路由结果；' +
        'action=set_route 把本会话钉到 auto / local / cloud（只存在内存里，插件重载或会话结束后恢复 auto）。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'set_route'], description: '要执行的动作，默认 status。' },
          route: { type: 'string', enum: ['auto', 'local', 'cloud'], description: 'action=set_route 时的目标路由。' }
        },
        required: [],
        additionalProperties: false
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            enabled: { type: 'boolean' },
            mode: { type: 'string' },
            route: { type: 'string' },
            local: { type: 'object' },
            cloud: { type: 'object' },
            researchMode: { type: 'string' },
            researchSubagentProvider: { type: 'string' },
            subagents: { type: 'array', items: { type: 'string' } },
            stats: { type: 'object' },
            note: { type: 'string' }
          },
          additionalProperties: true
        },
        render(_args, value) {
          return [{ type: 'text', text: renderStatus(value) }];
        }
      },
      async execute(args, exec) {
        const action = args && typeof args.action === 'string' ? args.action : 'status';
        const sid = String(exec && exec.agent && exec.agent.id ? exec.agent.id : 'global');
        if (action === 'set_route') {
          const route = normMode(args && args.route);
          if (route === AUTO) overrides.delete(sid);
          else overrides.set(sid, route);
          if (route !== CLOUD) stuck.delete(sid);
          pending.delete(sid);
          log(`session ${sid}: 已钉到 ${route}`);
          return buildStatus(route);
        }
        return buildStatus(pinnedFor(sid));
      }
    });
  });

  // ── 设置命名空间 ─────────────────────────────────────────────────────────
  /*
   * 设置页的「插件配置」标签只给**已注册设置命名空间**的插件发卡片，所以这里必须
   * 真的向 settings 服务登记一节。登记时把入口 config 当作基线（base），用户在
   * 设置页写入的是覆盖层；watch 回来就重算 cfg，路由立刻按新配置生效。
   * settings 服务不存在时（例如纯 CLI 环境）安静跳过，插件照常工作。
   */
  /*
   * 注意：这个构建里 `settings` 服务是 SettingsForms（面向 profile 条目的通用表单
   * 投影器），**没有** `register(ns, schema)` 这种「插件自带命名空间」的 API——
   * 那是 dsh-settings 的 SettingsProvider 才有的旧路径。所以这里不注册命名空间，
   * 而是走 configEditor：读当前条目配置、写完由 Loader 落回 profile 补丁并热生效。
   * 这样「插件配置」标签里的自动表单（Config 字段标为 volatile 时）和本包自己的
   * 配置页写的是同一份数据，不会有两份真值。
   */
  const PKG_NAME = '@local/dsh-model-router';
  let configError = null;

  /** 找到本插件在 profile 补丁里的那个条目（写配置的落点）。 */
  function findEntry() {
    try {
      const editor = typeof ctx.get === 'function' ? ctx.get('configEditor') : undefined;
      if (!editor || typeof editor.entries !== 'function') return undefined;
      const own = ctx.fiber && ctx.fiber.entry ? ctx.fiber.entry.options.id : undefined;
      const rows = editor.entries();
      return rows.find((row) => row.options.id === own) || rows.find((row) => row.options.name === PKG_NAME);
    } catch (err) {
      configError = err && err.message ? err.message : String(err);
      return undefined;
    }
  }

  /** 从入口 config 重算运行时配置；volatile 字段是活引用，每次读都是最新值。 */
  function refreshCfg() {
    try {
      cfg = normalize({ ...unwrapConfig(configRef), ...(memoryOverride || {}) });
    } catch (err) {
      log('配置解析失败，沿用上一份:', err && err.message);
    }
    return cfg;
  }

  /** 写配置：落到 profile 补丁（configEditor），没有编辑器时只改内存。 */
  async function writeConfig(patch) {
    const entry = findEntry();
    const editor = entry && typeof ctx.get === 'function' ? ctx.get('configEditor') : undefined;
    if (entry && editor && typeof editor.edit === 'function') {
      await editor.edit(entry, (current) => ({ ...unwrapConfig(current || {}), ...patch }));
    } else {
      memoryOverride = { ...(memoryOverride || {}), ...patch };
    }
    cloudResolvedAt = 0; // 路由目标可能跟着改了，下次重新解析
    return refreshCfg();
  }

  // ── 配置页用的本机 HTTP 接口 ─────────────────────────────────────────────
  /*
   * 客户端的 settingsScope 服务在浏览器侧没有暴露，所以配置页通过本包自己的
   * 本机路由读写（和 mcp-manager 同一套路）。三重限制：只监听本机 Host、
   * 必须带自定义头（跨站表单设不出来）、只收 application/json。
   */
  const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined;
  if (webServer && typeof webServer.register === 'function') {
    ctx.effect(
      () =>
        webServer.register({
          kind: 'prefix',
          path: ROUTE,
          handler: async (req, res) => {
            try {
              const originError = validateOrigin(req);
              if (originError) {
                sendJson(res, 403, { ok: false, error: originError });
                return;
              }
              const url = new URL(req.url ?? '/', 'http://localhost');
              const path = url.pathname.replace(/\/+$/, '');

              if (req.method === 'GET' || req.method === 'HEAD') {
                if (path === `${ROUTE}/state`) {
                  sendJson(res, 200, { ok: true, data: await describe() });
                  return;
                }
                sendJson(res, 404, { ok: false, error: `no route ${path}` });
                return;
              }
              if (req.method !== 'POST') {
                sendJson(res, 405, { ok: false, error: 'method not allowed' });
                return;
              }
              const contentType = String(req.headers['content-type'] ?? '')
                .split(';')[0]
                .trim()
                .toLowerCase();
              if (contentType !== 'application/json') {
                sendJson(res, 415, { ok: false, error: 'content-type must be application/json' });
                return;
              }
              if (String(req.headers['x-dsh-model-router'] ?? '') !== '1') {
                sendJson(res, 403, { ok: false, error: 'missing x-dsh-model-router: 1 header' });
                return;
              }
              const body = await readBody(req);

              if (path === `${ROUTE}/config`) {
                const patch = body && typeof body === 'object' ? body : {};
                await writeConfig(patch);
                sendJson(res, 200, { ok: true, data: await describe() });
                return;
              }
              if (path === `${ROUTE}/probe`) {
                // 配好之后点一下，确认云端这条路由真的能用。
                const target = await resolveCloudTarget(true);
                sendJson(res, 200, { ok: true, data: { target: target ?? null, ...(await describe()) } });
                return;
              }
              if (path === `${ROUTE}/reset`) {
                await writeConfig(Config({}));
                sendJson(res, 200, { ok: true, data: await describe() });
                return;
              }
              sendJson(res, 404, { ok: false, error: `no route ${path}` });
            } catch (err) {
              const status = err && typeof err.statusCode === 'number' ? err.statusCode : 500;
              sendJson(res, status, { ok: false, error: err && err.message ? err.message : String(err) });
            }
          }
        }),
      'model-router routes'
    );
  }

  /** 配置页一次要看的全部内容：当前配置、可选路由、解析结果、统计。 */
  async function describe() {
    let providers = [];
    try {
      const list = (await ctx.llm.listProviders()) || [];
      providers = list.map((p) => (typeof p === 'string' ? p : p && p.id)).filter(Boolean);
    } catch (err) {
      log('listProviders 失败:', err && err.message);
    }
    const models = {};
    for (const id of providers) {
      try {
        const list = (await ctx.llm.listModels(id)) || [];
        models[id] = list.map((m) => (typeof m === 'string' ? m : m && m.id)).filter(Boolean);
      } catch {
        models[id] = [];
      }
    }
    return {
      config: cfg,
      defaults: Config({}),
      providers,
      models,
      subagents: subagentNames(ctx, log),
      cloudTarget: cloudTarget ?? null,
      cooldown: Math.max(0, cooldownUntil - Date.now()),
      managed: Boolean(findEntry()),
      settingsError: configError,
      writable: Boolean(findEntry()),
      stats: { ...stats },
      recent: recent.slice()
    };
  }

  function buildStatus(pinned) {
    return {
      ok: true,
      enabled: cfg.enabled,
      mode: cfg.mode,
      route: pinned || cfg.mode,
      local: { provider: cfg.localProvider || '(当前选中)', model: cfg.localModel || '(当前选中)' },
      cloud: cloudTarget ? { provider: cloudTarget.provider, model: cloudTarget.model } : { provider: '(未解析)', model: '(未解析)' },
      coolingDown: cooldownUntil > Date.now(),
      stickyTurns: cfg.stickyTurns,
      researchMode: cfg.researchMode,
      researchSubagentProvider: cfg.researchSubagentProvider,
      subagents: subagentNames(ctx, log),
      researchKeywordCount: cfg.researchKeywords.length,
      researchToolCount: cfg.researchTools.length,
      stats: { ...stats },
      recent: recent.slice()
    };
  }

  function pinnedFor(sid) {
    return overrides.get(String(sid)) || cfg.mode;
  }

  function isStuck(sid, turn) {
    const until = stuck.get(String(sid));
    if (until === undefined) return false;
    if (turn <= until) return true;
    stuck.delete(String(sid));
    return false;
  }

  return () => {
    overrides.clear();
    pending.clear();
    stuck.clear();
    inflight.clear();
    recent.length = 0;
  };
}

// ── 纯函数（导出以便单测） ────────────────────────────────────────────────

/** 读取已注册的子智能体 provider 名；服务缺失时返回空数组。 */
function subagentNames(ctx, log) {
  try {
    const subagents = typeof ctx.get === 'function' ? ctx.get('subagents') : undefined;
    if (!subagents || typeof subagents.list !== 'function') return [];
    const list = subagents.list();
    return Array.isArray(list) ? list.map(String) : [];
  } catch (err) {
    if (typeof log === 'function') log('subagents.list() 失败:', err && err.message);
    return [];
  }
}

/** 只接受本机 Host，且跨站请求直接拒绝。 */
function validateOrigin(req) {
  const host = typeof req.headers.host === 'string' ? req.headers.host : '';
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) return 'forbidden host';
  if (req.headers['sec-fetch-site'] === 'cross-site') return 'forbidden cross-site request';
  const origin = req.headers.origin;
  if (typeof origin === 'string') {
    try {
      if (new URL(origin).host !== host) return 'forbidden origin';
    } catch {
      return 'forbidden origin';
    }
  }
  return null;
}

/** 读 JSON 请求体，上限 1MB（设置项都是小对象）。 */
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw Object.assign(new Error('request body too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  return JSON.parse(text);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(body);
}

/**
 * 解包 volatile 配置引用。
 *
 * Cordis 的 volatile 字段在解析后不是普通值，而是 `{ get(): T }` 形式的活引用
 * （共享符号协议，见 cordis 的 createVolatile / isVolatile）。深层字段里也可能
 * 嵌着引用，所以这里递归展开成纯数据；非引用值原样返回。
 */
export function unwrapConfig(value) {
  if (value === null || typeof value !== 'object') return value;
  if (typeof value.get === 'function' && typeof value.set !== 'function') {
    // volatile 引用：只暴露 get()，普通对象不会有这个方法。
    try {
      return unwrapConfig(value.get());
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(value)) return value.map(unwrapConfig);
  const out = {};
  for (const key of Object.keys(value)) out[key] = unwrapConfig(value[key]);
  return out;
}

export function normalize(config) {
  const cfg = { ...unwrapConfig(config) };
  cfg.mode = normMode(cfg.mode);
  cfg.researchKeywords = toList(cfg.researchKeywords);
  cfg.researchTools = toList(cfg.researchTools);
  cfg.stickyTurns = Number.isFinite(cfg.stickyTurns) && cfg.stickyTurns > 0 ? Math.floor(cfg.stickyTurns) : 1;
  cfg.cloudCooldownMs = Number.isFinite(cfg.cloudCooldownMs) && cfg.cloudCooldownMs >= 0 ? cfg.cloudCooldownMs : 600000;
  cfg.cloudProvider = String(cfg.cloudProvider || AUTO).trim() || AUTO;
  cfg.cloudModel = String(cfg.cloudModel || AUTO).trim() || AUTO;
  cfg.localProvider = String(cfg.localProvider || '').trim();
  cfg.localModel = String(cfg.localModel || '').trim();
  cfg.researchMode = cfg.researchMode === 'inline' ? 'inline' : 'subagent';
  cfg.researchSubagentProvider = String(cfg.researchSubagentProvider || 'spawn').trim() || 'spawn';
  cfg.researchTimeoutMs =
    Number.isFinite(cfg.researchTimeoutMs) && cfg.researchTimeoutMs > 0 ? Math.floor(cfg.researchTimeoutMs) : 180000;
  cfg.researchMaxDepth =
    Number.isFinite(cfg.researchMaxDepth) && cfg.researchMaxDepth >= 0 ? Math.floor(cfg.researchMaxDepth) : 1;
  cfg.researchPrompt = String(cfg.researchPrompt || '');
  return cfg;
}

/** 取文本首行并截断，用于子智能体的 label。 */
export function firstLine(text, max) {
  const body = String(text || '').replace(/\s+/g, ' ').trim();
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 40;
  return body.length <= limit ? body : `${body.slice(0, limit - 1)}…`;
}

/** 拼接 ContentBlock[] 里的文本；也接受字符串。 */
export function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

/**
 * 是否为子会话。
 *
 * 子智能体自己也会发 LLM 请求并触发同一套钩子，若不设防会无限套娃。
 * 三个判据任一成立即视为子会话（三者是不同版本留下的痕迹，都认更稳）。
 */
export function isChildSession(agent) {
  try {
    const header = agent && agent.session && agent.session.header;
    if (!header) return false;
    if (header.parentSession) return true;
    if (header.origin === 'subagent') return true;
    if (Number(header.delegationDepth) > 0) return true;
    return false;
  } catch {
    return false;
  }
}

/** 构造交给子智能体的调研任务提示词。 */
export function buildResearchPrompt(text, template) {
  const question = String(text || '').trim();
  const custom = String(template || '').trim();
  if (custom) return custom.split('{question}').join(question);
  return [
    '你是一个调研子智能体。请联网调研下面这个请求，然后把结论回传给主会话。',
    '',
    '要求：',
    '1. 先用 web_search / x_search 检索，必要时用 web_fetch 或 read_page 打开原文核实。',
    '2. 只回传结论，不要复述搜索过程；不要改代码、不要写文件。',
    '3. 结论里给出关键事实、版本号、链接，并标注哪些点没能证实。',
    '4. 用中文回答，控制在 800 字以内。',
    '',
    '请求原文：',
    question
  ].join('\n');
}

/**
 * 构造回注主会话的调研结论消息。
 *
 * 不能 import createUserMessage（@deepseek-ai/dsh-llm 不在 profile 依赖里），
 * 所以这里手搓等价结构：id 用 uuid，source 用 plugin + notice。
 */
export function buildResearchMessage(question, answer, target, stopReason) {
  const route = target ? `${target.provider}/${target.model}` : 'cloud';
  const summary = `云端子智能体调研结论（${route}，${stopReason}）`;
  return {
    id: globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function' ? globalThis.crypto.randomUUID() : `mr-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    role: 'user',
    content: [
      {
        type: 'text',
        text: [
          `【云端子智能体调研结论】模型 ${route}，结束原因 ${stopReason}。`,
          '主会话仍在本地模型上，可直接基于以下结论继续；除非需要追问细节，不必重复检索。',
          '',
          '调研问题：',
          firstLine(question, 200),
          '',
          '结论：',
          String(answer || '').trim()
        ].join('\n')
      }
    ],
    source: { kind: 'plugin', plugin: 'model-router', form: 'notice', summary }
  };
}

export function normMode(value) {
  const s = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return s === CLOUD || s === LOCAL ? s : AUTO;
}

function toList(value) {
  if (Array.isArray(value)) return value.map((v) => String(v ?? '').trim()).filter(Boolean);
  if (typeof value === 'string' && value.trim()) {
    return value.split(/[,，\n]/).map((v) => v.trim()).filter(Boolean);
  }
  return [];
}

/** 从 UserMessage[] 里抽出可读文本（只取 text block）。 */
export function messagesText(messages) {
  if (!Array.isArray(messages)) return '';
  const parts = [];
  for (const msg of messages) {
    if (!msg) continue;
    const content = msg.content;
    if (typeof content === 'string') {
      parts.push(content);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
      }
    }
  }
  return parts.join('\n');
}

/**
 * 判定这一 step 该走哪边。返回 { route, reason }；undefined 表示没有明确意图。
 * 优先级：人工钉住 > 显式指令 > URL > 调研关键词。
 */
export function classify(text, cfg, pinned) {
  if (pinned === CLOUD) return { route: CLOUD, reason: 'manual-pin' };
  if (pinned === LOCAL) return { route: LOCAL, reason: 'manual-pin' };

  const body = String(text || '').trim();
  if (!body) return undefined;

  if (/(?:\/|@)(?:cloud|云端|联网)|走云端|用云端|切到云端|switch to cloud/i.test(body)) {
    return { route: CLOUD, reason: 'explicit-cloud' };
  }
  if (/(?:\/|@)(?:local|本地)|走本地|用本地|切回本地|switch to local/i.test(body)) {
    return { route: LOCAL, reason: 'explicit-local' };
  }
  if (/https?:\/\/\S+/i.test(body)) return { route: CLOUD, reason: 'contains-url' };

  const hit = matchesResearch(body, cfg.researchKeywords);
  if (hit) return { route: CLOUD, reason: `keyword:${hit}` };

  return { route: LOCAL, reason: 'no-research-intent' };
}

/** 关键词检测：返回命中的那个词，没有则 undefined。 */
export function matchesResearch(text, keywords) {
  const body = String(text || '').toLowerCase();
  if (!body) return undefined;
  for (const keyword of keywords || []) {
    const needle = String(keyword || '').trim().toLowerCase();
    if (needle && body.includes(needle)) return keyword;
  }
  return undefined;
}

/** 工具名匹配，支持结尾 * 通配。 */
export function matchesToolName(patterns, name) {
  const value = String(name || '');
  return (patterns || []).some((pattern) => {
    const p = String(pattern || '').trim();
    if (!p) return false;
    if (p.endsWith('*')) return value.startsWith(p.slice(0, -1));
    return value === p;
  });
}

/** 本 turn 里是否已经调用过研究类工具（说明正在联网调研）。 */
function calledResearchTool(agent, turn, cfg) {
  try {
    const session = agent && agent.session;
    if (!session) return false;
    const events = session.events;
    if (!Array.isArray(events)) return false;
    for (const ev of events) {
      if (ev && ev.type === 'tool/call' && ev.data && ev.data.turn === turn && matchesToolName(cfg.researchTools, ev.data.name)) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

function renderStatus(value) {
  if (!value || typeof value !== 'object') return String(value);
  const stats = value.stats || {};
  const lines = [
    `model-router: enabled=${value.enabled}  mode=${value.mode}  当前会话=${value.route}`,
    `  本地: ${value.local?.provider}/${value.local?.model}`,
    `  云端: ${value.cloud?.provider}/${value.cloud?.model}${value.coolingDown ? '  (冷却中)' : ''}`,
    `  调研: ${value.researchMode === 'inline' ? '主会话自己切云端' : `云端子智能体 (${value.researchSubagentProvider || 'spawn'})`}`,
    `  已处理 ${stats.requests ?? 0} 次请求：切云端 ${stats.routedCloud ?? 0} 次，留本地 ${stats.routedLocal ?? 0} 次，云端失败 ${stats.cloudFailures ?? 0} 次`,
    `  调研外包 ${stats.researchSpawns ?? 0} 次：成功 ${stats.researchOk ?? 0}，失败 ${stats.researchFailed ?? 0}，空结论 ${stats.researchEmpty ?? 0}`,
    `  最近一次: ${stats.lastRoute ?? '-'} (${stats.lastReason ?? '-'})`,
    `  触发词 ${value.researchKeywordCount ?? 0} 个，研究类工具 ${value.researchToolCount ?? 0} 个`
  ];
  if (Array.isArray(value.recent) && value.recent.length) {
    lines.push('  最近的决策（turn/step → 路由）:');
    for (const item of value.recent.slice(-5)) {
      lines.push(`    t${item.turn}/s${item.step} → ${item.route} (${item.reason}) ${item.model || ''}`.trimEnd());
    }
  }
  return lines.join('\n');
}
