# 开发文档

面向维护者：架构、传输层决策、端点契约、客户端实现要点、验证方式与历史缺陷。

- 使用说明看 [README](../README.md)
- 禅道接口实测事实（列表/写接口/附件/字段）看 [禅道 REST API v1 实测笔记](./zentao-api-notes.md)

## 架构

单包同时提供宿主半侧与浏览器半侧，**零第三方运行时依赖**，不发布 npm。

| 半侧 | 入口 | 内容 |
| --- | --- | --- |
| 宿主（Host） | `lib/index.js` | 一条自有 webServer 路由 `POST /zentao-workbench/<endpoint>`（同源校验 + JSON 信封）、一条附件代理 GET 路由、一个面向模型的 `zentao` 工具、禅道 v1 REST 客户端与配置落盘 |
| 浏览器（Client） | `lib/client.js` | 挂在 `shell.overlay` 插槽上的浮层：登录表单、发送目标选择、三个分类标签页、条目详情悬浮卡片（图片缩略图 / 视频播放器 / PDF 预览 / 默认程序打开）、`处理 / 完成 / 指派 / 复制提示词 / AI 分析` 按钮；配色全部走 DSH 的 `--dsw-*` 设计令牌 |

```
dsh-zentao-workbench/
├─ lib/
│  ├─ index.js      # 宿主半侧（Cordis 插件：name / inject / apply）
│  └─ client.js     # 浏览器半侧（window.__ModuleLoader__.load 工厂）
├─ cordis.patch.yml # bundle patch：装进 profile 的层栈
├─ .verify/         # 离线冒烟 + 端到端复核脚本
└─ docs/            # 本目录
```

宿主半侧刻意**不 import 任何 `@deepseek-ai/*` 包**：包的 link 安装不会把被链接 workspace 包的依赖装进目标 profile，一旦 import 官方包就会在 profile 的 `node_modules` 之外解析失败。工具定义因此直接写原始 JSON Schema，HTTP 用全局 `fetch`，其余只用 `node:` 内建模块。

## 传输层：自有 webServer 路由（**不要**用 `ctx.connection.rpc`）

统一信封：成功 `{ ok: true, value }`，失败 `{ ok: false, error: { code, message, details } }`。

请求：`POST http://127.0.0.1:<port>/zentao-workbench/<endpoint>`，`content-type: application/json`，浏览器侧用同源 `fetch`（`credentials: 'same-origin'`）。**应用层错误也走 HTTP 200**，由 `ok` 字段区分。

**为什么不用官方的 `ctx.connection.rpc.handle('/zentao-workbench', …)`**：它在内部以 `const owner = this.ctx` 取「当前上下文」，再执行 `owner.effect(() => owner.webServer.register({…}))`（见 `dsh-client-connection/lib/index.js` 的 `get rpc()` 与 `register()`）；这个 Service ctx tracker（`noShadow: true`）**会跳过 `ctx.inject` 派生的影子上下文**，解析回本插件行自己的 fiber —— 那里没有 `webServer`，于是必然抛：

```
cannot get property "webServer" without inject
```

实测**模块 export 的 `inject` 和 `cordis.patch.yml` 的 row 级 `inject` 都救不了**；结果是 `apply` 抛错 → 插件被跳过 → 浏览器 POST 落到 SPA 兜底处理器，界面只会看到：

```
transport failure for /zentao-workbench/login: HTTP 405
```

因此宿主半侧改为 `ctx.inject(['webServer'], (webCtx) => …)` 拿嵌套上下文后直接 `webCtx.webServer.register({ kind: 'prefix', path: '/zentao-workbench', handler })`（与官方 `@deepseek-ai/dsh-client-modules` 取 `webServer` 的方式一致），并自己做同源校验：带 `Origin` 时必须与 `Host` 一致，带 `Sec-Fetch-Site` 时只接受 `same-origin` / `none`。

`lib/index.js` 的 `export const inject = ['tools']` 里**不含** `connection`；可选服务（`llm`、`agentDefaultModel`、`uiWorkspace`）一律用 `ctx.reflect.get(name)` 或 `ctx.get(name)` 读取，取不到只是降级，不会让插件加载失败。

## 端点总览

