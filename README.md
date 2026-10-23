# dsh-model-router

> **当前状态：已禁用（`disabled: true`），代码保留备查。**
>
> 2026-10-23 结论：DSH 的 `web_search` / `web_fetch` 是**宿主侧工具**
> （`@deepseek-ai/dsh-tool-web` 经 `ctx.web` 能力接口分发，实际执行在宿主进程里），
> 搜索结果以工具结果形式回给当前正在跑的那个模型。所以「必须切到云端模型才能联网搜索」
> 这个前提并不成立 —— 本地模型 + 官方搜索插件已能完整联网调研。
>
> 本会话实测：373 次请求中 356 次走本地 `deepseek-v4-flash/deepseek_v4.1_flash`，
> 期间在本地模型上完成了数十次 `web_search` / `web_fetch`，云端失败 0 次。
>
> 想重新启用：把 profile 的 `cordis.patch.yml` 里 `id: model-router` 的
> `disabled: true` 改成 `false`（或 `plugin_manager set_plugin target=include:model-router enabled=true`），
> 之后在「设置 → 模型路由」页里调整。重新启用前请先想清楚要它解决哪个问题 ——
> 如果只是要联网能力，官方搜索插件已经够了；它的剩余价值是**用更强的云端模型做深度综合**
> 以及**成本控制**（日常留本地、重活升级）。

在 **本地模型** 与 **DeepSeek 官方云端模型** 之间自动路由每一次模型请求的 DSH 插件。

## 它解决什么问题

用本地网关（`llm-pi-ai` → 内网 OpenAI 兼容端点）跑日常开发时，原本的设想是：
一旦某个 turn 需要联网搜索 / 调研，本地模型没有可靠的联网能力。这个插件会在请求发出前判断意图：
需要联网就把这一次请求换成云端官方路由（`deepseek-account` / `deepseek-official`），
把资料取回来之后，后续普通开发请求仍然回到本地。

**但联网能力实际上与模型解耦**（见上方状态说明）。所以现在它真正的用途是：
把「重调研 / 需要更强推理」的轮次升级到云端模型，同时日常开发留在本地以省成本。


## 判定顺序

`agent/request` 每次请求按下面的优先级决定路由：

1. `model_router` 工具人工钉住（`set_route`）—— 最高优先级，只在本会话内存里有效；
2. 本 turn 的 `agent/pre-step` 判定结果（见下）；
3. 云端黏住（`stickyTurns`，默认 1 = 仅当前 turn）；
4. 本 turn 已经调用过 `researchTools` 里的工具 → 留在云端（工具结果回来后的后续 step 不换模型）；
5. 其余 → 本地。

`agent/pre-step` 的判定（`classify()`）：

- 显式指令：`/cloud`、`走云端`、`用云端`、`切到云端`、`switch to cloud` → 云端；
  `/local`、`走本地`、`用本地`、`切回本地`、`switch to local` → 本地；
- 消息里含 URL（`https?://`）→ 云端（通常是要取这个页面）；
- 命中 `researchKeywords` 任一关键词（不区分大小写）→ 云端，日志里会记下命中的词；
- 否则 → 本地。

## 故障降级

云端这一侧鉴权 / 配额 / 模型不支持类失败（`ACCOUNT_SIGN_IN_REQUIRED`、`ACCOUNT_TOKEN_INVALID`、
`MISSING_CREDENTIAL`、`AUTH`、`QUOTA`、`MODEL_UNSUPPORTED`、`TRANSPORT` 等）时，
插件把云端冷却 `cloudCooldownMs`（默认 10 分钟），期间自动路由只走本地，不会让整轮对话卡死。
设置 `fallbackToLocalOnCloudFailure: false` 可以关掉这个行为。

## 配置

