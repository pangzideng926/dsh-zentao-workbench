# dsh-zentao-workbench · 禅道工作台（DSH 插件）

把**你自己的禅道实例**接进 DeepSeek Harness（DSH）的 Web 界面：右下角一个浮层工作台，登录后列出**指派给我**的任务 / Bug / 需求，点一条就能**新建对话并自动发送处理提示词**（提示词先要求模型判断这是 Bug 修复 / 体验或性能优化 / 新增需求 / 其它，再按对应套路干活）。

- **详情是悬浮卡片**：点条目标题在工作台左侧浮出卡片（描述 / 研发需求 / 步骤 / 历史，状态与动作**显示中文**），不铺全屏灰色遮罩，页面不压暗。
- **先分个类再干活**：每条旁边有「AI 分析」按钮，**跟随 DSH 自己的默认模型**（`agentDefaultModel.currentSelection()`）先判这是 Bug / 优化 / 还是需求（带置信度、一句话、依据和建议步骤），结论会随提示词一起发出去；不点也行，提示词里照样带确定性的字段线索、正文与附件清单。
- **附件按类型分流**：图片点开放大、视频**点了才播**、PDF 在工作台内预览、ppt/word/excel 交给**电脑上的默认程序**打开。
- **任务可以直接写回禅道**：置为「开始」、完成并登记耗时、指派给别人 —— 三个动作全部**写后回读确认**，改不动就如实提示，不谎报成功。
- **模型也能读禅道**：另外注册一个 agent 可调用的 `zentao` 工具，让模型自己拉取和阅读禅道条目。
- **本地自用**：单包同时提供宿主半侧与浏览器半侧，零第三方运行时依赖，不发布 npm。

