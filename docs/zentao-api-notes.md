# 禅道 REST API v1 实测笔记

> 本插件按禅道 **v1** 接口对接（基础路径 `api.php/v1`）。下面是 2026-10 在真实实例上用真实 Token **只读**核对过的事实与坑（写接口的取证方式见文末「零副作用取证」）。
>
> 与使用者无关，写给后续维护者：改代码前先看这里，能省掉大半试错。

## 登录与请求头

- **登录**：`POST tokens` → `{ token }`，之后每个请求带 `Token` 头。
- 缺 Token 时列表接口返回 `HTTP 401` + `{"error":"Unauthorized"}`；**鉴权在路由之前**，所以不带 Token 时任何路径（包括不存在的路径）都是 401，无法用状态码区分「路由存在与否」。

## 列表接口

| 接口 | 实测行为 |
| --- | --- |
| `GET tasks?page=N` | `page` 在这里表现为「每页条数」，**不传只返回 1 条**；响应带 `total`（本插件已用它提示「仅显示前 50 条」） |
| `GET products?limit=100` | 正常，`limit` 生效 |
| `GET users?limit=100` | 正常，`limit` 生效（与任务列表相反） |
| `GET products/{id}/bugs?limit=100` | 正常，**必须带 `product`** |
| `GET products/{id}/stories?limit=100` | 正常，**必须带 `product`** |
| `GET bugs` / `GET stories` | `400 {"error":"Need product id."}` —— 路由存在但拒绝无产品查询 |
| `GET my/bugs`、`GET user/bugs`、`GET my/stories` | `404` —— 没有「我的」聚合入口 |

## 为什么「指派给我」只能本地过滤

Bug / 需求没有「按账号的全局列表」，只能逐产品取回来再本地按 `assignedTo` 过滤。所有可能省掉这件事的参数都实测无效：

| 尝试 | 结果 |
| --- | --- |
| `bugs?assignedTo=账号`、`bugs?product=1&assignedTo=账号` | `total` 与不传时**完全一样**（服务端忽略 `assignedTo`） |
| `fields=id,title`、`fields=id` | 响应体与全字段**一样大**（忽略 `fields`，140.3 KB 不变） |
| `product=1,2`、`product[]=1&product[]=2`、`product=1&product=2` | `total` 等于只传 `product=1`（不支持多产品；第二种直接回空） |
| `products=1,2` | `400` |
| `order=id_desc`、`page=1` | 接受，但不改变「必须逐产品」这件事 |

**结论：按人过滤只能本地做，逐产品扫描是硬约束。**

另外，「未指派」不算「指派给我」：禅道里大量需求处于未指派（`assignedTo` 为空串，`GET stories/{id}` 详情里也是空）。实测某产品下 63 条需求里只有 3 条指派给本人，其余 60 条都是未指派 —— 早期把空指派当成「指派给我」放行，导致需求页堆进大量别人的/没人认领的条目。

## 性能

- **同一会话的请求实际上被串行处理**：18 个请求在并发 4 / 9 / 12 下分别耗时 4.18 / 4.36 / 4.13 s，接近串行（18 × ~230 ms），说明服务端存在会话锁或进程池很小。**提高并发不会更快**，只会增加瞬时压力。
- **单请求固定开销 ~230 ms**，体积其次：`limit=1`（1.4 KB）287 ms vs `limit=100`（140 KB）451 ms。
- 因此优化方向只有「少打请求」与「边扫边给」：
  - 任务列表：1 个请求（~0.2 s）；
  - 单个类别（Bug 或需求）：1 次 `products` + 每产品 1 个请求 ≈ 10 个请求（~2.3 s）；
  - 两个类别同时：约 19 个请求（~4.5 s）。
