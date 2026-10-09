# dsh-zentao-workbench

> 把**你自己的禅道**接进 DeepSeek Harness（DSH）的浏览器界面：右下角一个浮层工作台，登录后列出**指派给我**的任务 / Bug / 需求，点一条就能**新建对话并自动发送处理提示词**。

插件同时提供宿主半侧与浏览器半侧，**零第三方运行时依赖**，面向本地自用（`private`，不发布 npm）。思路参考 [`@haoyu-qi/dsh-zentao`](https://github.com/haoyu-qi/dsh-zentao)，按当前 DSH 版本重写。

## 功能

- **只列指派给我的**：任务 / Bug / 需求三个标签页，按编号倒序。Bug 与需求按产品聚合后严格按 `assignedTo` 过滤 —— 未指派的条目不会混进来。
- **一键开工**：每条旁边的「处理」会新建对话并把提示词原样发出去；失败自动复制到剪贴板兜底。提示词抬头要求模型**先判类别**（Bug 修复 / 体验或性能优化 / 新增需求 / 其它），再按对应套路干活。
- **正文与附件真的进提示词**：生成提示词前先拉一次详情，把描述 / 重现步骤 / 研发需求正文与附件清单一起带上；详情读不到时**直接报错、不发残缺提示词**。
- **AI 预判（可选）**：点「AI 分析」，用 **DSH 当前的默认模型**先判这是 Bug / 优化 / 还是需求（带置信度、一句话、依据、建议步骤），结论会随提示词一起发出，并标注是哪个模型给的。
- **详情是悬浮卡片**：点标题在工作台左侧浮出卡片，分段显示正文、附件、研发需求链接、散字段与历史动作，状态与动作**显示中文**；不铺全屏遮罩、页面不压暗。
- **附件按类型分流**：图片点开放大、视频**点了才播**、PDF 在工作台内预览、Word/Excel/PPT 交给**电脑上的默认程序**打开（可执行扩展名在下载前就被拒绝）。
- **任务可直接写回禅道**：置为「开始」、完成并登记耗时、指派给别人 —— 三个动作都**写后回读确认**，改不动就如实提示，不谎报成功。
- **模型也能读禅道**：另注册一个 agent 可调用的 `zentao` 工具，让模型自己拉取与阅读禅道条目。
- **跟得上主题**：所有颜色/圆角/字体走 DSH 的 `--dsw-*` 设计令牌，浅色与暗色主题自动跟随。

## 界面速览

```
┌─ 禅道工作台 ──────────────────────── 张三 ── 刷新 / 收起 ─┐
│ 发送目标：dsh-zentao-workbench（E:\Eworkspace\…） ▾      │
│ ┌ 任务（11）┬ Bug（1）┬ 需求（3）┐                       │
│ │ #10003 补充单元测试   进行中  @张三   处理 复制 AI 分析 │
│ │ #10002 修复登录超时   未开始  @张三   处理 复制 AI 分析 │
│ │ …                                                      │
│ └────────────────────────────────────────────────────────┘
│ http://你的禅道/zentao      更新于 10:24:31      退出登录 │
└──────────────────────────────────────────────────────────┘
```

点条目标题 → 左侧浮出详情卡片（正文 / 附件 / 研发需求 / 历史）；点「处理」→ 新建对话并自动发送提示词。

## 安装

```powershell
# 1) 把插件加进你的 profile（会写进 profile 的 package.json）
dsh plugin --profile web add "E:\Eworkspace\dsh-zentao-workbench"

# 2) 重启 DSH，刷新页面
```

**先确认你在哪个 profile**：DSH 桌面版默认跑 `desktop`（可用 `DSH_PROFILE` / `DSH_PROFILE_DIR` 确认）—— 那就把上面的 `--profile web` 换成 `--profile desktop`。`desktop` 由桌面应用独占管理，改完必须**完全退出并重启应用**（宿主半侧只在进程启动时加载一次；浏览器半侧刷新页面即可换新）。

移除：

```powershell
dsh plugin --profile web remove dsh-zentao-workbench
```

## 使用

1. **登录**：面板里填禅道地址（可带 `/zentao` 部署路径）、账号 + 密码或 Token。默认勾选**记住密码**（见下），也可以只勾「记住 Token」。
2. **选发送目标**：默认「跟随当前工作区」（左侧正在看的项目）。有多个工作区时这一行会出现下拉，选中后新会话建在该工作区下，提示词里的工作区段落也会同步替换。
3. **看条目**：切标签页按需加载（登录后先只拉任务，最快）。条目下方可点「AI 分析」；点标题看详情悬浮卡片。
4. **开工**：点「处理」→ 新建对话并发送提示词。任务会顺带在禅道里置为「开始」；Bug / 需求不动手。
5. **收尾**：任务上还有「完成」（登记本次耗时 + 备注）与「指派」（选人，可按真名或账号搜索）。

> 「刷新」按当前标签页取数：任务页只拉任务（快）；Bug / 需求页需要逐产品聚合。两分钟内的重复刷新直接吃缓存，点「刷新」可强制重拉。
>
> **Token 过期基本无感**：禅道的 Token 会过期。勾了「记住密码」时，宿主会用保存的密码**自动重新登录并把失败的请求重试一次**，你通常看不到任何中断；只有自动重登也失败（密码改过、账号被锁）才会切回登录表单，服务器/账号已带出，填一次即可继续。

### 关于「记住密码」

- **默认勾选**，可以在登录表单里取消；登录后也能在面板上点「清除已保存的密码」随时撤销。
- **不存明文**：Windows 上用 **DPAPI**（`ConvertFrom-SecureString`）加密后写入 `~/.dsh-zentao-workbench.json`（权限 `0600`）。密文只能被**同一个 Windows 用户 + 同一台机器**解开；换机器、换用户、或文件被改动都解不开，插件会当作「没存过密码」，退回手动登录。
- 非 Windows 平台没有等价的系统级方案，插件**不会**退化成明文保存 —— 勾了也不会存，仍按「Token 过期 → 手动重新登录」处理。
- 自动重登有防抖：同一时刻只尝试一次，失败后 30 秒内不再重试，避免把账号撞到锁定。

## 配置

配置文件在 `~/.dsh-zentao-workbench.json`（权限 `0600`）：

```json
{
  "server": "http://www.example.com:11180/zentao",
  "account": "your-account",
  "role": "dev",
  "rememberToken": false,
  "token": "",
  "rememberPassword": true,
  "passwordScheme": "dpapi",
  "passwordEnc": "<DPAPI 密文，仅当前 Windows 用户 + 本机可解>"
}
```

| 环境变量 | 作用 |
| --- | --- |
| `DSH_ZENTAO_WORKBENCH_LLM` | 钉死 AI 分析用的模型，格式 `provider/model`（默认跟随 DSH 的默认模型） |
| `DSH_ZENTAO_WORKBENCH_OPEN_DIR` | 「用默认程序打开」的落盘目录，默认 `%TEMP%\dsh-zentao-workbench\` |
| `DSH_ZENTAO_WORKBENCH_OPENER` | 打开文件用的命令，默认 Windows `cmd /c start` / macOS `open` / Linux `xdg-open` |
| `DSH_ZENTAO_WORKBENCH_CONFIG` | 覆盖配置文件路径（离线测试用） |

环境变量是**宿主半侧**的，改完要重启 DSH。

配置文件里**没有明文密码**：`passwordEnc` 是 DPAPI 密文，只有当前 Windows 用户在本机解得开；`token` 也只在勾了「记住 Token」时才有值。前端（浏览器半侧）任何接口都拿不到密码或 Token，只能拿到「有没有保存」这两个布尔值。

## 给模型用的 `zentao` 工具

| 参数 | 取值 |
| --- | --- |
| `action` | `mine`（默认，任务 + Bug + 需求）/ `tasks`（只要任务）/ `detail` / `analyze` |
| `kind` | `action=detail` / `analyze` 时：`task` / `bug` / `story` |
| `id` | `action=detail` / `analyze` 时：条目 ID |

复用浮层那份登录态，所以要先登录；未登录会返回一句明确提示。

## 已知限制与安全

- 需要 DSH 能访问到你的禅道地址（本机直连或内网可达）。
- **写操作只有三个，且只对任务有效**：开始 / 完成 / 指派。其它写操作仍由模型按工具调用完成。
- **「用默认程序打开」会在本机落文件**：附件下载到临时目录再交系统打开（不会自动清理）。扩展名走白名单，`.exe` / `.bat` / `.lnk` 在下载前即被拒绝；请只对你自己认可的附件点这个按钮。
- **面板的路由没有 DSH 的 admission 门**：`POST /zentao-workbench/*` 只做同源校验（`Origin` / `Sec-Fetch-Site`），**挡不住本机其它进程直接 POST**。它只监听 `127.0.0.1`、且只暴露「读禅道 + 登录」，风险面可控；若不接受这个前提，别在有不可信本地进程的机器上开 DSH。
- **AI 分析是一次真实模型调用**（输出上限 4000 tokens、超时 60 秒），结论**仅供参考**，提示词里会注明是哪个模型给出的。
- 拖拽条目到输入框引用（参考实现的 `conversation.input.overlay` 能力）**尚未实现**，当前用「复制提示词 / 处理」两条路径替代。

## 开发

| 文档 | 内容 |
| --- | --- |
| [docs/development.md](docs/development.md) | 架构、传输层决策、端点契约、客户端实现要点、验证脚本、21 条历史缺陷 |
| [docs/zentao-api-notes.md](docs/zentao-api-notes.md) | 禅道 REST v1 实测事实（列表 / 写接口 / 附件 / 字段 / 性能） |

回归与验证：

```powershell
node --check lib/index.js
node --check lib/client.js
node .verify/host-smoke.mjs     # 宿主半侧（216 条断言）
node .verify/client-smoke.mjs   # 浏览器半侧（300 条断言）
pwsh -File .verify/e2e-check.ps1 # 端到端（另起 19399 实例，跑完自动清理）
```

改了代码之后：**浏览器半侧刷新页面即可**，**宿主半侧必须重启 DSH**。

## 目录结构

```
dsh-zentao-workbench/
├─ lib/index.js      # 宿主半侧：自有 webServer 路由 + zentao 工具 + 禅道客户端
├─ lib/client.js     # 浏览器半侧：shell.overlay 上的浮层工作台
├─ cordis.patch.yml  # bundle patch
├─ .verify/          # 冒烟与端到端脚本（占位数据，不含真实地址/单据号）
└─ docs/             # 开发文档与接口笔记
```

## License

MIT