| endpoint | payload | 类型 | 说明 |
| --- | --- | --- | --- |
| `getConfig` | `{}` | 读 | `{ server, account, realname, role, hasToken, rememberToken }`（**永不返回 token**） |
| `login` | `{ server, account, password?, token?, rememberToken }` | 读 | 换取并校验登录态，成功后清空缓存 |
| `setRole` | `{ role }` | 读 | 落盘职位字段（**界面已不调用**，提示词不再依赖职位，保留给脚本） |
| `logout` | `{}` | 读 | 清空内存 token 与已保存 token，并清空缓存 |
| `refresh` | `{ scope: 'tasks' \| 'bugs' \| 'stories' \| 'all', force? }` | 读 | `{ fetchedAt, profile, scopes, cached, jobs, taskTotal, tasks, bugs, stories, scan }` |
| `scanProgress` | `{ jobId }` | 读 | 渐进扫描的增量：`{ missing, finished, items, bugs, stories, done, total, error }` |
| `fetchDetail` | `{ kind: 'task'\|'bug'\|'story', id }` | 读 | 单条详情（`sections` / `attachments` / `story` / `meta` / 历史 / `contentFingerprint`） |
| `analyze` | `{ kind, id }` | 读（**会调用模型**） | AI 预判，返回类别 / 置信度 / 一句话 / 依据 / 步骤 / 待确认 + 路由信息 |
| `startTask` | `{ id }` | **写** | 置为「开始」 |
| `finishTask` | `{ id, hours?, comment? }` | **写** | 置为「完成」并登记本次耗时 |
| `assignTask` | `{ id, account }` | **写** | 指派给别人 |
| `listUsers` | `{}` | 读 | 成员表，给「指派」卡片用 |
| `openAttachment` | `{ url, name }` | 读 | 下载到本机临时目录并用默认程序打开 |

另有一条**非 RPC** 的 GET 路由专供附件预览：

| 路由 | 说明 |
| --- | --- |
| `GET /zentao-workbench/attachment?url=<禅道附件地址>` | 用宿主持有的 Token 回源取字节再回吐（`private, max-age=600`、`content-disposition: inline`、支持 `Range`） |

## 端点细节

### `login`

用 `POST api.php/v1/tokens` 换 token，随即 `GET user` 校验；token 与密码二选一。密码永不落盘。

### `refresh`

`scope` 决定取哪些类别：`tasks` 只拉任务（快，登录后自动做一次）；`bugs` / `stories` 只聚合对应类别；`all` 两者都做。

- 返回的 `scopes` 告诉浏览器半侧**这次真的更新了哪些键**，客户端据此合并而不是整体替换（否则按类别刷新会把另一个页签已加载的列表清空，而客户端又认为它已加载、不会重拉）。
- Bug/需求走**渐进扫描**：缓存未命中时立刻返回当前结果 + `jobs:[{kind,id,done,total}]`，客户端按 `jobId` 轮询 `scanProgress` 增量取回。工具调用方传 `wait=true` 走同步路径，拿完整结果。
- `force: true` 绕过缓存（用户点「刷新」）。

### `fetchDetail`

返回：

- `sections`：描述 / 研发需求描述 / 研发需求验收标准 / 步骤 / 重现步骤 分段正文（绝对地址已补全）；
- `attachments`：正文内嵌 `<img>`/`<a>` 与 `files[]` 抽出的附件，每项额外带 `proxyUrl`；
- `story`：`{ id, title, status, statusLabel, link }`；
- `meta`：`[{ label, value }]` 散字段（所属执行 / 类型 / 工时 / 严重程度 / 解决方案…），枚举已中文化；
- `statusLabel` 与历史动作的 `actionLabel`（中文）、最近 10 条历史动作、原始链接；
- `contentFingerprint`：正文与元数据的 sha256，客户端用它判断「AI 预判是不是基于当前正文」。

### `analyze`

先按 `fetchDetail` 取详情，再把「对象类型 / 编号 / 标题 / 字段 / 状态 / 指派给 / 所属研发需求 / 正文 / 附件」拼成一段输入（正文截到 6000 字）交给模型，要求**只回一个 JSON 对象**：

```json
{ "category": "bug|optimize|feature|other", "confidence": 0-100, "headline": "一句话", "reason": "依据", "steps": ["建议步骤"], "questions": ["待确认"] }
```

- **模型路由三级优先级**：`DSH_ZENTAO_WORKBENCH_LLM=provider/model`（显式钉死）＞ `ctx.reflect.get('agentDefaultModel').currentSelection()`（跟随 DSH 界面里选中的默认模型，`routeSource: 'dsh'`）＞ `listProviders()` 自动挑一条便宜路由（`routeSource: 'auto'`，并回带 `routeNote` 说明为什么没跟随）。只有默认模型的 provider 在当前实例没注册时才放弃跟随（那时硬发只会得到 `INVALID_CATALOG`）；`listProviders()` 本身抛错时反而照发默认模型，不武断回退。
- **归一化**：类别白名单外归 `other`；`confidence` 取整并夹到 0-100，非法则 `null`；`headline ≤ 80`、`reason ≤ 300`、`steps ≤ 5 条 × 160`、`questions ≤ 3 条 × 160`。
- **输出上限 `maxTokens = 4000`**：跟随 DSH 默认模型时用的可能是带推理的模型，推理 token 也算在这个额度里 —— 一开始只给 900，实测直接以 `finish: max-tokens` 收尾、连 JSON 都没吐出来。现在除 `aborted` 外都先试着解析：`max-tokens` 但 JSON 已完整就照用（结果带 `truncated: true`），真的截在半截才报 `llm-parse` 并点明是被 `maxTokens=4000` 截断。
- **失败码**：`llm-unavailable`（profile 没有可用路由）、`llm-parse`（模型没按要求回 JSON，报错带原始输出前 300 字）、`llm-aborted`（60s 超时或被取消）、`llm-failed`（上游 `finish` 是 `error` 之类）。**任何一种失败都不会返回半截结论。**

