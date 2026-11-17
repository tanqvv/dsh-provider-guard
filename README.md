# dsh-provider-guard

让 DSH 的**所有模型调用跟着你当前选中的供应商走**，不在后台换一家。

选 opencode-go，就用 opencode 的模型；选 DeepSeek，就用 DeepSeek。标题、压缩、
子代理、记忆、网页搜索这些辅助路径，原本可能各写死一家供应商；这个插件会停下
越界的调用并报给使用者，同时拦住另一家供应商的专用端点。**普通网络流量不拦**——
npm 更新、微信登录、dsh-remote 心跳、网页抓取都照常。

## 和上一版的区别

上一版做成了"只允许 opencode.ai 的全网络白名单"，把微信、更新、dsh-remote 一起
掐了，那是理解错了。这一版只管**模型供应商**：

| 流量 | 处理 |
|---|---|
| 你当前供应商的模型请求 | 放行 |
| 辅助调用点名了别的供应商（标题/压缩/子代理/记忆等） | **停住并报错**；需要时你手动改配置 |
| 主循环/子代理试图换到别的供应商（含失败回退） | **停住并报错**，不自动切换 |
| 另一家供应商的专用端点（DeepSeek 网页搜索、OpenAI 图片等） | **拦截** |
| npm 更新、微信、dsh-remote、普通网页抓取 | 放行，不碰 |
| 本机回环 / 局域网 | 放行 |

## 它怎么知道"当前供应商"

- 主循环请求是 DSH 深冻结的 `llm/stream` 调用；插件先核对它的 `provider` 与
  UI 当前选择是否一致。一致才放行并记录；不一致按自动切换停住。你在 UI 里切
  供应商，下一条主循环请求就会更新记录，**不需要重启**。
- 辅助调用以 UI 的 `agentDefaultModel.currentSelection()` 为准；本会话记录只在
  与它一致时采用；都没有时用进程内最近一次主循环选择或 `fallbackProvider`。
- 如果辅助调用的 provider 和当前选择不一致：
  - `block`（默认）：直接抛 `PROVIDER_MISMATCH`，聊天框显示是哪条辅助调用、
    原本要用的供应商，以及“没有自动切换”。
  - `reroute`（显式开启）：克隆请求，换成当前 provider 和当前 model，再走
    `llm.stream`；用 `Symbol.for('dsh-provider-guard.bypass')` 防递归。这会静默换
    模型，只有你明确接受时才开。
  - `audit`：只记录，不改道。
- 主循环请求（DSH 深冻结、无 purpose）如果 provider 和当前选择不一致，默认
  `blockAutoSwitch: true` 会直接抛 `PROVIDER_AUTO_SWITCH_BLOCKED` 并停止本轮，
  不会把它当成新的选择，也不会更新 active。

## 不自动切换 / 不回退

这是第二条硬规则：

- 网络不通、额度用完、鉴权失败、供应商 5xx：`llm-retry` 只会重试**同一家**
  供应商；重试耗尽后错误直接回到聊天框，本轮停止。插件不会去找另一家。
  同一家供应商的常规重试仍由 DSH 的 `retryPolicy` 控制（默认 5 次），
  不涉及切换；想在第一次失败就停，把该 provider 的 `retryPolicy.maxRetries`
  设为 `0`。终态失败会在原错误后追加一句：
  `[dsh-provider-guard] 不会自动切换或回退到其他供应商；如果本轮最终失败，请手动在模型选择器里更换供应商后重试。`
- 主循环请求如果 provider 和当前 UI 选择不一致（例如某个插件把路由改成
  DeepSeek，或在失败后回退），`blockAutoSwitch` 直接停止并报错：

  ```text
  [provider-guard] 已停止：本会话要使用的模型供应商 "deepseek-official"
  与当前选择 "opencode-go" 不一致。DSH 不会自动切换、回退或探测其他供应商，
  也没有发出这条请求。请你在模型选择器里手动确认/更换供应商后重试。
  ```

- 未来如果某个插件在后台“搜索/探测可用供应商”并改选择，它发出的模型请求会
  在上面的判断处停下；它探测另一家供应商的 HTTP 端点也会被端点策略拦住。
- 唯一被信任的选择变化是你在 UI 模型选择器里的切换：它会更新
  `agentDefaultModel.currentSelection()`，下一条主循环请求与它一致后被放行。

