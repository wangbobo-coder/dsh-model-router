# dsh-model-router

在 **本地模型** 与 **DeepSeek 官方云端模型** 之间自动路由每一次模型请求的 DSH 插件。

日常开发留在本地模型（快、省成本），遇到需要深度调研或强推理的轮次自动升级到云端模型，结束后回到本地。附带一个可视化设置页。

## 功能

- **自动意图判定** —— 按关键词、URL、显式指令判断当前轮次该走哪边
- **逐请求路由** —— 不是切换全局模型，而是每次 `agent/request` 单独决策，同一会话内可来回切换
- **调研外包给子智能体** —— 调研轮次开一个云端子智能体去查，把结论带回主会话，主线始终留在本地模型，你的模型选择不会被中途改掉
- **研究轮次黏住** —— 一旦某轮调用了搜索/抓取类工具，该轮后续 step 不换模型，避免工具结果回来后又跳回本地
- **故障降级** —— 云端鉴权/配额失败时自动回到本地并冷却，不会让对话卡死；子智能体超时或失败也只是放弃这次查询，不中断对话
- **可视化配置页** —— 设置 → 模型路由，改配置即时生效，无需重启
- **运行时状态** —— `model_router` 工具可查看当前路由目标、调研方式、冷却状态、最近若干次决策

## 判定顺序

每次模型请求按以下优先级决定路由：

1. `model_router` 工具人工钉住（`set_route`），本会话内存有效
2. 本 turn 的意图判定（见下）
3. 云端黏住（`stickyTurns`）
4. 本 turn 已调用过 `researchTools` 中的工具 → 留在云端
5. 其余 → 本地

意图判定规则：

- 显式指令：`走云端` / `用云端` / `switch to cloud` → 云端；`走本地` / `切回本地` / `switch to local` → 本地
- 消息含 URL（`https?://`）→ 云端
- 命中 `researchKeywords` 任一关键词（不区分大小写）→ 云端，日志记录命中词
- 否则 → 本地

## 调研外包（子智能体）

判定为「云端」之后，还要决定**怎么**跑这次调研，由 `researchMode` 控制：

| 模式 | 行为 |
| --- | --- |
| `subagent`（默认） | 主会话**不动**，另起一个云端子智能体去检索，把结论作为一条消息回注本步，主会话仍用本地模型继续 |
| `inline` | 主会话自己切到云端，跑完这一轮再回来 |

子智能体模式的收益：主线任务的模型选择全程不被改动，调研耗时也不占用主线的上下文增长（只回注结论，不回注搜索过程）。

触发外包需同时满足：`researchMode = subagent`、本轮判定为云端、非人工钉住、位于本轮第一步、当前是顶层会话（防止子智能体再套娃）、云端路由可用且不在冷却期。

以下情况自动退回 `inline`，不阻断对话：

- `subagents` 服务不可用，或配置的 provider 未注册
- 子智能体抛错
- 子智能体超时（`researchTimeoutMs`）
- 子智能体返回空结论（例如 `max-tokens` 截断）

回注的消息 `source` 为 `{ kind: 'plugin', plugin: 'model-router', form: 'notice' }`，可在会话日志里辨认。

意图判定规则：

- 显式指令：`走云端` / `用云端` / `switch to cloud` → 云端；`走本地` / `切回本地` / `switch to local` → 本地
- 消息含 URL（`https?://`）→ 云端
- 命中 `researchKeywords` 任一关键词（不区分大小写）→ 云端，日志记录命中词
- 否则 → 本地

## 安装

用 DSH 的插件管理器安装（推荐）：

```
plugin_manager  action: install_bundle  target: "<本目录的绝对路径>"
```

装好后包会以 `link:` 方式进入 profile，自动写入依赖与 `dsh.profile.bundles`。

不要手动 `pnpm add` 进 profile，也不要单独手改 `package.json` 或 `cordis.patch.yml` —— 装了包不等于选中了它的 bundle，那一行会存在但永远不会被挂载。

纯 JS 实现，无需构建。

### 启用

安装后即默认启用。若之前手动禁用过，把 profile 的 `cordis.patch.yml` 里对应行的 `disabled: true` 去掉即可。

## 使用

**什么都不用做。** 装好后自动生效，按上面的规则路由。

需要人工干预时：

- 在对话里说 `走云端` / `切回本地`，本轮立即切换
- 或调用 `model_router` 工具把本会话钉到某一边：