- 插件侧对策：产品列表 5 分钟缓存、按类别的聚合结果 2 分钟缓存、渐进扫描（先回首包 + `jobId`，客户端轮询增量）、客户端本地快照秒开。详见 [开发文档](./development.md#数据流与缓存策略)。

## 写接口

| 动作 | 实测结论 |
| --- | --- |
| `POST tasks/{id}/start` | 路由存在，但**恒返回 200 + 空响应体**，看不出成败 → 必须回读 `GET tasks/{id}` 的 `status` |
| `POST tasks/{id}/finish` | 必填 `realStarted` + `finishedDate`，缺一个就是 `400`（`『实际开始』不能为空。` / `『实际完成』不能为空。`）；成功同样**200 + 空响应体**；本次耗时是 `currentConsumed`，累计是 `consumed` |
| `POST tasks/{id}/assign`、`/assignTo`、`/team` | **全是 404 `{"error":"not found"}`** |
| `PUT tasks/{id}` | 唯一有效的指派方式（body `{"assignedTo":"账号"}`），而且 200 的响应体就是**更新后的完整任务对象**，可直接当回读结果用 |

补充两个隐蔽行为：

1. **指派会把「未开始」的任务激活成「进行中」**（副作用要如实提示用户）。
2. `GET tasks/{id}` 里的 `assignedTo` 是**对象** `{ id, account, avatar, realname }`（旁边另有 `assignedToRealName`）。用「只认字符串」的取值函数读它只会得到空串，会让「只看指派给我的」过滤条件永远成立（等于没过滤）。

### 零副作用取证

写接口的结论都不是猜的，用**不存在的 id `99999991`** 与一条已关闭的旧任务试出来的：

- `finish` 缺参数 → 400、`assignTo` / `nosuchaction` → 404，而 `start` 连畸形 JSON 都照样 200 —— 说明只看状态码必然谎报成功；
- `PUT` 改完立刻改回原值，只有 3 个时间戳被编辑动作刷新 1 秒。

## 附件

- **直链在没有 `Token` 头时返回的是登录页 HTML**（实测 HTTP 200 + `content-type: text/html`、380 字节；带 Token 才是 `image/png`、148,982 字节）。所以浏览器里 `<img src="禅道地址">` 只会是坏图，必须由宿主持 Token 代理回源。
- **mp4 直链的类型与 Range 都不对**：返回 `content-type: application/octet-stream`，**没有 `content-length`、没有 `accept-ranges`，并且完全忽略 `Range`**（无 `Range` / `bytes=0-1023` / `bytes=1000-` 三种请求都回 200 + 全量 2,046,090 字节）。后果是 `<video>` 不播、进度条拖不动。插件的做法是：上游类型是 `octet-stream` 时按扩展名改回 `video/mp4` 等，并自己按 `Range` 切片回 `206 + content-range`（越界 `416`）。
- 附件 id（`file-read-N`）会随时间换成别的文件，所以校验脚本里不把「是不是视频」当硬断言。

## 详情字段实测（2026-10）

用 `~/.dsh-zentao-workbench.json` 里已保存的 Token 只读核对过：

- `GET tasks?page=50`：列表里带 `storyID` / `storyTitle` / `storyStatus` / `storyVersion` / `latestStoryVersion`，**不带** `storySpec`（正文只在详情里）。
- `GET tasks/{id}`：任务挂在需求上时同时有 `storyID`、`storyTitle`、`storyStatus`、`latestStoryVersion`、`storySpec`、`storyVerify`；`assignedTo` 是对象，另有 `assignedToRealName`。
  - `storyID` 是**数字**，用只认字符串的取值函数会得到空串 —— 即使字段名找对了也拼不出链接。
  - 空 `desc` 是**空字符串**（不是 `null`），用 `??` 兜底会选中空串，把 `bugSteps` 里的重现步骤吞掉。
- `GET stories/{id}`：`spec` 就是任务里的 `storySpec`，另有 `verify`、`productName`、`moduleTitle`、`category`、`stage`、`reviewers`。
- 结论：「任务 → 研发需求」这条链路**不需要额外请求**，详情一次带回来，宿主拆成 `sections` + `story` + `meta` 即可（省一次往返，也避免因需求权限不同而取不到）。