## 网页搜索为什么在 opencode 下不可用

DSH 的 `web-search-deepseek` 是 DeepSeek 专用端点（`api.deepseek.com/v1/tools/search`），
它不走 `llm/stream`，所以只能按端点拦。当前选 opencode 时它会得到
`PROVIDER_HOST_BLOCKED`，不会消耗 DeepSeek key；选 DeepSeek 时自动放行。
如果以后有 opencode 的搜索 provider，把它接上即可，不需要改这个插件。

## 安装（标准插件）

这是标准 DSH bundle 包。三种装法任选：

### npm（发布后）

```sh
dsh plugin --profile desktop add dsh-provider-guard
dsh plugin --profile web add dsh-provider-guard
```

### GitHub（不需要 npm 账号）

```sh
dsh plugin --profile desktop add github:tanqvv/dsh-provider-guard#v0.2.3
dsh plugin --profile web add github:tanqvv/dsh-provider-guard#v0.2.3
```

### 本地 tarball

```sh
dsh plugin --profile desktop add /path/to/dsh-provider-guard-0.2.3.tgz
dsh plugin --profile web add /path/to/dsh-provider-guard-0.2.3.tgz
```

`dsh plugin` 会：

1. 用 pnpm 把包装进 profile 的 `node_modules`；
2. 因为包声明了 `dsh.bundle.patch`，自动把 `dsh-provider-guard` 加进
   `dsh.profile.bundles`；
3. 包里的 `cordis.patch.yml` 提供默认配置（跟随选择、block、blockAutoSwitch）。

然后可选地写 profile 覆盖（把当前 provider/model、端点、每 profile 审计路径
写进 profile 的 `cordis.patch.yml`）：

```sh
node /path/to/dsh-provider-guard/scripts/install.mjs --apply --bundle
```

或双击 [scripts/install.command](scripts/install.command)。

`--bundle` 只写 profile 覆盖，不复制插件；如果包还没装，会报错并提示先跑
`dsh plugin ... add`。不带 `--bundle` 的 `--apply` 是独立兜底模式：把插件复制到
`$DSH_HOME/plugins` 并用绝对路径加载，适合不想装包的单机测试。

桌面端 `patchReload` 会热加载；`dsh web` / VS Code 面板重启后生效。VS Code 默认
用 `web` profile；如果配了别的 profile，安装器也会扫到。远程 VS Code 要在远程
机器上装。

> 在 `web` profile 上跑 `dsh plugin` 时，pnpm 可能把 VS Code 扩展手工安装的
> `dsh-vscode-bridge` 移到 `node_modules/.ignored`。在 VS Code 里执行一次
> `DSH: Retry bridge` 即可恢复。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `followSelection` | `true` | 跟随 UI 当前供应商 |
| `fallbackProvider` | 安装器写入当前 provider | 读不到 UI 选择时的兜底 |
| `fallbackModel` | 安装器写入当前 model | 改道时用的模型 |
| `onForeignProvider` | `block` | `block`（停住）/ `reroute`（显式改道）/ `audit`（只记录） |
| `blockAutoSwitch` | `true` | 主循环供应商与当前选择不一致时停住 |
| `blockForeignProviderHosts` | `true` | 拦其他供应商的模型端点 |
| `providerHosts` | 内置表 | 自定义供应商端点，如 `{ acme: ["gateway.acme.example"] }` |
| `allowLoopback` | `true` | 放行 localhost / 127/8 / ::1 |
| `allowPrivateNetwork` | `false` | 放行 RFC1918 等内网 |
| `mode` | `enforce` | `enforce` 生效；`audit` 只记录 |
| `auditLog` | `$DSH_HOME/provider-guard/audit.jsonl` | `false` 关闭 |
| `logAllowed` | `false` | 连放行的也记录 |
| `maxRecent` | `200` | 状态工具保留条数 |

内置已知供应商端点（节选）：

- `deepseek-official` / `deepseek` → `api.deepseek.com`
- `opencode-go` / `opencode` → `opencode.ai`
- `openai` → `api.openai.com`
- `anthropic` → `api.anthropic.com`
- `openrouter` → `openrouter.ai`
- `google` → `generativelanguage.googleapis.com` / `aiplatform.googleapis.com`
- `zai` → `api.z.ai` / `open.bigmodel.cn`
- `moonshotai` / `moonshotai-cn` → `api.moonshot.ai` / `api.moonshot.cn`
- `kimi-coding` → `api.kimi.com`
- `minimax` / `minimax-cn` → `api.minimax.io` / `api.minimaxi.com`