### `startTask`（写）

`POST tasks/{id}/start`。只对 `wait` 状态动手，先 GET 一次拿 `consumed` / `left` 一起提交（不让禅道把工时覆盖成 0），提交后再 GET 回读状态确认。返回 `{ changed, previousStatus, status, statusLabel, note }`：`changed: false` 表示禅道没改状态（已经是进行中、已完成、或权限不足），界面如实提示而不是谎报成功。

### `finishTask`（写）

`POST tasks/{id}/finish`。先 GET 拿 `realStarted` 与已登记 `consumed`，提交：

```json
{ "realStarted": "YYYY-MM-DD", "finishedDate": "YYYY-MM-DD", "currentConsumed": 2, "consumed": 5 }
```

`hours` 留空按 0，非数字或负数直接拒绝；`comment` 非空才带。提交后再 GET 回读，返回 `{ changed, previousStatus, status, statusLabel, consumed, left, finishedDate, note }`。

### `assignTask`（写）

`PUT tasks/{id}`，body **只有** `{ assignedTo }`。先 GET 拿当前指派人，同人直接返回 `changed: false`；提交后用 PUT 返回的完整任务对象当回读结果（为空才补一次 GET）。返回 `{ previousAccount, previousName, account, realname, status, statusLabel, statusChanged, changed, note }`。禅道把「未开始」的任务指派出去时会顺手激活为「进行中」，`statusChanged` 会如实带上。

### `listUsers`

`GET users?limit=100` → `{ users: [{ account, realname }], total, self }`，按真名中文排序、按账号去重。

### `openAttachment`

把附件下载到本机临时目录再交给系统默认程序打开（`docx` / `xlsx` / `pptx` / `pdf` / `zip`… 走这条路）。返回 `{ opened, name, savedPath, size, extension }`。

安全边界：

- 只放行「与已配置禅道同源且路径像附件」的地址；
- **扩展名必须在白名单里**（`OPENABLE_EXTENSIONS`），`.exe` / `.bat` / `.lnk` 这类可执行扩展名在**下载之前**就拒绝，返回 `forbidden`；
- 超过 64 MiB 拒绝；
- 文件名会被清成安全名（去 `\/:*?"<>|` 与控制字符、加时间戳前缀）；
- 保存目录用 `DSH_ZENTAO_WORKBENCH_OPEN_DIR` 覆盖，打开命令用 `DSH_ZENTAO_WORKBENCH_OPENER` 覆盖（Windows 默认 `cmd /c start`，macOS `open`，Linux `xdg-open`）。

### `GET /zentao-workbench/attachment`

用宿主持有的 Token 回源取附件字节再回吐。未登录 401、跨站或异地地址 403、同源但不像附件路径 403、超 64 MiB 413。

另外两件事是为浏览器准备的：

1. 上游给 `application/octet-stream` 时按扩展名改回 `video/mp4` 等正确类型（否则 `<video>` 不播）；
2. 支持 `Range` 请求 —— 上游完全不支持，宿主整份读进内存后就地切片，返回 `206 + content-range + accept-ranges: bytes`，越界回 `416 + content-range: bytes */N`，非法头按整份 200。

## agent 工具 `zentao`

| 参数 | 取值 |
| --- | --- |
| `action` | `mine`（默认，任务 + Bug + 需求快照）/ `tasks`（只要任务）/ `detail` / `analyze`（AI 预判） |
| `kind` | `action=detail` 或 `analyze` 时：`task` / `bug` / `story` |
| `id` | `action=detail` 或 `analyze` 时：条目 ID |

工具复用浮层那一份登录态，所以**必须先登录**；未登录时返回一句明确的提示而不是报错。取数走 `wait=true` 的同步路径，保证拿到的不是半截数据。

## 登录失效（401）与无权限（403）

禅道的 REST Token 会过期。处理原则是**把「登录失效」当成可恢复状态，而不是错误**：