本插件是照着 [`@haoyu-qi/dsh-zentao`](https://github.com/haoyu-qi/dsh-zentao) 的思路重写的本地版本。

> **文档里的示例数据**：单据号（`#10001`、需求 `#2001`、来源 Bug `#3001`）、附件名（`file-read-31001.mp4` 等）、执行名（`示例执行`）都是**示例占位符**；出现的字节数（如 2,046,090 / 148,982）是某次真实实测值，仅作量级参考。仓库里不含真实内网地址、账号或 Token。

## 目录

| 章节 | 内容 |
| --- | --- |
| [它做了什么](#sec-what) | 两个半侧的分工 |
| [安装](#sec-install) | 本地 link 安装、profile 注意事项、移除 |
| [配置](#sec-config) | 配置文件与凭证纪律 |
| [界面细节](#sec-ui) | 排序、详情卡片、附件四种打开方式、提示词、工作区、配色 |
| [技术实现](#sec-impl) | 传输层与端点、`zentao` 工具 |
| [本地验证](#sec-verify) | 离线冒烟、端到端复核、改完代码怎么确认生效 |
| [关于禅道 REST API v1](#sec-api) | 实测过的接口事实与坑 |
| [已知限制](#sec-limits) | 边界与风险 |
| [附录 A](#sec-defects) | 开发中发现并修掉的 20 个真实缺陷 |
| [附录 B](#sec-probe) | 研发需求字段的只读实测（2026-10） |

---

## 它做了什么 <a id="sec-what"></a>

| 半侧 | 入口 | 内容 |
| --- | --- | --- |
| 宿主（Host） | `lib/index.js` | 一条自有 webServer 路由 `POST /zentao-workbench/<endpoint>`（同源校验 + JSON 信封）；一个面向模型的 `zentao` 工具；禅道 v1 REST 客户端与配置落盘 |
| 浏览器（Client） | `lib/client.js` | 挂在 `shell.overlay` 插槽上的浮层：登录表单、发送目标选择（工作区可切换）、三个分类标签页、条目详情悬浮卡片（含附件区：图片缩略图 / 视频播放器 / PDF 预览 / 默认程序打开）、`处理 / 完成 / 指派 / 复制提示词 / AI 分析` 按钮；配色全部走 DSH 的 `--dsw-*` 设计令牌 |

浮层在界面上长这样：标题栏是账号 + 「刷新 / 收起」，下面一行是**发送目标**，再下面三个分类标签（任务 / Bug / 需求），每个条目带状态、指派人与截止日期，底部是禅道地址 + 「退出登录」。

---

## 安装 <a id="sec-install"></a>

### 本地 link 安装

```powershell
# 1) 把插件加进你的 web profile（会写进 profile 的 package.json 与 dsh.profile.bundles）
dsh plugin --profile web add "E:\Eworkspace\dsh-zentao-workbench"

# 2) 重启 DSH Web（或让 profile 的 patchReload: live 生效），刷新页面
```

> `dsh plugin` 会对 profile 执行一次 pnpm install。因为「包管理器的 link 不会把被链接 workspace 包的依赖安装到目标 profile」，本插件的宿主半侧**刻意不 import 任何 `@deepseek-ai/*` 包**：工具定义直接写原始 JSON Schema，HTTP 用全局 `fetch`，其余只用 `node:` 内建模块。这样即使被 link 也不会有依赖解析问题。

安装后 `node_modules\<包名>` 是指向本目录的符号链接，且 `dsh.profile.bundles` 末尾会多出 `dsh-zentao-workbench`。

### 注意运行的是哪个 profile

DSH 桌面版默认跑的是 `desktop` profile（可用环境变量 `DSH_PROFILE` / `DSH_PROFILE_DIR` 确认，`DSH_WEB_URL` 是界面地址）。如果你要装的正是它，把上面的 `--profile web` 换成 `--profile desktop`。

`desktop` profile 由 Electron 应用独占管理，`dsh --profile desktop --dump-config` 会直接报 `profile "desktop" is managed exclusively by the Electron application`，只能靠**完全退出并重启桌面应用**生效（刷新页面不够：宿主半侧只在进程启动时加载一次，浏览器半侧的 bundle 则是每次从磁盘现取）。

### 移除

```powershell
dsh plugin --profile web remove dsh-zentao-workbench
```

---

## 配置 <a id="sec-config"></a>

配置文件在 `~/.dsh-zentao-workbench.json`（即 `C:\Users\<你>\.dsh-zentao-workbench.json`），权限 `0600`。可用环境变量 `DSH_ZENTAO_WORKBENCH_CONFIG` 覆盖该路径（离线测试用）：

```json
{
  "server": "http://www.example.com:11180/zentao",
  "account": "your-account",
  "role": "dev",
  "rememberToken": false,
  "token": ""
}
```

- **密码永不落盘**；token 只在勾选「记住 Token」时写入，否则仅存于宿主进程内存，重启后需重新登录。
- 未勾选「记住 Token」时，`token` 字段恒为空串。
- 登录时填的服务器地址会保留部署路径（`…/zentao`），只自动剥掉 `/api.php/v1` 后缀与结尾斜杠。

---

## 界面细节 <a id="sec-ui"></a>

### 列表与排序

- 任务 / Bug / 需求一律按 **ID 倒序**（新的在前）：宿主侧在 `refresh` 返回值里排好，界面侧渲染前再排一次，保证任何来源都是同一口径。
- **面板高度固定，不会跟着内容缩水**：`.dzw-root` 定义 `--dzw-frame-height: min(76vh, 720px)`，`.dzw-panel` 用它当高度（底部始终贴 `bottom: 78px`），条目列表 `.dzw-list` 是 `flex: 1` + `overflow-y: auto` 的内滚动区 —— 大约能同时看到 5 条任务，剩下的滚动查看；切到 Bug(0) / 需求(0) 这种空分类时列表换成空状态，**面板高度不变**（以前是 `max-height`，内容少就缩成一小条）。
- 分类标签页用 `flex: 1 0 auto` + `white-space: nowrap`，**不会再被压扁**（窗口窄时换行而不是缩小）。

### 详情悬浮卡片

- **点条目标题看详情是悬浮卡片**（不再在条目下面内联展开，也不再铺全屏灰色遮罩）：卡片浮在工作台面板左侧（`right: 430px; bottom: 78px`，宽 ≤ 520px；窄屏 `max-width: 900px` 时改为浮在面板上方），页面不压暗、不挡其它点击。
- **卡片高度与工作台面板完全一致**（同一个 `--dzw-frame-height`，两个底边对齐，正文区自己滚动）。
- 卡片里分段显示描述 / 研发需求描述 / 研发需求验收标准 / 步骤 / 重现步骤，附件单独列成可点链接，最后是最近 10 条历史动作与「在禅道中打开」。
- 关卡片有三种：再点一次该条目标题、点右上「关闭」、按 `Esc`。
- 详情正文按字段逐个收集（`DETAIL_BODY_FIELDS`），每个字段一段并带中文标签；**空字符串会当成没有内容**。

### 附件：四种打开方式

附件有两个来源：正文里内嵌的 `<img src="…/file-read-*.png">`（会被保留成 `[附件] <绝对地址>` 并抽进 `attachments`），以及详情响应的 `files[]`（本实例是 `{ id, title, extension, webPath, … }`，下载地址按 `file-read-{id}.{extension}` 拼，界面显示 `title`）。正文里的 `[附件]` 行在卡片里不再重复显示（附件区已经列出）。

所有附件地址都走宿主代理（`/zentao-workbench/attachment?url=…`），因为**禅道直链在没有 `Token` 头时只返回登录页 HTML**，浏览器里 `<img src="禅道地址">` 只会是坏图。

| 附件类型 | 交互 |
| --- | --- |
| 图片 | 卡片里直接出缩略图（`<img class="dzw-thumb">`），点缩略图或旁边「放大」→ **不铺全屏灰色遮罩**的放大层 |
| 视频（mp4 / webm / mov） | 卡片里直接出 `<video>`（`controls`、`preload="metadata"`、`playsInline`，高度上限 190px），旁边有「放大播放」；**不写 `autoPlay`，必须自己点播放键** |
| PDF | 旁边是「预览 PDF」→ 工作台内的 `iframe` 预览 |
| ppt / word / excel / zip 等 | 旁边是「用默认程序打开」→ 下载到本机再交给系统默认程序 |

**图片放大层**：最外层 `.dzw-preview` 只是一张铺满视口的**透明点击层**（`z-index: 70`，压在详情卡片 `z-index: 60` 之上，`background: transparent`，不用遮罩色），页面不压暗；真正显示图片的是里面那张悬浮卡片 `.dzw-preview-card`（边框 + 阴影 + 圆角，`background: --dsw-alias-bg-layer-2`），大图按 `calc(100vh - 150px)` 缩放、`object-fit: contain` 不变形。卡片上方一排是文件名 + 「新窗口打开」。

**关闭入口一眼能看见**：左上/右上固定一颗 `✕ 关闭` 实心按钮（`.dzw-preview-close-float`：`position: fixed; top/right: 16px; z-index: 71`，深色半透明底 + `backdrop-filter: blur(6px)`，压在图片上也看得清，图片再大也不会把它挤跑），卡片底部再给一颗主题色实心按钮（`.dzw-preview-close-solid`）。加上点空白处和 `Esc`，关法共四种；**`Esc` 先关预览、再按一次才关详情卡片**。预览层在最外层，所以面板收起后大图照样能看。

**视频放大层**复用同一个浮层（`preview.kind === 'video'` → `<video class="dzw-preview-video">`，带 `controls` + `preload="metadata"`，**不写 `autoPlay`**），关法与图片完全一致；播放器走宿主代理 + `Range` 切片，所以进度条能拖、不用等整段下载完。

**PDF 预览**：`preview.kind === 'pdf'` → 浮层里放 `iframe.dzw-preview-pdf`（`width: min(92vw, 1100px)`、`height: calc(100vh - 190px)`），地址同样是宿主代理（宿主回 `application/pdf` + `content-disposition: inline`，否则浏览器会把它当下载、iframe 里一片空白）。用的是浏览器自带 PDF 阅读器，不依赖任何外部服务。

**ppt / word / excel / zip 用电脑上的默认程序打开**：点「用默认程序打开」→ 宿主 `openAttachment` 用自己持有的 Token 把原件下载到临时目录（`%TEMP%\dsh-zentao-workbench\`，可用 `DSH_ZENTAO_WORKBENCH_OPEN_DIR` 改），再交给系统打开（Windows `cmd /c start`，可用 `DSH_ZENTAO_WORKBENCH_OPENER` 改）。下载到本机再交系统执行等于让文件「可被执行」，因此扩展名走**白名单**（文档/表格/演示/PDF/压缩包/图片/音视频），`.exe` / `.bat` / `.lnk` 之类在**下载之前**就被拒绝（返回 `forbidden`，界面提示「出于安全考虑…」）；成功后 toast 显示「已交给系统默认程序打开：<文件名>」。

### 中文字段与真名

- **枚举字段显示中文**：状态走 `STATUS_LABEL`（`wait → 未开始`、`doing → 进行中`、`active → 激活` …），历史动作走 `ACTION_LABEL`（`opened → 创建`、`commented → 备注` …）。宿主在 `normalizeItem` / `normalizeDetail` 里就给出 `statusLabel` / `actionLabel`，界面与提示词都优先用中文；表里没有的值原样返回，不会丢信息。
- **指派人与创建人显示真名**：禅道的 `GET tasks/{id}` 里 `assignedTo` 是**对象**（`{ id, account, avatar, realname }`，旁边另有 `assignedToRealName`）。宿主把它解成 `assignedTo`（账号，用于「只看指派给我的」这类比较）+ `assignedToName`（真名，用于显示），`openedBy` / `openedByName` 同理；列表、详情卡片与提示词都优先显示真名。
- **「任务描述」在禅道接口里就是 `desc`**。实测：某次列表里 13 条任务只有 1 条 `desc` 非空，而且那条是 6 个空格的空白串 —— 内容基本都在 `bugSteps`（禅道页面上的「重现步骤」）里，描述栏在禅道页面上本身就显示「暂无」。所以详情卡片里出现「重现步骤」而没有「描述」，是数据如此，不是没取到。**任务真正的说明往往写在所属研发需求里**（`storySpec`）。
- **任务的研发需求会一并带出来**：`GET tasks/{id}` 在任务挂在需求上时返回 `storyID` / `storyTitle` / `storyStatus` / `storySpec`（需求正文）/ `storyVerify`。`storySpec` / `storyVerify` 进 `sections`（标签「研发需求描述」「研发需求验收标准」，需求正文里的内嵌截图同样被抽进附件并走宿主代理），`story` 给出 `{ id, title, status, statusLabel, link }`，卡片里显示成一行可点的「研发需求：#2001 示例需求（激活）」，直接跳禅道的需求页。
- **正文以外的散字段进 `meta` 逐条显示**（避免「详情里有、弹窗里没有」）：按 `DETAIL_META_FIELDS` 取任务（所属执行 / 模块 / 类型 / 优先级 / 预计·已耗·剩余工时 / 计划开始 / 实际开始 / 实际完成 / 关闭原因 / 延期）、Bug（所属产品 / 模块 / 类型 / 严重程度 / 关键词 / 影响版本 / 解决方案 / 解决者 / 转入任务）、需求（所属产品 / 模块 / 分类 / 阶段 / 预计工时 / 评审人）。枚举值中文化走 `TYPE_LABEL`（`devel → 开发`）/ `SEVERITY_LABEL`（`3 → 3 轻微`）/ `RESOLUTION_LABEL`（`fixed → 已修复`）/ `STAGE_LABEL`，表里没有的值原样显示，不丢信息。字段名是 2026-10 用真实 Token 对 `GET tasks/{id}` / `bugs/{id}` / `stories/{id}` 逐个核对过的。

### 提示词：先判类别 → 再按类别走套路

界面上**不再有职位选择**，提示词也不再固定成「开发视角」的一套话术 —— 一条 Bug、一条优化和一条新需求，该套的是三套不同的干活方式（这是用户 m04648 的改造：「提示词似乎不对劲 如何优化？原来存在职位 根据职位的。现在没有职位？」）。每条提示词由「抬头 + 条目 Markdown（含正文与附件）+ 字段线索 + AI 预判（可选）+ 当前工作区 + 工具指引」拼成：

1. **抬头（`PROMPT_INTRO`）先要求分类**：读完条目先用一行给出 **Bug 修复 / 体验或性能优化 / 新增需求 / 其它**，并附一句依据；证据不足时直接说缺什么、先问，不要硬猜。
2. **第二步才是套路**：Bug 修复 → 复现路径 / 根因 / 修复方案与改动点 / 回归范围与自测；体验或性能优化 → 现状与基线 / 先量后改的瓶颈定位 / 优化方案与预期收益 / 回归验证；新增需求 → 目标与验收标准 / 方案与拆分 / 影响面与风险 / 实施顺序；其它 → 先澄清目标再给最小可行的下一步。
3. **硬要求**：涉及代码先在工作区里找到相关文件再下结论、结论先行、需要拍板的点集中放最后。
4. **正文与附件真的进提示词了**（旧版本这里是空的）：生成提示词前会先调一次 `fetchDetail`，把 `description`（宿主由 `sections` 合成的纯文本，`lib/index.js:593`）与附件清单写进 `### 描述 / 重现步骤 / 研发需求` 和 `### 附件（N 个）`。旧版只拿得到列表行，而列表行（`normalizeItem`）**根本没有正文字段** —— 所以「提示词里看不到描述」不是没接上，是当时确实取不到。
5. **字段线索段**（`categoryClues`，确定性判断）：按标题关键词（报错/失败/崩溃… → 更像 Bug；慢/卡/体验… → 更像优化；新增/支持/需求… → 更像需求）、`kind`（Bug 页默认猜 Bug、需求页默认猜需求）、严重程度 / 优先级 / 当前状态给一份线索，并写明「只是线索，判断权在你」，不锁死模型结论。
6. **AI 预判（可选）**：点过「AI 分析」的条目，会把这套结论追加成 `## AI 预判（工作台按当前模型给出，仅供参考，请自行复核）`（类别 + 置信度 + 一句话 + 依据 + 步骤 + 待确认）。

> 旧的 `ROLES` 四套职位预设与 `FIXED_ROLE = 'dev'` 已删除；`setRole` 端点保留给脚本，界面不再调用。旧版 dev 文案里写死的「按项目《禅道接口.md》的收尾闭环流程」也一并去掉了（换个工作区就指向不存在的文件）。

「处理」成功时会新建一个对话并把提示词原样发出；失败时自动把提示词复制到剪贴板兜底。

**任务上点「处理」时还会顺手把这条任务在禅道里置为「开始」**（`startTask`）：先把提示词交付出去，再写禅道，写失败只影响提示 toast，不影响会话与提示词；Bug / 需求不会动手。等待中的任务，按钮 hover 会提示「新建会话并自动发送提示词；任务会同时置为「开始」」。

工作区段落会写明项目名与**绝对路径**，并要求模型不要切换到别的目录：

```
## 当前工作区
- 名称：dsh-zentao-workbench
- 路径：E:\Eworkspace\dsh-zentao-workbench
- 要求：本次分析与改动都在这个工作区内完成，不要切换到其它工作区或目录。
```

### 「AI 分析」按钮：先判这是 Bug / 优化 / 还是需求

列表每条右侧除「处理 / 复制提示词 / 原始链接」外还有一个 **AI 分析** 按钮（分析过之后变成**重新分析**）：

- 点它调宿主 `analyze` 端点：宿主用 `ctx.reflect.get('llm')` 拿到当前 profile 的模型服务（**不需要写 `inject`**，取不到也不会让插件加载失败），把条目详情（含正文，最多 6000 字）交给模型，要求**只回一个 JSON**（`category` / `confidence` / `headline` / `reason` / `steps` / `questions`）；宿主再做白名单与长度归一化：类别白名单外归 `other`、置信度取整 0-100、`headline ≤ 80`、`reason ≤ 300`、`steps ≤ 5 条 × 160`、`questions ≤ 3 条 × 160`。
- 结果显示在条目下方（虚线框 `.dzw-analysis`：类别标签 + 置信度 + 用的模型（并标出是「DSH 默认模型 / 环境变量指定 / 自动挑选」）+ 一句话 + 依据 + 建议步骤 + 待确认；回退或说明会以 `.dzw-analysis-note` 多一行），缓存在组件 state 里 —— 之后点「处理」/「复制提示词」会自动把这段一起发出去（含「由 X/Y（DSH 默认模型）在 <时间> 给出」这一行）。
- 模型路由：**默认跟随 DSH 自己的默认模型** —— 用 `ctx.reflect.get('agentDefaultModel')` 读 `@deepseek-ai/dsh-agent-default-model` 的 `currentSelection()`（就是 DSH 界面里选中的那个 provider / model，**同样不需要写 `inject`**）。只有这个默认模型对应的 provider 在当前实例里没注册时，才会退化成自动挑一条便宜路由（`llm.listProviders()` 的第一个 provider，优先名字带 `flash / mini / small / lite / fast` 的模型），并在结果里带一句 `routeNote` 说明原委。想完全钉死组合可以设 `DSH_ZENTAO_WORKBENCH_LLM=provider/model`（宿主半侧环境变量，改完要重启 DSH），它的优先级最高。
- 输出上限 `maxTokens = 4000`：跟随 DSH 默认模型后用的可能是带推理的模型（`deepseek-flash` 就是），**推理 token 也算在这个额度里** —— 一开始只给 900，实测直接以 `finish: max-tokens` 收尾、连 JSON 都没吐出来。现在除了 `aborted`，其余结束原因都先试着解析：`max-tokens` 但 JSON 已完整就照用（结果里带 `truncated: true`，界面在模型名后加「输出可能被截断」），真的截在半截才报 `llm-parse` 并说明是被 `maxTokens=4000` 截断的。
- 失败不写脏数据：模型没按 JSON 回（`llm-parse`）、超时 60s（`llm-aborted`）、上游报错（`llm-failed`）、profile 里没有可用路由（`llm-unavailable`），都只在面板错误条给出原因（错误文案里带 `provider/model`，方便看出是哪条路由出的问题），不会把半截结果塞进提示词。

### 「完成」与「指派」

任务条目上除「处理 / 复制提示词 / 原始链接」外还有两个写操作按钮，**只有任务有（Bug 与需求不显示）**：

- **完成**：弹出悬浮卡片填「本次耗时（小时）」与可选备注，提交后任务变「已完成」，备注写进禅道历史。耗时是**本次新增**，宿主会按「已登记 + 本次」提交并显示累计值；留空按 0，非数字或负数在界面就被拦住（不发请求）。已经「已完成 / 已关闭」的任务，按钮直接禁用并在 hover 里说明原因。
- **指派**：弹出悬浮卡片选人，成员表来自 `GET users?limit=100`（可按真名或账号搜索，拉取失败可点「刷新成员」重试），点一行即提交，**只发 `{ assignedTo }` 一个字段**，不会覆盖禅道其它字段。**副作用**：禅道在把「未开始」的任务指派给别人时会把状态激活为「进行中」，卡片里有提示，成功后的 toast 也会写明「任务状态变为「进行中」」。

两个卡片都是普通悬浮卡片（不是全屏遮罩），面板收起时也能弹出来；`Esc` 的关闭顺序是 **预览 → 完成 → 指派 → 详情**。

### 「处理」是怎么真的建出会话的

参考实现用的 `workspaces.connectWorkspace()`、`sessions.open()`、快照里的 `recentWorkspaceId` 在本机 DSH 0.2.0-rc.2 上**都不存在**（`sessions` 只有 `create / retain / using / scope / fork`，`workspaces` 只有 `create / rename / delete / pinSession …`）。本插件按源码核对后的真实链路实现：

1. **选中工作区**：`sessions.list` 里 `retainedBy.mainView > 0` 的那条会话属于哪个工作区（即左侧当前打开的项目）；没有则退回「会话 `updatedAt` 最大」的工作区。
2. **建会话**：`uiWorkspace.connectWorkspace(workspaceId)`（复用该目录下的空白会话或新建）。`uiWorkspace` 通过 `ctx.get('uiWorkspace')` **可选**获取 —— 它不进 `inject`，拿不到也不会让整个浮层不激活；拿不到时退化为 `sessions.create({ workspaceId })`。
3. **发送**：`sessions.retain(id, { source: 'zentao-workbench' })` → `await reference.ready` → 在会话作用域上取 `conversation` → `conversation.send(text)`。
4. **显示**：有 `uiWorkspace.openSession(id)` 就调用它（会把会话 retain 到 mainView 并选中），随后释放本次引用；**没有则刻意保留引用**，否则会话作用域会被回收，刚发出的任务可能被中断。

浮层顶部的「发送目标」一行就来自第 1 步，会显示成 `发送目标：项目名（E:\path\to\project）`，找不到工作区时提示先打开一个项目。

**工作区不只有一个时，这一行右侧会出现下拉选择器**（`.dzw-select`，只在工作区数量 > 1 时渲染，免得单项目时占版面）；只有 1 个工作区时文案写成 `发送目标：项目名（路径）（当前只有 1 个工作区）`，等你加了第二个工作区、刷新页面，下拉就自动出现：

- 第一项是 `跟随当前工作区（项目名（路径））`，也就是默认行为 —— 跟着主面板正在看的会话所属工作区走；
- 其余每项是一个工作区，文案同上（`标题（绝对路径）`）；选中后目标行显示 `发送目标：另一个项目（E:\Eworkspace\other）`，不再带「（跟随当前工作区）」；
- 点「处理」时会把选中的 `workspaceId` 一路传给 `handlePrompt(text, workspaceId)`：`uiWorkspace.connectWorkspace(选中的 ID)`（拿不到 `uiWorkspace` 时退化为 `sessions.create({ workspaceId })`），因此新会话建在**选中的工作区**下；连提示词里的「## 当前工作区」段落也换成所选工作区的标题与路径，不会出现「发到 A 项目、提示词却说是 B 项目」；
- 选中的工作区被移除/改名时，订阅回调会把选择**静默重置**回「跟随当前工作区」，不让发送目标悬空；万一在重置前就点了「处理」，`handlePrompt` 会明确报「选中的工作区已不在了…」，并在事件层兜底为「复制提示词」而**不会**静默发到别的项目里。

### 配色与令牌

界面所有颜色、圆角、阴影、字体都引用 DSH 主题令牌（`--dsw-alias-*`、`--dsw-radius-*`、`--dsw-shadow-*`、`--dsw-font-*`）并带暗色兜底值，因此浅色/暗色主题都会跟着 DSH 一起变，不再用禅道红做主色。

> **令牌的可读性**：`--dsw-alias-label-caption` 在浅色主题下是 `#adb2b8`（对白底只有约 2:1），只适合装饰性文字。正文与次要信息一律用 `--dsw-alias-label-secondary`（浅色 `#61666b` / 暗色 `#cfd3d6`），正文行用 `--dsw-alias-label-primary`。`client-smoke.mjs` 里有一条断言会拦住拼错或不存在的 `--dsw-*` 令牌名（不存在的令牌只会静默走 fallback）。

---

## 技术实现 <a id="sec-impl"></a>

### 传输层：自有 webServer 路由（**不要**用 `ctx.connection.rpc`）

统一信封：成功 `{ ok: true, value }`，失败 `{ ok: false, error: { code, message, details } }`。

请求：`POST http://127.0.0.1:<port>/zentao-workbench/<endpoint>`，`content-type: application/json`，浏览器侧用同源 `fetch`（`credentials: 'same-origin'`）。

**为什么不用官方的 `ctx.connection.rpc.handle('/zentao-workbench', …)`**：它在内部以 `const owner = this.ctx` 取「当前上下文」，再执行 `owner.effect(() => owner.webServer.register({…}))`（见 `dsh-client-connection/lib/index.js` 的 `get rpc()` 与 `register()`）；这个 Service ctx tracker（`noShadow: true`）**会跳过 `ctx.inject` 派生的影子上下文**，解析回本插件行自己的 fiber —— 那里没有 `webServer`，于是必然抛 `cannot get property "webServer" without inject`。实测**模块 export 的 `inject` 和 `cordis.patch.yml` 的 row 级 `inject` 都救不了**；结果是 apply 抛错 → 插件被跳过 → 浏览器 POST 落到 SPA 兜底处理器，界面只会看到：

```
transport failure for /zentao-workbench/login: HTTP 405
```

因此宿主半侧改为 `ctx.inject(['webServer'], (webCtx) => …)` 拿嵌套上下文后直接 `webCtx.webServer.register({ kind: 'prefix', path: '/zentao-workbench', handler })`（与官方 `@deepseek-ai/dsh-client-modules` 取 `webServer` 的方式一致），并自己做同源校验：带 `Origin` 时必须与 `Host` 一致，带 `Sec-Fetch-Site` 时只接受 `same-origin` / `none`。

`lib/index.js` 的 `export const inject = ['tools']` 里**不含** `connection`。

### 端点总览

| endpoint | payload | 类型 | 说明 |
| --- | --- | --- | --- |
| `getConfig` | `{}` | 读 | 返回 `{ server, account, realname, role, hasToken, rememberToken }`（**永不返回 token**） |
| `login` | `{ server, account, password?, token?, role?, rememberToken }` | 读 | 换取并校验登录态（`role` 已不再由界面传，缺省 `dev`） |
| `setRole` | `{ role }` | 读 | 切换职位预设并落盘（**界面已不调用**；提示词现在不依赖职位，保留给脚本） |
| `logout` | `{}` | 读 | 清空内存 token 与已保存 token |
| `refresh` | `{ scope: 'tasks' \| 'all' }` | 读 | 返回 `{ fetchedAt, profile, tasks, bugs, stories, scan }` |
| `fetchDetail` | `{ kind: 'task'\|'bug'\|'story', id }` | 读 | 返回单条详情（`sections` / `attachments` / `story` / `meta` / 历史） |
| `analyze` | `{ kind: 'task'\|'bug'\|'story', id }` | 读（**会调用模型**） | 先 `fetchDetail` 再交给 **DSH 默认模型**做 AI 预判，返回 `{ category, categoryLabel, confidence, headline, reason, steps, questions, provider, model, routeSource, routeNote?, truncated?, analyzedAt }` |
| `startTask` | `{ id }` | **写** | 置为「开始」 |
| `finishTask` | `{ id, hours?, comment? }` | **写** | 置为「完成」并登记本次耗时 |
| `assignTask` | `{ id, account }` | **写** | 指派给别人 |
| `listUsers` | `{}` | 读 | 成员表，给「指派」卡片用 |
| `openAttachment` | `{ url, name }` | 读 | 下载到本机临时目录并用默认程序打开 |

另外有一条**非 RPC** 的 GET 路由专供图片/文件预览：

| 路由 | 说明 |
| --- | --- |
| `GET /zentao-workbench/attachment?url=<禅道附件地址>` | 用宿主持有的 Token 回源取附件字节再回吐 |

### 端点细节

#### `login`

用 `POST api.php/v1/tokens` 换 token，随即 `GET user` 校验；token 与密码二选一。

#### `refresh`

`scope: 'tasks'` 只拉任务（快，登录后自动做一次）；`scope: 'all'` 才聚合 Bug 与需求（走产品遍历，见「关于禅道 REST API v1」）。

#### `fetchDetail`

返回 `sections`（描述 / **研发需求描述** / **研发需求验收标准** / 步骤 / 重现步骤 分段正文，绝对地址已补全）、`attachments`（正文内嵌 `<img>`/`<a>` + `files[]` 抽出的附件，每项额外带 `proxyUrl`）、`story`（`{ id, title, status, statusLabel, link }`）、`meta`（`[{ label, value }]` 散字段，如所属执行 / 类型 / 工时 / 严重程度 / 解决方案，枚举已中文化）、`statusLabel` 与历史动作的 `actionLabel`（中文）、最近 10 条历史动作、原始链接。

#### `analyze`

先按 `fetchDetail` 取详情，再把「对象类型 / 编号 / 标题 / 字段 / 状态 / 指派给 / 所属研发需求 / 正文 / 附件」拼成一段输入（正文截到 6000 字）交给模型，要求**只回一个 JSON 对象**：

```json
{ "category": "bug|optimize|feature|other", "confidence": 0-100, "headline": "一句话", "reason": "依据", "steps": ["建议步骤"], "questions": ["待确认"] }
```

- 取模型走 `ctx.reflect.get('llm')`（**不写 `inject`**：cordis 的 `reflect.get` 不需要 inject，取不到只返回 `undefined`，不会让插件加载失败）；默认**跟随 DSH 自己的默认模型**：`ctx.reflect.get('agentDefaultModel')` → `currentSelection()`（`@deepseek-ai/dsh-agent-default-model` 注册的服务，就是 DSH 界面上选中的那个 provider / model，同样不需要 inject）。只有默认模型对应的 provider 在当前实例没注册时，才退化成 `listProviders()` → `listModels()` 自动挑一条（优先 `flash / mini / small / lite / fast`），并带 `routeNote` 说明。`DSH_ZENTAO_WORKBENCH_LLM=provider/model` 可完全钉死，优先级最高。
- 归一化：类别白名单外归 `other`；`confidence` 取整并夹到 0-100，非法则 `null`；`headline ≤ 80`、`reason ≤ 300`、`steps ≤ 5 条 × 160`、`questions ≤ 3 条 × 160`。
- 失败码：`llm-unavailable`（profile 没有可用路由）、`llm-parse`（模型没按要求回 JSON，报错里带原始输出前 300 字；若是被 `maxTokens` 截断会直接说明）、`llm-aborted`（60s 超时或被取消）、`llm-failed`（上游 `finish` 是 `error` 之类，带原始 `kind`、failure 与路由）。**任何一种失败都不会返回半截结论**，界面只弹错误条。
- 返回里带 `provider` / `model` / `routeSource`（`env` = 环境变量指定，`dsh` = 跟随 DSH 默认模型，`auto` = 自动挑的），以及退化成 `auto` 时的 `routeNote`、输出触到上限时的 `truncated: true`；界面会把它显示在预判块的右上角（模型名后括注来源与截断提示，说明另起一行），方便判断「这句话是谁说的」。

#### `startTask`（写）

`POST tasks/{id}/start`。只对 `wait` 状态动手，先 GET 一次拿 `consumed` / `left` 一起提交（不让禅道把工时覆盖成 0），提交后再 GET 回读状态确认。返回 `{ changed, previousStatus, status, statusLabel, note }`：`changed: false` 表示禅道没改状态（比如已经是进行中、已完成、或权限不足），界面会如实提示而不是谎报成功。

#### `finishTask`（写）

`POST tasks/{id}/finish`。先 GET 拿 `realStarted` 与已登记 `consumed`，提交：

```json
{ "realStarted": "YYYY-MM-DD", "finishedDate": "YYYY-MM-DD", "currentConsumed": 2, "consumed": 5 }
```

`hours` 留空按 0，非数字或负数直接拒绝；`comment` 非空才带。提交后**再 GET 回读**，返回 `{ changed, previousStatus, status, statusLabel, consumed, left, finishedDate, note }`：已是「已完成 / 已关闭」直接说明原因不写；状态没变则 `changed: false`。

#### `assignTask`（写）

`PUT tasks/{id}`，body **只有** `{ assignedTo }`。先 GET 拿当前指派人，同人直接返回 `changed: false`；提交后**用 PUT 返回的完整任务对象当回读结果**（为空才补一次 GET）。返回 `{ previousAccount, previousName, account, realname, status, statusLabel, statusChanged, changed, note }`。注意禅道把「未开始」的任务指派出去时会顺手激活为「进行中」，`statusChanged` 会如实带上。

#### `listUsers`

`GET users?limit=100` → `{ users: [{ account, realname }], total, self }`，按真名中文排序、按账号去重。禅道 `users` 的 `limit` 是有效的（任务列表的 `limit` 才是无效的）。

#### `openAttachment`

把附件**下载到本机临时目录**再交给**电脑上的默认程序**打开（`docx` / `xlsx` / `pptx` / `dps` / `pdf` / `zip`… 走这条路）。返回 `{ opened, name, savedPath, size, extension }`。

安全边界：

- 只放行「与已配置禅道同源且路径像附件」的地址；
- **扩展名必须在白名单里**（`OPENABLE_EXTENSIONS`），`.exe` / `.bat` / `.lnk` 这类可执行扩展名在**下载之前**就拒绝，返回 `forbidden`；
- 超过 64 MiB 拒绝；
- 文件名会被清成安全名（去 `\/:*?"<>|` 与控制字符、加时间戳前缀）；
- 保存目录可用 `DSH_ZENTAO_WORKBENCH_OPEN_DIR` 覆盖，打开命令可用 `DSH_ZENTAO_WORKBENCH_OPENER` 覆盖（Windows 默认 `cmd /c start`，macOS `open`，Linux `xdg-open`）。

#### `GET /zentao-workbench/attachment`

用宿主持有的 Token 回源取附件字节再回吐（`private, max-age=600`，并带 `content-disposition: inline`，这样 PDF 在工作台的 iframe 里直接渲染而不是被浏览器当成下载）。

- **为什么必须代理**：禅道直链在没有 `Token` 头时返回的是登录页 HTML（实测 HTTP 200 + `text/html` 380 字节），浏览器里 `<img src="禅道地址">` 只会显示坏图。
- 只允许代理「与已配置禅道同源且路径像附件」的地址，超过 64 MiB 拒绝；未登录 401、跨站或异地地址 403。
- 另外两件事是为视频做的：
  1. 上游给 `application/octet-stream` 时按扩展名改回 `video/mp4` 等正确类型（否则 `<video>` 不播）；
  2. 支持 `Range` 请求 —— 上游禅道完全不支持，宿主整份读进内存后就地切片，返回 `206 + content-range + accept-ranges: bytes`，越界回 `416 + content-range: bytes */N`。

### agent 工具 `zentao`

| 参数 | 取值 |
| --- | --- |
| `action` | `mine`（默认，任务 + Bug + 需求快照）/ `tasks`（只要任务）/ `detail` / `analyze`（AI 预判） |
| `kind` | `action=detail` 或 `analyze` 时：`task` / `bug` / `story` |
| `id` | `action=detail` 或 `analyze` 时：条目 ID |

工具复用浮层那一份登录态，所以**必须先登录**；未登录时它会返回一句明确的提示而不是报错。

---

## 本地验证 <a id="sec-verify"></a>

### 一键跑

```powershell
cd E:\Eworkspace\dsh-zentao-workbench\.verify
node host-smoke.mjs      # 宿主半侧：198/198
node client-smoke.mjs    # 浏览器半侧：259/259
pwsh -File e2e-check.ps1 # 端到端：另起 19399 实例，复核三个写端点与 bundle 内容（跑完自动清理）
```

> 仓库里的 `.verify/` 脚本用**占位数据**：真实内网地址、真实单据号、真实附件 id 都不入库。`host-smoke.mjs` / `client-smoke.mjs` 自带 mock 后端，直接跑就行；想在真机上跑 `e2e-check.ps1`，必须先设下面这几个环境变量（都要换成你自己实例里**真实存在**的对象，直接拿占位值跑必然在真机那几段失败，这是预期的）：
>
> ```powershell
> $env:DZW_ZENTAO_ORIGIN   = 'http://你的禅道:端口'   # 不带结尾斜杠、不带 /zentao，脚本自己拼
> $env:DZW_E2E_CLOSED_TASK = '10004'                 # 一条已关闭 / 已完成任务：验「终态不再写」守卫
> $env:DZW_E2E_STORY_TASK  = '10002'                 # 一条挂着研发需求的任务：验 storySpec / meta 出得来
> $env:DZW_E2E_MP4         = 'file-read-31001.mp4'   # 一个真实附件 id：验代理的 Range 切片（拿到 video/* 才额外验类型归一化）
> $env:DZW_E2E_PNG         = 'file-read-31002.png'   # 一个真实的 png 附件：验「用默认程序打开」链路
> ```
>
> `DZW_ZENTAO_ORIGIN` 必须与 `~/.dsh-zentao-workbench.json` 里保存的服务器**同源**，否则附件会被宿主按「非当前禅道服务器」拒绝。

### `host-smoke.mjs` 覆盖什么

起一个 mock 禅道后端 + mock `ctx`（忠实复刻「未注入的服务读不到」这条规则，读 `connection` 会直接抛错），覆盖：

- **传输层**：非 POST → 405、跨站 `Origin` → 403、`content-type` 不对 → 415、缺端点名 → 400、坏 JSON → 400、超过 64 KiB → 413、同源放行。
- **登录与配置落盘**：未登录保护、登录成功/失败、HTTP 401 的重新登录提示；配置写到临时文件、不含密码、未勾选「记住 Token」时 token 为空串。
- **列表与排序**：`refresh` 聚合与 `page` 参数、**任务 ID 倒序**、`Token` 头、单个产品失败被跳过而不是整体失败。
- **详情**：三种响应形态 + **真实实例形态**（空字符串 `desc`、正文与附件都在 `bugSteps`、附件是正文内嵌 `<img>`）、HTML→纯文本、中文字段（`statusLabel` / `actionLabel`）、附件地址补全。
- **附件代理**：未登录 401、缺 `url` 400、跨站 `Origin` 403、异地地址 403、同源非附件路径 403、超 64 MiB 413、正常回源带 `Token` 头并保持 `image/png` 与 `private` 缓存头；**mp4 上游给 `application/octet-stream` 时改回 `video/mp4` 并补 `content-length` / `accept-ranges`**、`Range` 四种形态（`bytes=0-1023` / `bytes=1024-` / 后缀 `bytes=-100` / 越界）分别回 206 + `content-range` + 正确切片字节数或 416 + `bytes */N`、非法 `Range` 头按整份 200 返回。
- **点「处理」后把任务置为开始**：只打 `start` 路由一次、请求体带 `realStarted`（`YYYY-MM-DD`）与原 `consumed` / `left`、已 `doing` / 已完成的任务不重复写、**`start` 返回 200 但状态没变时必须 `changed: false` 并给出原因**（不谎报成功）、缺 `id` 返回 `bad-request` 信封。
- **「完成」/「指派」/ 成员列表**：`assignedTo` 在真实实例上是**对象** `{ id, account, realname }`（旧代码 `asString(对象)` 恒为空串，会让「指派给我」的过滤形同虚设）而宿主要能解出账号与真名；`finishTask` 只打一次 `finish`、请求体带 `realStarted`（`YYYY-MM-DD`）+ `finishedDate` + 正确的 `currentConsumed`/`consumed` 累加、`6002` 这种「禅道收下但状态没变」必须 `changed: false` 且 note 含「没有改变任务状态」、已完成的任务不重复写、耗时留空按 0、负耗时 / 非数字 / 缺 id 一律 `bad-request` 信封；`assignTask` 的 body **只带 `assignedTo` 一个键**、`statusChanged` 如实反映「激活为进行中」、同人指派不重写、禅道回 200 但没改人时 `changed: false` + note 含「没有改变指派人」、缺 `account`/`id` → `bad-request`；`listUsers` 去重 + 中文排序（`['lisi','zhangsan']`）+ 带上 `self`，且请求参数是 `users?limit=100`。
- **研发需求与散字段**：真机形态的任务 `#10002`（`desc` 为空但挂着需求）下，`storySpec` / `storyVerify` 分别进 `sections` 的「研发需求描述」「研发需求验收标准」、需求正文里的内嵌截图也进 `attachments` 且带 `proxyUrl`、`story` 给出 `{ id: '2001', title, statusLabel: '激活', link: '…/story-view-2001.html' }`（数字 `storyID` 不再被 `asString` 吞成空串）、`meta` 里「所属执行 / 模块 / 类型（`devel → 开发`）/ 预计·已耗·剩余工时 / 计划开始 / 延期（天）」逐条正确、`zentao` 工具文本含「研发需求：#2001」与「类型：开发」。
- **用系统默认程序打开附件**（`openAttachment`）：`docx` 成功时 `opened=true`、返回的 `savedPath` 落在 `DSH_ZENTAO_WORKBENCH_OPEN_DIR` 下、`size` 与 `extension` 正确、**文件真的写到了本机**（冒烟用 `DSH_ZENTAO_WORKBENCH_OPENER=process.execPath` 以免真弹窗）、回源带 `Token` 头、文件名被清成 `<时间戳>-file-read-31005.docx`；`.exe` 请求返回 `forbidden` 信封且**根本没有发出下载请求**（白名单在 fetch 之前拦下）；异地 `evil.example.com` → `forbidden`；没有扩展名 / 缺 `url` → `bad-request`。
- **AI 预判（`analyze`）**：mock 出 `ctx.reflect.get('llm')`（并断言宿主**没有**走 `ctx.llm` 直读这条需要 inject 的路），覆盖选中路由（第一个 provider + 命中 `flash` 的模型）、**跟随 DSH 默认模型**（mock `ctx.reflect.get('agentDefaultModel').currentSelection()`：可用时 `routeSource: 'dsh'` 且不再挑 `flash`、也不再枚举模型；provider 没注册时退化成 `auto` 并带 `routeNote`；`listProviders()` 抛错时仍按默认模型发；`DSH_ZENTAO_WORKBENCH_LLM` 优先级最高；读默认模型抛错 / 字段为空 / 形状不对都安静回退不崩）、类别白名单外归 `other`、`confidence` 取整与非法值归 `null`、`headline` / `reason` / `steps` / `questions` 的长度与条数截断；失败面覆盖**读不到 `llm` 服务**（`llm-unavailable`，有没有默认模型都一样）、**profile 里没有任何可用路由**（同码但文案不同）、模型回了带围栏/前后废话的输出仍能抠出 JSON、模型回非 JSON（`llm-parse`，报错带原始输出）、`finish.reason.kind !== 'stop'`（`llm-failed`，带原始 kind 与 failure）、**`max-tokens` 收尾但 JSON 已完整 → 照用并标 `truncated: true`；真的截在半截 → `llm-parse` 且文案点明被 `maxTokens=4000` 截断**、超时/取消（`llm-aborted`）、缺 `kind`/`id` 或 `kind` 非法（`bad-request`）、未登录（明确提示而不是 `llm-unavailable`）；并断言整个分析链路**只打一次 `fetchDetail`**、失败时**不返回任何半截结论**。
- 它用 `DSH_ZENTAO_WORKBENCH_CONFIG` 指向临时目录，不会污染你的真实配置。

### `client-smoke.mjs` 覆盖什么

用 React/DOM 替身按 `useState` 顺序注入初始 state，mock 出**真实服务面**（`sessions.list/create/retain/scope`、`workspaces.list`，刻意**没有** `sessions.open` 与 `workspaces.connectWorkspace`），覆盖：

- **加载契约**：模块 id、`inject`、apply 注册的 slot（`shell.overlay`）、样式注入只做一次。
- **样式与 slot 注册**：`--dsw-*` 令牌白名单；「tab 不再被压缩」；悬浮卡片样式；**面板与卡片共用 `--dzw-frame-height` 固定高度、列表 `flex: 1` 内滚动**。
- **首屏未登录**：登录表单渲染，且**不再有职位选择**。
- **已登录有数据**：「发送目标」文案、ID 倒序渲染、`@真名` 显示。
- **点「处理」**：`uiWorkspace.connectWorkspace` → `retain(source=zentao-workbench)` → `openSession` → `release` → `conversation.send`，并断言提示词含当前工作区标题与绝对路径。
- **详情悬浮卡片**：点标题 → 卡片出现、分段正文、**图片附件出 `<img class="dzw-thumb">` 且 `src` 走宿主代理、正文里的 `[附件]` 行不重复显示、状态与历史动作显示中文**、附件链接 `target=_blank`、点「关闭」关闭、`Esc` 关闭、再点标题也关闭、样式里没有全屏遮罩层、**切到空分类时面板仍在且换成空状态**。
- **图片放大预览**：点缩略图 / 点「放大」写入 `preview` state、透明点击层里出悬浮卡片 `.dzw-preview-card` 且大图 `src` 是代理地址、卡片上下各一个「关闭」共两个、底部有「点空白处或按 Esc 也能关闭」提示、点空白处 / 点两个「关闭」/ `Esc` 四种关法、`Esc` 先关预览再关卡片、面板收起后仍能看大图、点卡片吞冒泡；CSS 断言「`.dzw-preview` 是 transparent 且不含 `--dsw-alias-bg-mask`、`.dzw-preview-card` 有边框阴影且不 `inset: 0`」。
- **醒目的关闭入口**：两个 `.dzw-preview-close` 里第一颗是 `dzw-preview-close-float` 且带 `✕`、第二颗是 `dzw-preview-close-solid`；CSS 断言实心底色 + 边框 + 阴影 + 右上角 `position: fixed; top/right: 16px; z-index: 71` + 深色半透明底 + 主题色实心按钮。
- **附件的三种打开方式**：卡片里的 `<video>` 只 `preload="metadata"`；放大层 `<video class="dzw-preview-video">` 带 `controls`，但 **`autoPlay` 必须是 `undefined`**（点击才播放）且提示文案含「点播放键开始播放」；PDF 附件旁边恰好一个「预览 PDF」，点它写入 `preview` 且 `kind === 'pdf'`，浮层渲染 `iframe.dzw-preview-pdf`（`src` 走宿主代理、不再出现 `<img>`/`<video>`、有「新窗口打开 / 关闭 / Esc」提示），CSS 断言 `.dzw-preview-pdf` 是 `display: block` + `height: calc(100vh - 190px)` + 有边框；word/excel 附件旁边恰好一个「用默认程序打开」，点它会调 `openAttachment` 且 payload 是 `{ url: 禅道原件地址, name: '需求说明.docx' }`、成功后 toast 含「已交给系统默认程序打开」、失败（宿主回 `forbidden`）时 toast 含「打开附件失败」而不是静默。
- **点「处理」后调 `startTask`**：带正确 id、成功后提示中文状态并刷新列表、禅道没改状态时提示「状态未变」、Bug / 需求不动手。
- **「完成」/「指派」两张卡片**：条目上只有任务有这两个按钮、已完成任务的「完成」按钮禁用、点开写入 `finishFor` / `assignFor` state、耗时与备注的输入回写、耗时非法时不发请求且卡片不关、提交后 toast 带中文状态与累计耗时并刷新列表、`changed: false` 时提示「状态未变 / 未变」而不是谎报成功、成员列表按真名或账号过滤 + 空态、点成员行只发 `{ id, account }`、`Esc` 关闭顺序 预览 → 完成 → 指派 → 详情、面板收起时卡片仍能弹。
- **`uiWorkspace` 不可用时的降级路径**：走 `sessions.create` 且不释放引用。
- **新版提示词**（用户 m04648 的改造）：抬头先要求判类别、四套套路齐全、**真的带上了正文**（先 `fetchDetail` 再拼）与**附件清单**、带确定性字段线索段、带条目标题与工具指引，且不再出现旧的「开发工程师」职位话术。
- **「AI 分析」按钮与预判块**：按钮 title 说明结论会带进提示词；点它调 `analyze` 并把结果写进 state（给「AI 预判：Bug 修复 / 置信度 86」这种提示）；列表行下方渲染 `.dzw-analysis`（中文类别 + 置信度 + 模型名（括注来源「DSH 默认模型 / 环境变量指定 / 自动挑选」）+ 一句话 + 依据 + 建议步骤 + 待确认），按钮变「重新分析」；宿主回退成自动挑路由时另起一行渲染 `.dzw-analysis-note`（并断言这条说明用的是 `--dsw-alias-label-secondary`、没引新令牌）；`truncated: true` 时模型名后加「输出可能被截断」；带预判点「处理」时提示词里追加 `## AI 预判…` 段（类别 / 一句话 / 步骤 / 待确认 + 「由 provider/model（来源）在 <时间> 给出」这行），且**预判不替代正文**（正文与附件仍在）；`analyze` 失败时只把宿主错误显示到面板错误条、**不写脏预判**；mock 里刻意不带 `sessions.open` / `workspaces.connectWorkspace`，顺带验降级路径。
- **发送目标可切换（工作区有多个时）**：工作区 > 1 才渲染 `.dzw-select`、默认停在「跟随当前工作区」且文案带该后缀、下拉里列出「跟随当前工作区 + 两个工作区」共三项、`onChange` 写回最后一个 state、选中 ws-9 后文案与下拉都指向「另一个项目」并把会话建在 ws-9（**不碰** ws-1）、提示词的工作区段落换成 ws-9 的标题与路径、选中的工作区消失后订阅回调把选择重置为空串、只有一个工作区时不渲染下拉但文案点明「当前只有 1 个工作区」、直接把不存在的 ID 交给 `handlePrompt` 会明确报「已不在」、CSS 断言目标行 `display: flex` + `.dzw-target-text` 省略号 + 下拉 `max-width`。
- **详情卡片里的研发需求与 `meta`**：一条可点的「研发需求：#2001 …（激活）」链接（`href` 指 `story-view-2001.html`、`target=_blank`）、`来源 Bug：#3001` 那行仍在、`meta` 逐条渲染成「所属执行：示例执行 / 类型：开发 / 严重程度：3 轻微 / 预计工时：1」，以及**旧宿主没给 `story` / `meta` 时不多渲染任何行**（向后兼容）。

另外：

- `node --check lib/index.js` / `node --check lib/client.js` 也应退出码 0。
- `client-smoke.mjs` 默认还会校验「样式里用到的每个 `--dsw-*` 令牌都在已知令牌白名单里」；若再设置 `DSH_THEME_BUNDLE=<dsh-client-ui-theme 的 client.js 路径>`，会额外逐个到真实主题定义里核对一遍。

### 端到端复核（`e2e-check.ps1`）

`e2e-check.ps1` 会自己预检 19399 端口、起 web 实例、取日志里的一次性 `?token=` 换 Cookie，然后：

- 真机那几段打的 id 全部来自上一节的 `$env:DZW_E2E_*` 变量（默认值就是占位符）；下文出现的 `10004` / `10002` / `file-read-31001.mp4` / `file-read-31002.png` 就是默认值，实跑时会被你的真实值替换。

- 用**不存在的 id `99999991`** 去打 `finishTask` / `assignTask`（期望 `HTTP 200` + `ok:false` 信封，证明路由与链路都在且**零副作用**），再用 `listUsers` 走一次真实只读请求；
- 拿一条**真实已关闭任务**打这两条写链路，验证「写前守卫」—— 终态任务返回 `changed:false` + 「无需再完成」、指派给同一个人返回 `changed:false` + 「已经指派给」，两条都不会发出写请求（顺带证明真实响应里对象形状的 `assignedTo` 能被解成「账号 + 真名」）；
- 从 boot 载荷里取出本插件的 combo bundle 地址核对内容（30 项 needle，并断言 bundle 里 `autoPlay` 出现 **0** 次，即视频确实不会自动播放）；
- 用 `curl.exe` 打一次**真实附件代理**（`file-read-31001.mp4`）：整份 → `200 + accept-ranges: bytes`；`Range: bytes=0-1023` → `206 + content-range: bytes 0-1023/N` 且只回 1024 字节；越界 → `416 + bytes */N`（纯只读）。**这一段的硬断言只压在代理行为上**：禅道里同一个 `file-read-N` 会随时间换成别的文件（实测这个 id 现在返回的是 png），所以「是不是视频」不再当断言 —— 真拿到 `video/*` 时才额外要求归一化成 `video/mp4`，否则打印一行「当前不是视频」的提醒（要验真的 mp4 就用 `DZW_E2E_MP4` 指一个真实附件）；
- `openAttachment` 那一段把**真实的 png 附件**（`file-read-31002.png`，148,982 字节）下载到临时目录并核对落盘字节数、文件名与扩展名，再验证 `.exe` 与缺 `url` 被拒；
- 为避免真的弹出看图软件/播放器，脚本会给实例设 `DSH_ZENTAO_WORKBENCH_OPENER=%SystemRoot%\System32\where.exe` 与 `DSH_ZENTAO_WORKBENCH_OPEN_DIR=%TEMP%\dsh-e2e-open`，跑完连同临时目录一起删掉；收尾会 `taskkill /T` 掉整个实例进程树并删除含 token 的日志。

### 改了代码之后怎么确认生效

> **浏览器半侧的 bundle 是从磁盘现取的**，刷新页面就能换新；**宿主半侧只在进程启动时加载一次**，必须重启 DSH。判断当前跑的宿主是新是旧，可以直接问它：

```powershell
# 任务 10001 详情：新版宿主才有 sections/attachments 字段
Invoke-WebRequest 'http://127.0.0.1:19387/zentao-workbench/fetchDetail' -Method Post -ContentType 'application/json' -Body '{"kind":"task","id":"10001"}' | Select-Object -Expand Content
```

端到端验证（**不碰真实凭证**）：另起一个实例 `dsh --profile web --no-open --port 19399`，从日志里取一次性 `?token=` 换 Cookie，再：

```powershell
# 期望 200 + {"ok":true,"value":{…}}（修复前这里是 405）
Invoke-WebRequest "http://127.0.0.1:19399/zentao-workbench/getConfig" -Method Post -ContentType 'application/json' -Body '{}' -WebSession $sess
# 期望 200 + {"ok":false,"error":{"message":"禅道接口报错（tokens）：登录失败…"}} —— 证明链路真的打到了禅道
Invoke-WebRequest "http://127.0.0.1:19399/zentao-workbench/login" -Method Post -ContentType 'application/json' -Body '{…假账号…}' -WebSession $sess
```

页面 HTML（`GET /?token=…`）里的 boot 载荷会列出 `plugins/??dsh-zentao-workbench/client.js&rev=<...>`，该 URL 返回 `text/javascript`，可用于确认浏览器半侧 bundle 已被宿主持有。**验证完记得 kill 该实例并删除含 token 的日志。**

另外可以在**不启动界面**的前提下确认插件已进入组装树：

```powershell
dsh --profile web --dump-config | Select-String -Pattern 'zentao' -Context 1,1
# == dsh-zentao-workbench
# - id: zentao-workbench
#   name: dsh-zentao-workbench
```

---

## 关于禅道 REST API v1 <a id="sec-api"></a>

本插件按禅道 **v1** 接口对接（基础路径 `api.php/v1`）。以下是实测过的事实与坑：

- **登录**：`POST tokens` → `{ token }`，之后每个请求带 `Token` 头。
- **任务列表**：`GET tasks?page=N` —— 该参数在禅道上表现为「每页条数」，**不传只返回 1 条**。
- **Bug / 需求没有「按账号的全局列表」**：只能 `GET products` 拿到产品后逐个 `GET products/{id}/bugs|stories` 再按 `assignedTo` 过滤。因此浮层默认登录后只自动加载「任务」（快），切换到 Bug/需求页签时会按需聚合加载；最多扫描 30 个产品（并发 4），单个产品失败会被跳过而不是整体失败。
- **详情**：`GET tasks|bugs|stories/{id}`（详情响应是**单数键** `{ task: {…} }`）。
- **开始任务**：`POST tasks/{id}/start`（body `{ realStarted, consumed?, left? }`）—— **恒返回 200 + 空响应体**，必须回读 `GET tasks/{id}` 的 `status` 才知道有没有生效。
- **完成任务**：`POST tasks/{id}/finish`（body 必填 `realStarted` + `finishedDate`，缺任一个都是 HTTP 400（`『实际开始』不能为空。` / `『实际完成』不能为空。`），本次耗时用 `currentConsumed`、累计用 `consumed`）—— 同样**恒返回 200 + 空响应体**，一样要回读。
- **指派**：`POST tasks/{id}/assign`、`/assignTo`、`/team` **全是 404**，唯一有效的是 `PUT tasks/{id}`（body `{"assignedTo":"账号"}`），而且它 200 的响应体就是**更新后的完整任务对象**，可以直接当回读结果用。
- **成员列表**：`GET users?limit=100` → `{ page, total, limit, users: [{ id, dept, account, realname, role, pinyin, email }] }`（**这里 `limit` 是生效的**，与任务列表相反）。
- **视频附件**：`GET file-read-{id}.{extension}` 取 mp4 时返回的是 **`content-type: application/octet-stream`**，还**没有 `content-length`、没有 `accept-ranges`，并且完全忽略 `Range`**（实测无 `Range` / `bytes=0-1023` / `bytes=1000-` 三种请求都回 200 + 全量 2,046,090 字节）。所以分段播放完全是宿主这一侧做出来的：先整份读进内存，再按 `Range` 就地切片（`206` + `content-range`）来喂给 `<video>`。

---

## 已知限制 <a id="sec-limits"></a>

- 需要 DSH 能访问到你的禅道地址（本机直连或内网可达）。
- 拖拽条目到输入框引用（dsh-zentao 的 `conversation.input.overlay` 能力）**尚未实现**，当前用「复制提示词 / 处理」两条路径替代。
- **写操作只有三个、且都只对任务有效**：点「处理」顺手置为「开始」、点「完成」登记耗时并完成、点「指派」改指派人。三个都在写后**回读确认**（禅道写接口恒 200 空体，看不出成败），状态没变就如实提示而不是谎报成功。解决 Bug、改需求状态等其它写操作仍由模型按工具调用完成，本插件不自带这些接口。
- **「用默认程序打开」会在本机落文件**：宿主把附件下载到 `%TEMP%\dsh-zentao-workbench\` 再交系统打开（不会自动清理），扩展名走白名单、`.exe`/`.bat`/`.lnk` 在下载前就被拒绝。请只对你自己认可的附件点这个按钮。
- 「处理」建出的会话**是否自动切到前台**取决于 `uiWorkspace` 服务是否可用（DSH Web 常规情况下可用，启动时会打印一行 `[zentao-workbench] uiWorkspace=ready|unavailable`）。不可用时退化为 `sessions.create({ workspaceId })`，会话仍会带着提示词任务跑起来，但需要你在左侧列表里手动点开。
- **自有路由没有 DSH 的 admission 门**：`GET /` 的登录 Cookie 校验只保护首页（`authorizeIndex`），挂在同一 webServer 上的 `POST /zentao-workbench/*` 不受它保护。本插件只能做同源校验（`Origin`/`Sec-Fetch-Site`），**挡不住本机其它进程直接 POST**。因为它监听 `127.0.0.1` 且只暴露「读禅道 + 登录」，风险面可控；若你不接受这个前提，就别在有不可信本地进程的机器上开 DSH。
- **「AI 分析」跟随 DSH 的默认模型**：它先读 `ctx.reflect.get('agentDefaultModel').currentSelection()`（就是 DSH 界面里选中的那个 provider / model），只有在对应 provider 没注册时才退化成自动挑一条便宜路由并说明原因；profile 里连一条可用路由都没有时返回 `llm-unavailable` 并提示先配模型。每次分析是一次真实模型调用（输出上限 4000 tokens、超时 60 秒），结论由模型给出、**仅供参考**，发出去的提示词里也标注了「由哪个模型给出」。
- **浮层能否出现必须在界面上确认**：组装树与两侧离线冒烟都已通过，但正在运行的 `desktop` profile 由桌面应用独占管理，改完必须重启 DSH 才会加载新插件。

---

## 附录 A：开发中发现并修掉的 20 个真实缺陷 <a id="sec-defects"></a>

记录下来，避免以后再踩：

1. **原始链接重复拼接** —— `normalizeServer` 已保留部署路径 `/zentao`，`webLink` 又拼了一次，导致 `…/zentao/zentao/task-view-11.html`。
2. **详情取错键** —— 详情响应是单数键 `{ task: {…} }`，而代码按复数键 `pickOne(data, 'tasks')` 取，结果标题永远是「（无标题）」。
3. **标签页恒为空** —— 快照字段是复数 `tasks/bugs/stories`，标签页用单数 `task/bug/story` 取，即使拿到数据也显示「暂无条目」。
4. **错误提示对不上真实实例** —— 禅道实际返回 `{"error":"…"}`（缺 Token 时是 HTTP 401 `{"error":"Unauthorized"}`），而代码只认 `{status:'fail', message}`，于是所有失败都退化成 `HTTP 400`。现由 `describeFailure()` 统一映射，401/403 会明确提示「登录状态已失效，请重新登录」。
5. **RPC 通道整个不可用（界面报 HTTP 405）** —— 见上文「传输层」一节：`ctx.connection.rpc.handle()` 的 `owner` 会跳过 `ctx.inject` 派生的影子上下文，第三方插件行上必然抛 `cannot get property "webServer" without inject`；插件因此被跳过，浏览器 POST 落到 SPA 兜底处理器上得到 `HTTP 405`。改为自有 `webServer` 路由 + 同源校验后，实测 `getConfig` / `login` 均为 200，且真实登录请求能拿到禅道返回的业务错误。
6. **照抄参考实现的三个 API 在本机并不存在** —— 参考包跑在别的 DSH 版本上，它用的 `workspaces.connectWorkspace()`、`sessions.open()` 与快照字段 `recentWorkspaceId` 在本机都没有（`sessions` 只有 `create / retain / using / scope / fork`，`workspaces` 只有 `create / rename / delete / pinSession …`）。照抄的结果是点「处理」直接 `TypeError`、按钮毫无反应。按源码核对的真实链路（`uiWorkspace.connectWorkspace` + `sessions.retain/ready` + `conversation.send`）重写后才通。
7. **列表从不排序** —— 宿主与界面都按禅道返回顺序直接渲染，任务多时最新的条目反而在最下面。现在两侧都按 ID 倒序。
8. **空字符串 `desc` 把复现步骤吞掉** —— 详情正文原来写成 `item.desc ?? item.bugSteps`，而禅道对没有描述的任务返回的是**空字符串**（不是 `null/undefined`），`??` 于是选中空串，`bugSteps` 里的重现步骤与截图附件永远不显示。现在按 `DETAIL_BODY_FIELDS` 逐个字段收集非空正文，分成带标签的 `sections`。
9. **附件被当成垃圾标签删掉** —— `htmlToText` 里有一句 `.replace(/<img[^>]*>/gi, '')`。而禅道的**附件就是正文里的 `<img src="…/file-read-*.png">`**（`files` 数组在本实例恒为空数组），于是「步骤里的截图」在界面上永远看不见。现在 `<img>`/`<a>` 的附件地址会被保留、补成绝对路径，并抽进 `attachments` 数组供弹窗列出。
10. **浅色主题下详情正文几乎不可见** —— 详情卡片里的小字原来用 `var(--dsw-alias-label-caption)`，浅色主题下它是 `#adb2b8`（对白底约 2:1 对比度），实测像素是 `(173,178,183)` 对 `(182,184,184)` 的背景，等于没写。现改为 `label-secondary` / 正文 `label-primary`。同时发现遮罩写的 `var(--dsw-alias-bg-mask)` **这个令牌并不存在**（真实令牌是 `--dsw-alias-bg-mask-1/2/3`），一直静默走 fallback —— 拼错的令牌不会报错，所以 `client-smoke.mjs` 现在带一条令牌名白名单断言。（后来按需求把全屏遮罩整个去掉了，改成浮在工作台面板左侧的悬浮卡片。）
11. **附件直链在浏览器里永远是坏图** —— 禅道的 `file-read-*` 地址**不带 `Token` 头时返回的是登录页**（实测 HTTP 200、`content-type: text/html`、380 字节；带 Token 头才是 `image/png`、148,982 字节）。所以把 `<img src="禅道地址">` 直接放进页面只会显示破图，`<a href>` 点开也是登录页。现在由宿主用自己持有的 Token 回源代取（`GET /zentao-workbench/attachment?url=…`，只放行同源且路径像附件的地址，超 64 MiB 拒绝），图片附件因此在卡片里能直接出缩略图。
12. **枚举值直接显示英文** —— 列表和详情里的 `wait` / `doing` / `opened` / `commented` 都是禅道的原始枚举，界面照搬英文。现在宿主侧统一映射成 `statusLabel` / `actionLabel`（`wait → 未开始`、`opened → 创建`），映射表里没有的值原样返回，避免丢信息。
13. **面板高度跟着内容变** —— `.dzw-panel` 原来只写了 `max-height`，高度由内容决定：任务多的时候很高，切到 `Bug(0)` / `需求(0)` 这类空分类立刻缩成一小条，标题栏和底部登录信息之间的位置还会跳；详情卡片也是各自 `max-height`，和面板不一样高。现在两者共用 `.dzw-root` 上的 `--dzw-frame-height: min(76vh, 720px)`，列表改成 `flex: 1` + `overflow-y: auto` 的内滚动区（约 5 条一屏），空分类只把列表换成空状态、面板尺寸不动。
14. **禅道的写接口成功与否看不出来** —— 想「点处理顺便把任务置为开始」，实测 `POST tasks/{id}/start` 恒返回 **HTTP 200 + 空响应体**（用不存在的 id `99999991` 做过零副作用取证：`finish` 缺参数是 400、`assignTo` / `nosuchaction` 是 404、而 `start` 连畸形 JSON 都照样 200），只看状态码必然谎报成功。现在 `startTask` 写前 GET 一次拿 `consumed`/`left` 一起提交（否则禅道可能把工时覆盖成 0）、写后**再 GET 回读 status** 才算成功：状态没变就返回 `changed: false` 并说明原因（已是进行中 / 只有未开始的任务能开始 / 禅道没有改变状态）。`finishTask` / `assignTask` 沿用同一套「写后回读」纪律。
15. **「指派」的路由和「完成」的必填字段，猜错就白写** —— 想加「指派给别人」，按直觉打 `POST tasks/{id}/assign`、`/assignTo`、`/team`，实测**全是 404 `{"error":"not found"}`**；真正有效的只有 `PUT tasks/{id}`，而且它 200 的响应体就是更新后的**完整任务对象**（正好当回读结果用）。`finish` 相反：路由存在，但 `realStarted` 与 `finishedDate` 缺一个就是 400（`『实际开始』不能为空。` / `『实际完成』不能为空。`），成功之后**依旧是 200 + 空响应体**。还有一个隐蔽的坑：`GET tasks/{id}` 返回的任务里 `assignedTo` 是**对象** `{ id, account, avatar, realname }`（旁边另有 `assignedToRealName`），旧代码用 `asString(item.assignedTo)` 取，对象一律变空串 —— 这会让「只看指派给我的 Bug」的过滤条件永远成立（等于没过滤）。以上全部用不存在的 id `99999991` 与一条已关闭的旧任务做过零副作用取证（`PUT` 改完立刻改回原值，只有 3 个时间戳被编辑动作刷新 1 秒），确认路由、必填字段与返回体形状之后才动真实数据。
16. **视频附件「有地址却播不了」** —— 禅道对 mp4 直链回的是 `content-type: application/octet-stream`（还**没有 `content-length`、没有 `accept-ranges`，并且完全忽略 `Range`**：实测无 `Range` / `bytes=0-1023` / `bytes=1000-` 三种请求都回 200 + 全量 2,046,090 字节，见任务 `#10001` 的两个 `.mp4`）。后果有两个：把地址丢给 `<video>` 时浏览器因为类型不对直接不播；就算类型对了，进度条也拖不动 —— 想跳到哪里都得把整段重新下完。现在宿主在代理分支上做两件事：① 上游类型是 `application/octet-stream`（或缺省）时按扩展名改回 `video/mp4` / `audio/mpeg` 等；② 用 `parseByteRange()` 解析 `Range` 请求头，拿内存里那份完整字节就地切片，返回 `206 + content-range + accept-ranges: bytes`，越界回 `416 + content-range: bytes */N`、非法头按整份 200 返回。于是播放器只在需要时才拿分片，拖动不用重下。
17. **「有研发需求描述，弹窗里却是空的」** —— 禅道把任务的研发需求**内联在任务详情里**：`storyID` / `storyTitle` / `storyStatus` / `storySpec`（需求正文，可能整段 HTML 加内嵌截图）/ `storyVerify`。旧代码的正文白名单只有 `desc` / `steps` / `bugSteps`，`storySpec` 压根没取，于是任务页上明明有「研发需求」那一大块，卡片里只有一行「（详情里没有描述 / 步骤正文）」。顺带还有一个更隐蔽的：需求 id 在 `storyID` 里是**数字**，而取值用的 `asString()` 只认字符串，`asString(2001)` 恒为 `''` —— 即使把字段名加对了，也只能拿到空标题、拼不出链接。现在用 `scalarString()` 兼容数字，`storySpec` / `storyVerify` 进 `sections`，`story` 给出可点的「研发需求：#id 标题（状态）」，其余散字段（所属执行 / 类型 / 优先级 / 三种工时 / 计划与实际开始·完成 / 关闭原因 / 延期 / 严重程度 / 解决方案 / 影响版本…）由 `DETAIL_META_FIELDS` + `detailMeta()` 统一收集成 `meta` 逐条显示，枚举值再走 `TYPE_LABEL` / `SEVERITY_LABEL` / `RESOLUTION_LABEL` / `STAGE_LABEL` 中文化。实测依据：任务 `#10002`（`desc` 为空、`storyID: 2001`、`storySpec` 里有内嵌截图）与 `#10003`（`storySpec` 是大表格）—— 这两条在只读探针里都能看到内容，旧版本界面上却什么都没有。
18. **PDF 预览变成「下载」** —— 附件代理一开始只回 `content-type` 与 `private` 缓存头，没有 `content-disposition`。图片和视频无感（`<img>`/`<video>` 只看类型），但把 PDF 放进 `<iframe>` 时浏览器会按「未知处置方式」处理：有的直接触发下载、有的在 iframe 里留一片空白。现在代理分支对 200 与 206 都显式回 `content-disposition: inline`，PDF 因此在工作台内就能翻页预览。顺带把「用默认程序打开」做成**先查扩展名白名单再下载**：下载到本机再交系统执行，等于把「附件」变成「可执行文件」，`.exe` / `.bat` / `.lnk` 这类必须在发出请求之前就拒绝（返回 `forbidden`，冒烟里有一条断言专门验证「被拒的 exe 根本没被下载」）。
19. **提示词「看起来不对劲」：正文取不到、话术锁死成开发一套、附件压根没进提示词** —— 用户原话是「提示词似乎不对劲 如何优化？原来存在职位 根据职位的。现在没有职位？」。三处原因叠在一起：① 提示词里的 `if (item.description)` **永远不成立**，因为列表行（`normalizeItem`）只带标题 / 状态 / 指派人，正文字段只在详情里 —— 所以提示词里只有一行标题加一个链接，模型既看不到重现步骤也看不到截图；② 职位下拉被取消后 `FIXED_ROLE = 'dev'` 把所有条目都按「开发」讲，Bug、优化、需求套的是同一套话术，而 dev 文案里还写死了「按项目《禅道接口.md》的收尾闭环流程」（换个工作区就指向不存在的文件）；③ 附件（含正文内嵌截图）从来没有以任何形式进过提示词。现在：点「处理 / 复制提示词」会**先调一次 `fetchDetail`**，把 `description` 与附件清单拼进 `### 描述 / 重现步骤 / 研发需求` 与 `### 附件（N 个）`；抬头（`PROMPT_INTRO`）改成「第一步先判 Bug 修复 / 体验或性能优化 / 新增需求 / 其它，第二步再按对应套路干活」；删掉 `ROLES` 四套职位预设与写死的文档名；另加确定性的**字段线索段**（标题关键词 + `kind` + 严重程度 / 优先级 / 状态，只给线索不锁结论）；并新增**「AI 分析」按钮**（宿主 `analyze` 端点用 `ctx.reflect.get('llm')` 调当前 profile 的模型，要求只回 JSON），结论以 `## AI 预判（工作台按当前模型给出，仅供参考，请自行复核）` 段随提示词一起发出去。

20. **「AI 分析」用的不是 DSH 自己的默认模型** —— 用户问「AI 分析的调用默认 AI 不应该跟随 DSH 吗？」。旧实现是「`listProviders()` 的第一个 provider + 名字里带 `flash` 的模型（没有就取第一个）」，实测在 web profile 上挑中的是 `shuai/gpt-6-astra`，而 DSH 自己的默认模型（`@deepseek-ai/dsh-agent-default-model` 的 `agentDefaultModel` 服务，配置键 `agent-default-model`）在 desktop profile 里是 `zai-coding-cn/glm-5.3`、web profile 里是 `deepseek-official/deepseek-flash` —— 也就是说分析用的模型和界面右上角显示的模型**可以毫无关系**。现在改成三级优先级：`DSH_ZENTAO_WORKBENCH_LLM`（显式钉死）＞ `ctx.reflect.get('agentDefaultModel').currentSelection()`（跟随 DSH 默认模型，`routeSource: 'dsh'`）＞ 自动挑便宜路由（`routeSource: 'auto'`，并回带 `routeNote` 说明为什么没跟随）。只有默认模型的 provider 在当前实例**没注册**时才放弃跟随（那时硬发只会得到 `INVALID_CATALOG`）；`listProviders()` 本身抛错时反而照发默认模型，不武断回退。取证方式：`npx @electron/asar extract-file` 从 `app.asar` 里取出 `dsh-agent-default-model` / `dsh-agent/lib/types/model-selection.js` / `dsh-client-ui-model-selection`，并直接读两个 profile 的 `cordis.patch.yml` 拿到真实默认值。改完在临时 `--profile web --port 19399` 实例上端到端实测过一次：`POST /zentao-workbench/analyze {"kind":"task","id":"10002"}` 返回 `provider: "deepseek-official"`、`model: "deepseek-flash"`、**`routeSource: "dsh"`**（web profile 的 `agent-default-model` 正是这一对），并且同一轮暴露出 900 tokens 不够 —— 模型以 `finish: max-tokens` 收尾、一个 JSON 都没吐出来，于是额度提到 4000 并改成「先解析、能解析就用」。

---

## 附录 B：研发需求字段实测（2026-10） <a id="sec-probe"></a>

用 `~/.dsh-zentao-workbench.json` 里已保存的 Token **只读**核对过（不写任何数据）：

- `GET tasks?page=50`：11 条任务里带需求字段的是 `storyID` / `storyTitle` / `storyStatus` / `storyVersion` / `latestStoryVersion`（列表里**不带** `storySpec`，正文只在详情里）。
- `GET tasks/{id}`：任务挂在需求上时同时有 `storyID`、`storyTitle`、`storyStatus`、`latestStoryVersion`、`storySpec`、`storyVerify`；任务的 `assignedTo` 是对象（`{ id, account, realname }`），另有 `assignedToRealName`。
- `GET stories/{id}`：`spec` 就是任务里看到的 `storySpec`，另有 `verify`、`productName`、`moduleTitle`、`category`、`stage`、`reviewers`。
- 因此「任务 → 研发需求」这条链路不需要额外请求：详情一次性带回来，宿主拆成 `sections` + `story` + `meta` 即可（省一次往返，也避免需求权限不同导致取不到）。