全部配置在包内的 `cordis.patch.yml`（也可以直接在 profile 的 patch 里覆盖同名 `id: model-router` 行）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关。关掉后插件完全不介入。 |
| `mode` | `auto` | `auto` 按意图判定；`local` / `cloud` 全部强制走某一边。 |
| `localProvider` / `localModel` | `''` | 本地路由。**留空 = 不干预**，沿用你在 UI 里选中的模型。 |
| `cloudProvider` | `auto` | 云端 provider。`auto` 会从已注册路由里依次尝试 `deepseek-account` → `deepseek-official` → `llm-deepseek`。 |
| `cloudModel` | `deepseek-flash` | 云端 model。默认就是官方目录里带 **1017** 徽标的 DeepSeek-V4.1-Flash。`auto` 表示按目录自动挑（优先 `deepseek-flash`，其次任意 flash，最后第一个）。 |
| `keepControlsOnSwitch` | `false` | 切到云端时是否沿用基线的 `temperature` / `maxTokens` / `reasoningEffort`。 |
| `researchKeywords` | 43 个中英文词 | 命中即判定「这一轮需要联网」。 |
| `researchTools` | `web_search, web_fetch, x_search, read_page, mcp__*` | 本 turn 调用过就留在云端，结尾 `*` 通配。 |
| `stickyTurns` | `1` | 切到云端后黏住多少个 turn。 |
| `fallbackToLocalOnCloudFailure` | `true` | 云端失败自动降级。 |
| `cloudCooldownMs` | `600000` | 降级冷却时长。 |
| `logRouting` | `true` | 每次真实换路由打一行日志。 |

云端 provider/model 默认是 `auto` / `deepseek-flash`，启动时通过 `ctx.llm.listProviders()` / `listModels()` 实测解析，
所以换一台机器、换一个 profile 也能直接用，不需要先知道路由 id。

### 关于 `deepseek-v4.1-flash-1017`

这个字符串**不是** model id。它是 UI 装饰插件包 `@deepseek-ai/dsh-client-ui-deepseek-model-label-1017`
的包名；那个插件只在 `provider.id` 属于 `deepseek-account` / `deepseek-official`、
且 `model.id === 'deepseek-flash'`、`model.name === 'DeepSeek-V4.1-Flash'` 时，给模型名追加一个 `1017` 徽标。
所以配置里要填的是 **`deepseek-flash`**（provider 用 `deepseek-account`）。


## `model_router` 工具

- `action: "status"` —— 返回开关、模式、解析到的本地/云端目标、冷却状态、最近一次真实路由与命中原因、计数统计，
  以及最近 8 次路由决策（`t<turn>/s<step> → 路由 (原因) 使用的模型`），用来确认某一轮到底走了哪边。
- `action: "set_route"` + `route: "auto" | "local" | "cloud"` —— 把本会话临时钉到某一边；
  `auto` 解除钉住。只存在内存，插件重载或会话结束即失效。

钉住的优先级高于自动判定，并且在 `agent/request` 里独立判断，不依赖 `agent/pre-step` 是否写入过判定结果。
注意：钉到 `local` 时，如果 `localProvider` / `localModel` 留空，插件不会强行指定本地模型，
而是把你当前选中的模型原样放行——因为「本地」在配置里的默认含义就是「不干预 UI 选择」。

## 验证边界

插件注册的是 Host 侧 waterfall 事件。安装后可以确认的是：插件行已进入 loader 树、
`agent/request` / `agent/pre-step` / `agent/request-error` 监听已挂载、`model_router` 工具已注册。
「某个具体 turn 真的落到了云端」只能通过运行时日志（`[model-router] turn X/step Y: ... → ...`）
与 `model_router status` 的决策列表来确认，静态检查做不到。

另：插件只对本会话的主 agent 请求生效；会话标题生成、子 agent 等辅助请求有各自的模型选择逻辑，
可能仍走本地，`model_router status` 的「留本地」计数里会包含它们。

## 自测

纯函数（`classify` / `matchesResearch` / `matchesToolName` / `messagesText` / `normalize`）已导出，
可在任何 Node 22+ 环境里直接 import 单测，不需要启动 DSH。