自定义网关用 `providerHosts` 补上，否则它的专用端点不认识，只能靠
`llm/stream` 的 provider 门禁兜底。

## 验收

装好后让模型调用：

```text
provider_guard_status
```

应看到：

```text
跟随 UI 选择：是
当前生效：opencode-go / deepseek-v4.1-flash
当前供应商端点：opencode.ai
跨供应商模型调用：reroute（改走当前选择的模型）
```

实测（本机，选 opencode-go 时）：

- `https://example.com` 的 `web_fetch` **成功**（普通流量不受影响）。
- `web_search` 失败于 `api.deepseek.com/v1/tools/search`，错误码
  `PROVIDER_HOST_BLOCKED`，审计里能看到 `dispatchDeepSeekWeb` 栈；没有消耗
  DeepSeek key。
- 用真实 `LlmRuntime` 的辅助调用点名 `deepseek-official`：实际落到
  `opencode-go / deepseek-v4.1-flash`。
- 主循环的深冻结请求点名 `deepseek-official`：被信任放行（你主动选 DeepSeek
  时就是这条路径）。

切到 DeepSeek 后，端点表自动反过来：`api.deepseek.com` 放行，`opencode.ai`
变成"其他供应商"被拦；主循环切到 DeepSeek 的请求仍被信任。切换不需要重启。

## 排障

**网页搜索没了**

预期。选 opencode 时 DeepSeek 搜索被拦；选 DeepSeek 时恢复。需要别的搜索源，
要装对应的 search provider，而不是把 `api.deepseek.com` 加白。

**辅助调用报 `PROVIDER_MISMATCH`**

这是默认的“停住”行为。看审计里的 `fromProvider` 是哪条辅助调用（标题、压缩、
记忆等）；把那个组件配置成当前供应商，或显式把 `onForeignProvider` 设为
`reroute`（会静默换模型，需要你明确接受）。

**自定义供应商的专用端点没被拦**

在配置里加：

```yaml
        providerHosts:
          acme:
            - 'gateway.acme.example'
```

**切供应商后行为没变**

看 `provider_guard_status` 的"UI 当前选择"和"当前生效"。如果 UI 选择已变、
主循环还没跑过，辅助调用可能还按上一次主循环；发一条消息后自动更新。也可以
重跑 `node scripts/install.mjs --apply --bundle`，把 `fallbackProvider/fallbackModel` 改成新选择。

## 卸载

```sh
# 1. 删 profile 覆盖（可选；bundle 还在时仍会用默认配置加载）
node /path/to/dsh-provider-guard/scripts/install.mjs --uninstall --apply

# 2. 移除 bundle
dsh plugin --profile desktop remove dsh-provider-guard
dsh plugin --profile web remove dsh-provider-guard
```

`--uninstall` 只删 profile 的 managed block；bundle 必须用 `dsh plugin remove`
才会真正从 `dsh.profile.bundles` 和 `node_modules` 移除。

## 边界

- **同一时间只允许一家供应商**：主循环门禁和端点检查都以 UI 当前选择为准。
  如果你在多个会话里用了不同供应商，只有最近一次 UI 选择的那家能继续跑；
  另一个会话的请求会停住，要求你先在 UI 切过去。这是"不自动切换"的直接结果。
- **多会话端点检查**：没有会话上下文的 HTTP 端点（网页搜索等）按 UI 当前选择
  判断，不按发起会话判断。
- **子进程 / Electron 主进程**：bash 子进程（curl、MCP、git）、Electron 主进程
  的更新/账户流量不在插件进程内，不覆盖。
- **改道模型能力**：辅助调用会换成当前选中的模型。如果原调用带图片、工具或
  特殊 reasoning effort，目标模型可能拒绝；这是"统一供应商"的代价，错误会
  直接返回。
- **DNS / UDP**：不拦；插件只做模型调用和供应商端点。

## 开发

```sh
node --test test/*.test.mjs
node scripts/smoke-provider.mjs   # 真实 LlmRuntime 的改道/主循环信任
```