| 上游 | 错误码 | 宿主行为 | 界面行为 |
| --- | --- | --- | --- |
| HTTP 401 | `unauthorized` | 立即清空内存 Token、清空缓存并落盘；文案固定为「禅道登录状态已失效，请重新登录。」（**不把接口路径糊给用户**） | 一行中性提示 + **切回登录表单**（服务器 / 账号已带出，填一次即可继续）；列表与「处理」隐藏，刷新按钮禁用，并停止自动重试与在途轮询 |
| HTTP 403 | `forbidden` | **不清登录态**（Token 可能仍然是好的，只是这次请求没权限，例如某个产品不给看） | 显示为普通错误条 |

`zentao` 工具遇到 401 同样清登录态，并回一句「禅道登录状态已失效，请先在工作台浮层重新登录。」，而不是抛异常。

之前的问题：Token 过期后界面只剩一条红色报错，而 `hasToken` 仍为 true —— **没有重新登录的入口**，用户得先点「退出登录」才能回到登录表单。现在 401 会就地清登录态，`getConfig` 随即回 `hasToken: false`，界面自动切回登录表单。

## 数据流与缓存策略

策略的事实依据（禅道忽略服务端过滤、同一会话请求串行）见 [禅道接口笔记](./zentao-api-notes.md#性能)。

| 层 | 做法 |
| --- | --- |
| 禅道 → 宿主 | 产品列表 5 分钟 TTL 缓存；按类别的「指派给我」聚合结果 2 分钟 TTL 缓存；登录/退出清空全部缓存与扫描任务 |
| 宿主 → 客户端 | `refresh` 只回请求的类别，并用 `scopes` 标注更新范围；Bug/需求未命中缓存时返回 `jobs` 走渐进扫描 |
| 客户端内存 | `loadedScopes` / `loadingScopes`（Set + Map）去重与合并；`requestEpoch` 标记登录态代次，换账号后旧响应与在途轮询不再回写 |
| 客户端持久化 | 成功取数后按 `服务器\|账号` 写 localStorage 快照（带 `v` 版本号），重启/刷新先渲染快照再后台刷新；退出登录删除 |
| 可观测性 | 宿主每次刷新打印 `refresh scope=… ms 请求=… 缓存=命中|未命中 后台扫描=…`，扫描完成另有 `scan kind=… 完成 …` |

**客户端状态下标约定**：`lib/client.js` 里 `useState` 的调用顺序被 `.verify/client-smoke.mjs` 按下标注入预设。新增 state 一律**追加在最后**（当前：下标 14 = `pick`、15 = `analyses`、16 = `progress`），不要插到中间。

## 客户端实现要点

### 「处理」是怎么真的建出会话的

参考实现用的 `workspaces.connectWorkspace()`、`sessions.open()`、快照字段 `recentWorkspaceId` 在 DSH 0.2.0-rc.2 上**都不存在**（`sessions` 只有 `create / retain / using / scope / fork`，`workspaces` 只有 `create / rename / delete / pinSession …`）。本插件按源码核对后的真实链路：

1. **选中工作区**：`sessions.list` 里 `retainedBy.mainView > 0` 的那条会话属于哪个工作区（即左侧当前打开的项目）；没有则退回「会话 `updatedAt` 最大」的工作区。工作区 > 1 时界面给下拉选择器，选中项一路传给 `handlePrompt(text, workspaceId)`，提示词里的「当前工作区」段落同时换成它，避免「发到 A 项目、提示词却写 B 项目」。
2. **建会话**：`uiWorkspace.connectWorkspace(workspaceId)`（复用该目录下的空白会话或新建）。`uiWorkspace` 用 `ctx.get('uiWorkspace')` **可选**获取 —— 不进 `inject`，拿不到也不会让浮层不激活；拿不到时退化为 `sessions.create({ workspaceId })`。
3. **发送**：`sessions.retain(id, { source: 'zentao-workbench' })` → `await reference.ready` → 在会话作用域上取 `conversation` → `conversation.send(text)`。
4. **显示**：有 `uiWorkspace.openSession(id)` 就调用它，随后释放本次引用；**没有则刻意保留引用**，否则会话作用域会被回收，刚发出的任务可能被中断。

`handlePrompt` 收到已不存在的工作区 ID 会明确报错，并在事件层兜底为「复制提示词」，不会静默发到别的项目。

### 提示词组装

由「抬头 + 条目 Markdown（含正文与附件）+ 字段线索 + AI 预判（可选）+ 当前工作区 + 工具指引」拼成：

1. **抬头（`PROMPT_INTRO`）先要求分类**：读完条目先用一行给出 **Bug 修复 / 体验或性能优化 / 新增需求 / 其它**，并附一句依据；证据不足时直接说缺什么、先问，不要硬猜。
2. **第二步才是套路**：Bug → 复现路径 / 根因 / 修复方案与改动点 / 回归范围与自测；优化 → 现状与基线 / 先量后改 / 方案与预期收益 / 回归验证；需求 → 目标与验收标准 / 方案与拆分 / 影响面与风险 / 实施顺序；其它 → 先澄清目标再给最小可行的下一步。
3. **正文与附件真的进提示词**：生成前先调一次 `fetchDetail`，把 `description` 与附件清单写进 `### 描述 / 重现步骤 / 研发需求` 与 `### 附件（N 个）`。**详情读取失败会直接报错并停止发送**，不发缺正文的提示词。
4. **字段线索段**（`categoryClues`）：按标题关键词、`kind`、严重程度 / 优先级 / 状态给一份确定性线索，并写明「只是线索，判断权在你」。
5. **AI 预判（可选）**：只在该预判的 `contentFingerprint` 与当前详情一致时才带进提示词，避免正文变了还用旧结论。

「处理」成功会新建对话并原样发出提示词，失败则自动复制到剪贴板兜底；任务上点「处理」还会顺手把任务置为「开始」（先交付提示词，再写禅道，写失败只影响 toast）。

### 交互安全

- **详情失败阻断**：`fetchDetail` 失败 → 明确提示原因并中止处理/复制。
- **防重入**：`actionLock` 保证连续点击「处理」只建一个会话；同条目的并发「AI 分析」只打一次宿主。
- **AI 预判缓存身份**：键 = 服务器 + 账号 + 类别 + 条目内容；登录变更或刷新让**在途**分析作废（已完成的预判保留，避免每次刷新重花模型调用）。

### 附件与预览的四种打开方式

| 类型 | 交互 |
| --- | --- |
| 图片 | 卡片里出缩略图，点缩略图或「放大」→ 透明点击层里的悬浮卡片（**不铺灰色遮罩**） |
| 视频 | 卡片里 `<video controls preload="metadata">`，**不写 `autoPlay`，必须自己点播放**；放大层复用同一浮层 |
| PDF | 「预览 PDF」→ 工作台内 `iframe`（宿主回 `content-disposition: inline` 才会渲染而不是下载） |
| 其它文档 | 「用默认程序打开」→ 下载到本机再交系统默认程序（扩展名白名单先行） |

关闭方式共四种（再点标题 / 右上「关闭」 / 点空白处 / `Esc`），`Esc` 的关闭顺序是 **预览 → 完成 → 指派 → 详情**。

### 配色与令牌纪律

所有颜色、圆角、阴影、字体都引用 DSH 主题令牌（`--dsw-alias-*` / `--dsw-radius-*` / `--dsw-shadow-*` / `--dsw-font-*`）并带暗色兜底值。

> `--dsw-alias-label-caption` 在浅色主题下是 `#adb2b8`（对白底约 2:1），只适合装饰性文字；正文与次要信息一律用 `--dsw-alias-label-secondary`，正文行用 `--dsw-alias-label-primary`。`client-smoke.mjs` 有一条断言拦住拼错或不存在的 `--dsw-*` 令牌（不存在的令牌只会静默走 fallback，不报错）。

## 本地验证

### 一键跑

```powershell
cd E:\Eworkspace\dsh-zentao-workbench\.verify
node host-smoke.mjs      # 宿主半侧：216/216
node client-smoke.mjs    # 浏览器半侧：300/300
pwsh -File e2e-check.ps1 # 端到端：另起 19399 实例，复核写端点、附件代理与 bundle 内容（跑完自动清理）
```

`node --check lib/index.js` / `node --check lib/client.js` 也应退出码 0。

> `.verify/` 脚本用**占位数据**：真实内网地址、真实单据号、真实附件 id 都不入库。两个冒烟脚本自带 mock 后端，直接跑即可；想在真机上跑 `e2e-check.ps1`，必须先设：
>
> ```powershell
> $env:DZW_ZENTAO_ORIGIN    = 'http://你的禅道:端口'   # 不带结尾斜杠、不带 /zentao，脚本自己拼
> $env:DZW_E2E_CLOSED_TASK  = '10004'                 # 一条已关闭 / 已完成任务：验「终态不再写」守卫
> $env:DZW_E2E_STORY_TASK   = '10002'                 # 一条挂着研发需求的任务：验 storySpec / meta 出得来
> $env:DZW_E2E_MP4          = 'file-read-31001.mp4'   # 真实附件 id：验代理的 Range 切片
> $env:DZW_E2E_PNG          = 'file-read-31002.png'   # 真实 png 附件：验「用默认程序打开」链路
> ```
>
> `DZW_ZENTAO_ORIGIN` 必须与 `~/.dsh-zentao-workbench.json` 里保存的服务器**同源**，否则附件会被宿主按「非当前禅道服务器」拒绝。

### `host-smoke.mjs` 覆盖什么

起一个 mock 禅道后端 + mock `ctx`（忠实复刻「未注入的服务读不到」这条规则，读 `connection` 会直接抛错），覆盖：

- **传输层**：非 POST → 405、跨站 `Origin` → 403、`content-type` 不对 → 415、缺端点名 → 400、坏 JSON → 400、超过 64 KiB → 413、同源放行。
- **登录与配置落盘**：未登录保护、登录成功/失败、HTTP 401 的重新登录提示；配置写到临时文件、不含密码、未勾选「记住 Token」时 token 为空串。
- **列表与排序**：`refresh` 聚合与 `page` 参数、**任务 ID 倒序**、`Token` 头、单个产品失败被跳过而不是整体失败、`taskTotal` 回带。
- **指派过滤**：未指派与「指派给他人」的 Bug/需求都必须被滤掉（含 `assignedTo` 对象形状）。
- **渐进扫描与缓存**：首包只给任务 + `jobs`、`scanProgress` 补齐、缓存命中 0 请求、`force` 绕过缓存、每次聚合只取一次产品列表、登录后缓存作废。
- **详情**：三种响应形态 + 真实实例形态（空字符串 `desc`、正文与附件都在 `bugSteps`、附件是正文内嵌 `<img>`）、HTML→纯文本、中文字段、附件地址补全、`contentFingerprint` 回带。
- **附件代理**：未登录 401、缺 `url` 400、跨站 403、异地地址 403、同源非附件路径 403、超 64 MiB 413、正常回源带 `Token` 头并保持 `image/png` 与 `private` 缓存头；mp4 类型归一化、`Range` 四种形态（`bytes=0-1023` / `bytes=1024-` / 后缀 `bytes=-100` / 越界）。
- **写操作**：`startTask` 只打一次 `start` 且带 `realStarted` 与原 `consumed` / `left`、状态没变必须 `changed: false`；`finishTask` 的必填字段与耗时累加、终态不重复写、负耗时/非数字/缺 id → `bad-request`；`assignTask` body 只带 `assignedTo`、同人不重写、`statusChanged` 如实反映；`listUsers` 去重 + 中文排序 + `self`。
- **研发需求与散字段**：`storySpec` / `storyVerify` 进 `sections`、内嵌截图进 `attachments` 且带 `proxyUrl`、`story` 链接正确（数字 `storyID` 不被吞）、`meta` 逐条中文化。
- **`openAttachment`**：成功时文件真的落盘（冒烟用 `DSH_ZENTAO_WORKBENCH_OPENER=process.execPath` 以免真弹窗）、回源带 `Token`、文件名被清成安全名；`.exe` 返回 `forbidden` 且**根本没有发出下载请求**。
- **`analyze`**：路由选择（含跟随 DSH 默认模型、provider 未注册时回退、环境变量优先、读默认模型抛错不崩）、归一化与截断、各种失败码、失败时不返回半截结论、整链路只打一次 `fetchDetail`。
- 它用 `DSH_ZENTAO_WORKBENCH_CONFIG` 指向临时目录，不会污染真实配置。

### `client-smoke.mjs` 覆盖什么

用 React/DOM 替身按 `useState` 顺序注入初始 state，mock 出真实服务面（`sessions.list/create/retain/scope`、`workspaces.list`，刻意**没有** `sessions.open` 与 `workspaces.connectWorkspace`），覆盖：

- **加载契约与样式**：模块 id、`inject`、slot 注册、样式只注入一次、`--dsw-*` 令牌白名单、固定高度与内滚动。
- **首屏**：未登录表单（不再有职位选择）、已登录有数据的渲染与 ID 倒序、`@真名`。
- **点「处理」**：`uiWorkspace.connectWorkspace` → `retain(source=zentao-workbench)` → `openSession` → `release` → `conversation.send`，提示词含正文、附件、线索、工作区标题与绝对路径；`uiWorkspace` 不可用时降级到 `sessions.create`。
- **交互安全**：详情失败不发残缺提示词、连续点击只发一次、AI 缓存跨账号/跨服务器/内容变化隔离、刷新后旧分析不回写、刷新不清空已完成预判。
- **取数性能**：切页签只取对应类别、「刷新」带 `force`、按 `scopes` 合并、未加载页签显示「…」、底部「更新于 HH:MM:SS」、任务超限提示。
- **渐进扫描**：显示「正在扫描 N/M 个产品」、轮询增量写回、扫完即停、扫描期间保留旧列表。
- **本地快照**：写 localStorage、重启后先用快照渲染再刷新、退出登录删除。
- **详情卡片与预览**：分段正文、图片缩略图走代理、`[附件]` 行不重复、中文状态、`Esc` 关闭顺序、图片/视频/PDF 三种预览与「用默认程序打开」的 payload、CSS 断言（无全屏遮罩、关闭按钮醒目）。
- **写操作卡片**：完成 / 指派卡片的输入回写、非法耗时不发请求、`changed: false` 时如实提示、成员过滤与空态。
- **发送目标可切换**：多工作区时才渲染下拉、选中后会话建在选中工作区、选中项消失后静默回到「跟随当前工作区」。
- 若设置 `DSH_THEME_BUNDLE=<dsh-client-ui-theme 的 client.js 路径>`，会额外把用到的每个令牌拿到真实主题定义里核对一遍。

### 端到端复核（`e2e-check.ps1`）

脚本自己预检 19399 端口、起 web 实例、取日志里的一次性 `?token=` 换 Cookie，然后：

- 用**不存在的 id** 打 `finishTask` / `assignTask`（期望 HTTP 200 + `ok:false` 信封，证明路由与链路在且**零副作用**），再用 `listUsers` 走一次真实只读请求；
- 拿一条**真实已关闭任务**验证「写前守卫」：终态任务返回 `changed:false` + 「无需再完成」、指派给同一个人返回 `changed:false` + 「已经指派给」，两条都不发写请求；
- 从 boot 载荷里取出本插件的 combo bundle 地址核对内容（并断言 bundle 里 `autoPlay` 出现 **0** 次）；
- 用 `curl.exe` 打真实附件代理：整份 → `200 + accept-ranges: bytes`；`Range: bytes=0-1023` → `206 + content-range` 且只回 1024 字节；越界 → `416`。**硬断言只压在代理行为上** —— 同一个附件 id 会随时间换成别的文件，所以「是不是视频」不当断言；
- `openAttachment` 把真实 png 附件下载到临时目录并核对落盘字节数与扩展名，再验证 `.exe` 与缺 `url` 被拒；
- 为避免真的弹出看图软件/播放器，脚本给实例设 `DSH_ZENTAO_WORKBENCH_OPENER=%SystemRoot%\System32\where.exe` 与 `DSH_ZENTAO_WORKBENCH_OPEN_DIR=%TEMP%\dsh-e2e-open`，跑完连同临时目录一起删掉；收尾会 `taskkill /T` 掉整个实例进程树并删除含 token 的日志。

### 改了代码之后怎么确认生效

> **浏览器半侧的 bundle 是从磁盘现取的**，刷新页面就能换新；**宿主半侧只在进程启动时加载一次**，必须重启 DSH。

```powershell
# 宿主是不是新版：新版 fetchDetail 会带 contentFingerprint 字段
Invoke-WebRequest 'http://127.0.0.1:19387/zentao-workbench/fetchDetail' -Method Post -ContentType 'application/json' -Body '{"kind":"task","id":"10001"}' | Select-Object -Expand Content
```

另起一个实例做端到端验证（**不碰真实凭证**）：

```powershell
dsh --profile web --no-open --port 19399
# 从日志取一次性 ?token= 换 Cookie 后：
Invoke-WebRequest "http://127.0.0.1:19399/zentao-workbench/getConfig" -Method Post -ContentType 'application/json' -Body '{}' -WebSession $sess
```

不启动界面也能确认插件已进入组装树：

```powershell
dsh --profile web --dump-config | Select-String -Pattern 'zentao' -Context 1,1
# == dsh-zentao-workbench
# - id: zentao-workbench
#   name: dsh-zentao-workbench
```

> `desktop` profile 由 Electron 应用独占管理，`--dump-config` 会报 `profile "desktop" is managed exclusively by the Electron application`，只能靠完全退出并重启桌面应用生效。

---

## 附录：开发中发现并修掉的 21 个真实缺陷

记录下来，避免以后再踩：

1. **原始链接重复拼接** —— `normalizeServer` 已保留部署路径 `/zentao`，`webLink` 又拼了一次，导致 `…/zentao/zentao/task-view-11.html`。
2. **详情取错键** —— 详情响应是单数键 `{ task: {…} }`，而代码按复数键取，结果标题永远是「（无标题）」。
3. **标签页恒为空** —— 快照字段是复数 `tasks/bugs/stories`，标签页用单数 `task/bug/story` 取。
4. **错误提示对不上真实实例** —— 禅道返回 `{"error":"…"}`（缺 Token 时是 401 `{"error":"Unauthorized"}`），而代码只认 `{status:'fail', message}`，所有失败都退化成 `HTTP 400`。现由 `describeFailure()` 统一映射，401/403 明确提示「登录状态已失效，请重新登录」。
5. **RPC 通道整个不可用（界面报 HTTP 405）** —— 见上文「传输层」。
6. **照抄参考实现的三个 API 在本机并不存在** —— `workspaces.connectWorkspace()`、`sessions.open()`、`recentWorkspaceId` 都没有，照抄的结果是点「处理」直接 `TypeError`、按钮毫无反应。
7. **列表从不排序** —— 宿主与界面都按禅道返回顺序渲染，最新的条目反而在最下面。现在两侧都按 ID 倒序。
8. **空字符串 `desc` 把复现步骤吞掉** —— 正文原来写 `item.desc ?? item.bugSteps`，而禅道对没有描述的任务返回**空字符串**（不是 `null`），`??` 选中空串，`bugSteps` 里的重现步骤与截图永远不显示。现按字段逐个收集非空正文。
9. **附件被当成垃圾标签删掉** —— `htmlToText` 里有一句 `.replace(/<img[^>]*>/gi, '')`，而禅道的**附件就是正文里的 `<img src="…/file-read-*.png">`**（本实例 `files` 恒为空数组），于是步骤里的截图永远看不见。现在保留并补成绝对路径、抽进 `attachments`。
10. **浅色主题下详情正文几乎不可见** —— 小字原来用 `--dsw-alias-label-caption`（浅色下 `#adb2b8`，对白底约 2:1）。现改为 `label-secondary` / `label-primary`。顺带发现遮罩写的 `var(--dsw-alias-bg-mask)` **这个令牌并不存在**（真实令牌是 `-1/2/3`），一直静默走 fallback —— 拼错的令牌不报错，所以冒烟里加了令牌白名单断言。（后来按需求去掉了全屏遮罩，改成浮在面板左侧的悬浮卡片。）
11. **附件直链在浏览器里永远是坏图** —— 禅道 `file-read-*` 不带 `Token` 头时返回登录页 HTML。现在由宿主代取。
12. **枚举值直接显示英文** —— `wait` / `doing` / `opened` / `commented` 照搬英文。现在宿主统一映射成 `statusLabel` / `actionLabel`，表里没有的值原样返回。
13. **面板高度跟着内容变** —— 原来只写 `max-height`，切到空分类立刻缩成一小条。现在面板与详情卡片共用 `--dzw-frame-height: min(76vh, 720px)`，列表改成内滚动区。
14. **禅道的写接口成功与否看不出来** —— `POST tasks/{id}/start` 恒返回 200 + 空响应体（用不存在的 id 做过零副作用取证：`finish` 缺参数是 400、`assignTo` 是 404，而 `start` 连畸形 JSON 都照样 200），只看状态码必然谎报成功。现在写前 GET 带上 `consumed` / `left`，写后再 GET 回读状态。
15. **「指派」的路由和「完成」的必填字段，猜错就白写** —— `POST tasks/{id}/assign`、`/assignTo`、`/team` 全是 404，唯一有效的是 `PUT tasks/{id}`；`finish` 缺 `realStarted` / `finishedDate` 是 400。另外一个隐蔽的坑：`GET tasks/{id}` 里 `assignedTo` 是**对象**，用只认字符串的取值函数读会得到空串，让「只看指派给我的」过滤永远成立（等于没过滤）。
16. **视频附件「有地址却播不了」** —— 上游是 `application/octet-stream` 且忽略 `Range`。现在宿主按扩展名修正类型，并自己切片回 `206`。
17. **「有研发需求描述，弹窗里却是空的」** —— `storySpec` / `storyVerify` 没进正文白名单；而且 `storyID` 是**数字**，只认字符串的取值函数会得到空串。现在两者都修好，散字段经 `DETAIL_META_FIELDS` + `detailMeta()` 逐条显示并中文化。
18. **PDF 预览变成「下载」** —— 代理没回 `content-disposition`。现在对 200 与 206 都显式回 `inline`；顺带把「用默认程序打开」做成**先查扩展名白名单再下载**。
19. **提示词「看起来不对劲」：正文取不到、话术锁死成开发一套、附件压根没进提示词** —— ① 提示词里的 `if (item.description)` 永远不成立（列表行没有正文字段）；② 取消职位下拉后 `FIXED_ROLE = 'dev'` 把所有条目都按「开发」讲；③ 附件从未进过提示词。现在先调 `fetchDetail` 再拼正文与附件清单，抬头改成「先判类别、再按套路」，删掉职位预设与写死的文档名，另加确定性字段线索与可选的 AI 预判段。
20. **「AI 分析」用的不是 DSH 自己的默认模型** —— 旧实现是「`listProviders()` 第一个 provider + 名字带 `flash` 的模型」，与界面右上角显示的模型可以毫无关系。现在三级优先级：环境变量 ＞ DSH 默认模型 ＞ 自动挑便宜路由（并说明原委）。同一轮还暴露出 900 tokens 不够，于是额度提到 4000 并改成「先解析、能解析就用」。
21. **需求页混进大量「不是指派给我」的条目** —— 过滤写成 `if (item.assignedTo !== '' && item.assignedTo !== profile.account) continue;`，把「未指派」当成「指派给我」放行。实测某产品 63 条需求只有 3 条指派给本人，其余 60 条 `assignedTo` 为空（详情里也是空），于是全堆进需求页。现在改成严格相等，并固定了「未指派 / 他人名下」的回归样例。