| action | 参数 | 说明 |
| --- | --- | --- |
| `status` | — | 查看当前模式、解析到的本地/云端目标、冷却状态、最近 8 次决策 |
| `set_route` | `route: auto \| local \| cloud` | 钉住本会话；`auto` 解除。仅内存，重载失效 |

**设置页**：设置 → 模型路由，七组卡片（基础 / 本地 / 云端 / 意图 / 深度调研 / 故障 / 最近决策），改动即时生效，保留原始 JSON 视图。

## 配置

配置项全部可在设置页调整，也可在 `cordis.patch.yml` 的 `config:` 块里预置。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关。关闭后插件完全不介入。 |
| `mode` | `auto` | `auto` 按意图判定；`local` / `cloud` 强制走某一边。 |
| `localProvider` | `''` | 本地 provider。**留空 = 不干预**，沿用 UI 中选中的模型。 |
| `localModel` | `''` | 本地 model。留空同上。 |
| `cloudProvider` | `auto` | 云端 provider。`auto` 依次尝试 `deepseek-account` → `deepseek-official` → `llm-deepseek`。 |
| `cloudModel` | `deepseek-flash` | 云端 model。`auto` 表示按目录自动挑（优先 flash 类，否则第一个）。 |
| `keepControlsOnSwitch` | `false` | 切云端时是否沿用基线的 `temperature` / `maxTokens` / `reasoningEffort`。 |
| `researchKeywords` | 43 个中英文词 | 命中即判定为需要联网/调研。 |
| `researchTools` | `web_search, web_fetch, x_search, read_page, mcp__*` | 本 turn 调用过就留在云端，结尾 `*` 通配。 |
| `stickyTurns` | `1` | 切到云端后黏住多少个 turn。 |
| `researchMode` | `subagent` | `subagent` = 开云端子智能体调研，主会话留本地；`inline` = 主会话自己切云端。 |
| `researchSubagentProvider` | `spawn` | 子智能体 provider，取自 `ctx.subagents.list()`。 |
| `researchTimeoutMs` | `180000` | 子智能体超时（毫秒）。超时放弃本次调研。 |
| `researchMaxDepth` | `1` | 子智能体可再往下委派的最大深度。`1` = 不允许孙智能体。 |
| `researchPrompt` | `''` | 自定义子智能体提示词，`{question}` 替换成请求原文；留空用内置模板。 |
| `fallbackToLocalOnCloudFailure` | `true` | 云端失败自动降级到本地。 |
| `cloudCooldownMs` | `600000` | 降级冷却时长（毫秒）。 |
| `logRouting` | `true` | 每次真实换路由输出一行日志。 |

provider 与 model 默认值在启动时通过 `ctx.llm.listProviders()` / `listModels()` 解析，换机器或换 profile 无需预先知道路由 id。

> **关于 `deepseek-flash`**：这是官方目录里 DeepSeek-V4.1-Flash 的 model id。UI 上看到的 `1017` 是装饰插件加的徽标，不属于 id 的一部分。

## 故障降级

以下失败会触发降级：`ACCOUNT_SIGN_IN_REQUIRED`、`ACCOUNT_TOKEN_INVALID`、`MISSING_CREDENTIAL`、
`INVALID_CREDENTIAL`、`AUTH`、`QUOTA`、`ACCOUNT_QUOTA`、`MODEL_UNSUPPORTED`、
`CLIENT_UPGRADE_REQUIRED`、`DUPLICATE_ADAPTER`、`TRANSPORT`。

降级后云端冷却 `cloudCooldownMs`，期间自动路由只走本地。设 `fallbackToLocalOnCloudFailure: false` 可关闭。

## 说明

- 插件只对主 agent 请求生效。会话标题生成等辅助请求有各自模型选择逻辑，不受影响。
- 子智能体本身也是 agent，同样会触发这套钩子；插件通过 `parentSession` / `origin` / `delegationDepth` 识别子会话并跳过外包，避免无限套娃。
- `localProvider` / `localModel` 留空时，插件不强行指定本地模型，而是原样放行当前选中项 —— 「本地」的默认含义就是不干预 UI 选择。
- 云端路由需要对应的 provider 已注册且已认证（如 `deepseek-account` 需已登录）。未就绪时自动路由只保留本地。

## License

MIT
