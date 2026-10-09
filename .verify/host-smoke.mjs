/**
 * 宿主半侧离线冒烟测试。
 *
 * 目的：在没有 DSH 运行时的前提下，用 mock ctx + mock fetch 跑通 apply()、
 * RPC 端点与 zentao 工具的完整逻辑，抓出注册期异常与取数/渲染错误。
 *
 * 运行：node host-smoke.mjs
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 让插件把配置写到临时目录，避免污染真实的 ~/.dsh-zentao-workbench.json。
// 必须在 import 插件之前设置，所以这里用动态 import。
const configDir = mkdtempSync(join(tmpdir(), 'dzw-smoke-'));
process.env.DSH_ZENTAO_WORKBENCH_CONFIG = join(configDir, 'config.json');
// 「用默认程序打开」会把附件下载到本机再交给 opener；测试里换成 node 自己（不会弹窗），
// 落盘目录也指到临时目录，跑完删掉。
const openDir = mkdtempSync(join(tmpdir(), 'dzw-open-'));
process.env.DSH_ZENTAO_WORKBENCH_OPEN_DIR = openDir;
process.env.DSH_ZENTAO_WORKBENCH_OPENER = process.execPath;

const { apply, name: pluginName, inject: pluginInject } = await import('../lib/index.js');

let failures = 0;
let checks = 0;
function ok(label, condition, extra) {
  checks += 1;
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${extra === undefined ? '' : ` -> ${String(extra)}`}`);
  }
}

// ---------------------------------------------------------------------------
// mock 禅道后端
// ---------------------------------------------------------------------------

const TASKS = {
  tasks: [
    // 真实实例的 `assignedTo` 是对象；这里故意混着「对象」和「裸账号字符串」两种形状。
    {
      id: 11,
      title: '修复登录超时',
      status: 'doing',
      assignedTo: { id: 7, account: 'zhangsan', realname: '张三' },
      assignedToRealName: '张三',
      openedBy: 'lisi',
      deadline: '2026-07-01',
      pri: 2,
    },
    { id: 12, title: '优化导出', status: 'wait', assignedTo: 'zhangsan', openedBy: 'lisi' },
  ],
};
const PRODUCTS = { products: [{ id: 1, name: '产品甲' }, { id: 2, name: '产品乙' }] };
const BUGS = {
  // 真实实例的 `assignedTo` 是对象（`{id,account,realname}`）+ 顶层 `assignedToRealName`，
  // 早期 `asString(对象)` 会收窄成空串，导致「指派给我的」过滤形同虚设。
  1: {
    bugs: [
      {
        id: 101,
        title: '列表页崩溃',
        status: 'active',
        assignedTo: { id: 7, account: 'zhangsan', realname: '张三' },
        assignedToRealName: '张三',
        product: 1,
      },
      // 未指派（assignedTo 为空）不能算「指派给我」——实测禅道里大量需求都是这种状态。
      { id: 103, title: '未指派的 Bug', status: 'active', assignedTo: '', product: 1 },
    ],
  },
  2: {
    bugs: [
      {
        id: 102,
        title: '别人名下的 Bug',
        status: 'active',
        assignedTo: { id: 9, account: 'wangwu', realname: '王五' },
        assignedToRealName: '王五',
        product: 2,
      },
    ],
  },
};
const STORIES = {
  1: {
    stories: [
      { id: 201, title: '支持批量导入', status: 'reviewing', assignedTo: 'zhangsan', product: 1 },
      // 60 条未指派需求混进「指派给我」是线上真实报障，这里固定成回归样例。
      { id: 202, title: '未指派的需求', status: 'reviewing', assignedTo: '', product: 1 },
      { id: 203, title: '别人名下的需求', status: 'reviewing', assignedTo: 'wangwu', product: 1 },
    ],
  },
  2: { stories: [] },
};

/**
 * 「处理」→ 任务置为开始 的状态表：id → 禅道侧当前状态。
 * 真实实例实测（2026-10）：`POST tasks/{id}/start` 路由存在，但**恒返回 200 + 空响应体**，
 * 所以宿主只能回读 `GET tasks/{id}` 的 status 来判断是否真的开始了。
 */
const TASK_START = { 5001: 'wait', 5002: 'doing', 5003: 'done', 5004: 'wait' };
/** POST /tasks/{id}/start 的请求体，用于断言不让禅道把工时覆盖成 0。 */
const startBodies = [];

/**
 * 「完成」→ 任务置为完成 的状态表：id → 禅道侧当前状态。
 * 真实实例实测（2026-10）：`POST tasks/{id}/finish` 必填 `realStarted` + `finishedDate`
 * （缺任一项都是 400 + `{"error":"『实际开始/实际完成』不能为空。"}`），成功也是 **200 + 空响应体**。
 * 6002 模拟「禅道收下请求但状态没变」（没权限 / 状态不允许），同样回 200 空体。
 */
const TASK_FINISH = { 6001: 'wait', 6002: 'wait', 6003: 'wait' };
/** 累计耗时表（finish 成功后累加本次耗时，模拟禅道回读结果）。 */
const TASK_CONSUMED = { 6001: 3, 6002: 3, 6003: 3 };
/** 实际完成日期表（finish 成功后写入）。 */
const TASK_FINISHED = {};
/** POST /tasks/{id}/finish 的请求体。 */
const finishBodies = [];
/** PUT /tasks/{id} 的请求体（指派）。 */
const assignBodies = [];
/** 指派后的账号表：id → account（PUT 成功后更新）。 */
const TASK_OWNER = { 6001: 'zhangsan', 6002: 'zhangsan', 6003: 'zhangsan' };

/** 被 mock 的请求记录，用于断言 URL/方法/头。 */
const seen = [];

/** 扫描类请求的模拟延迟（ms）：见 fetch mock 里 products/{id}/bugs|stories 分支。 */
const scanDelayMs = 15;

globalThis.fetch = async (url, init = {}) => {
  const parsed = new URL(url);
  // 路由判定只看 pathname；query 单独记录（禅道用 ?page=N 表示每页数量）。
  const route = parsed.pathname.replace(/^.*\/api\.php\/v1\//, '');
  const path = route;
  seen.push({ path: route + parsed.search, method: init.method ?? 'GET', token: init.headers?.Token });

  /** 构造 fetch Response 替身（附件代理分支会读 headers / arrayBuffer）。 */
  const respond = (status, body, options = {}) => {
    const headers = options.headers ?? {};
    const buffer =
      typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), 'utf8');
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
      text: async () => buffer.toString('utf8'),
      arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    };
  };

  if (path === 'tokens') {
    const body = JSON.parse(init.body);
    // 形态对齐真实实例：{"error":"登录失败，请检查您的用户名或密码是否填写正确。"}
    if (body.account !== 'zhangsan' || body.password !== 'secret') {
      return respond(400, { error: '登录失败，请检查您的用户名或密码是否填写正确。' });
    }
    return respond(200, { token: 'TOKEN-XYZ' });
  }
  if (path === 'user') {
    // 真实实例缺 Token 时是 HTTP 401 + {"error":"Unauthorized"}
    if (init.headers?.Token !== 'TOKEN-XYZ') return respond(401, { error: 'Unauthorized' });
    return respond(200, { user: { id: 7, account: 'zhangsan', realname: '张三' } });
  }
  if (path === 'tasks') return respond(200, TASKS);
  if (path === 'products') return respond(200, PRODUCTS);
  const bug = /^products\/(\d)\/bugs/.exec(path);
  // 真实实例每个请求 ~230 ms 且被串行化；这里给扫描请求加一点延迟，
  // 才测得出「渐进返回」这条路径（否则 mock 瞬间跑完，首包就已经是全量了）。
  if (bug) {
    await new Promise((resolve) => setTimeout(resolve, scanDelayMs));
    return respond(200, BUGS[bug[1]]);
  }
  const story = /^products\/(\d)\/stories/.exec(path);
  if (story) {
    await new Promise((resolve) => setTimeout(resolve, scanDelayMs));
    return respond(200, STORIES[story[1]]);
  }
  // ---- 「处理」→ 任务置为开始 ----------------------------------------------
  const startAction = /^tasks\/(\d+)\/start$/.exec(path);
  if (startAction !== undefined && startAction !== null && init.method === 'POST') {
    startBodies.push(typeof init.body === 'string' ? JSON.parse(init.body) : init.body);
    // 5004 模拟「禅道收了请求但状态没变」（例如没有开始权限）：响应同样是 200 空体。
    if (startAction[1] !== '5004' && TASK_START[startAction[1]] !== undefined) TASK_START[startAction[1]] = 'doing';
    // 真实实例行为：200 + 空响应体（看不出成败）。
    return respond(200, '');
  }
  // ---- 「完成」→ POST tasks/{id}/finish ------------------------------------
  const finishAction = /^tasks\/(\d+)\/finish$/.exec(path);
  if (finishAction !== null && init.method === 'POST') {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : (init.body ?? {});
    finishBodies.push({ id: finishAction[1], body });
    // 真实实例的必填校验顺序：先「实际开始」再「实际完成」。
    if (body.realStarted === undefined || body.realStarted === '') return respond(400, { error: '『实际开始』不能为空。' });
    if (body.finishedDate === undefined || body.finishedDate === '') return respond(400, { error: '『实际完成』不能为空。' });
    // 真实实例：禅道把本次耗时累加进 consumed，并把 finishedDate 落库。
    TASK_CONSUMED[finishAction[1]] = (TASK_CONSUMED[finishAction[1]] ?? 3) + Number(body.currentConsumed ?? 0);
    TASK_FINISHED[finishAction[1]] = body.finishedDate;
    // 6002 模拟「禅道收下请求但状态没变」：响应同样是 200 空体。
    if (finishAction[1] !== '6002' && TASK_FINISH[finishAction[1]] !== undefined) TASK_FINISH[finishAction[1]] = 'done';
    return respond(200, '');
  }
  // ---- 「指派」→ PUT tasks/{id}（真实实例返回更新后的**完整**任务对象） ------
  const taskView = /^tasks\/(\d+)$/.exec(path);
  if (taskView !== null && init.method === 'PUT') {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : (init.body ?? {});
    assignBodies.push({ id: taskView[1], body });
    const account = typeof body.assignedTo === 'string' ? body.assignedTo : '';
    if (account === '') return respond(400, { error: '『指派给』不能为空。' });
    // ghost 模拟「禅道 200 但没有改变指派人」（账号不存在 / 权限不足），响应体为空 → 宿主回读兜底。
    if (account === 'ghost') return respond(200, {});
    TASK_OWNER[taskView[1]] = account;
    const realname = account === 'lisi' ? '李四' : account === 'zhangsan' ? '张三' : account;
    return respond(200, {
      task: {
        id: Number(taskView[1]),
        name: `指派测试任务 ${taskView[1]}`,
        // 禅道把未开始的任务指派给别人时会顺手激活成 doing（6003 例外，模拟状态不变）。
        status: taskView[1] === '6003' ? 'wait' : 'doing',
        assignedTo: { id: 9, account, avatar: '', realname },
        assignedToRealName: realname,
        estimate: 2,
        consumed: 0,
        left: 2,
        deadline: '2026-11-01',
      },
    });
  }
  // ---- 成员列表（users 的 limit 有效，与 tasks 的 page 不同） ---------------
  if (path === 'users') {
    return respond(200, {
      page: 1,
      total: 2,
      limit: 100,
      users: [
        { id: 9, account: 'lisi', realname: '李四', role: 'dev' },
        { id: 7, account: 'zhangsan', realname: '张三', role: 'dev' },
      ],
    });
  }
  if (taskView !== null && (TASK_START[taskView[1]] !== undefined || TASK_FINISH[taskView[1]] !== undefined)) {
    const id = taskView[1];
    const account = TASK_OWNER[id] ?? 'zhangsan';
    return respond(200, {
      task: {
        id: Number(id),
        title: `开始测试任务 ${id}`,
        name: `开始测试任务 ${id}`,
        status: TASK_FINISH[id] ?? TASK_START[id],
        consumed: TASK_CONSUMED[id] ?? 3,
        left: 7,
        finishedDate: TASK_FINISHED[id] ?? '',
        realStarted: null,
        assignedTo: { id: 7, account, realname: account === 'lisi' ? '李四' : '张三' },
        assignedToRealName: account === 'lisi' ? '李四' : '张三',
      },
    });
  }
  if (path === 'tasks/99') {
    // 真实实例：Token 失效时 HTTP 401 + {"error":"Unauthorized"}
    return respond(401, { error: 'Unauthorized' });
  }
  if (path === 'tasks/11') {
    // 形态一：单数键包裹
    return respond(200, {
      task: {
        id: 11,
        title: '修复登录超时',
        status: 'doing',
        assignedTo: 'zhangsan',
        openedBy: 'lisi',
        desc: '<p>登录接口<br/>偶发 15s 超时</p>',
        actions: [
          { actor: 'lisi', date: '2026-06-20 10:00:00', action: 'opened', comment: '<b>线上问题</b>' },
          { actor: 'zhangsan', date: '2026-06-21 09:00:00', action: 'commented', comment: '已定位到连接池' },
        ],
      },
    });
  }
  if (path === 'tasks/10004') {
    // 真实实例形态（2026-06 实测）：标题字段是 name、desc 是**空字符串**、正文与附件都在 bugSteps 里、
    // 附件是正文内嵌的 <img src="/zentao/file-read-*.png">，files 数组为空。
    return respond(200, {
      task: {
        id: 10004,
        name: '客户端偶发白屏',
        status: 'doing',
        assignedTo: 'zhangsan',
        openedBy: 'lisi',
        desc: '',
        bugSteps: '<p>复现步骤：打开页面即白屏</p><p><img src="/zentao/file-read-31002.png"></p>',
        files: [],
        actions: [],
      },
    });
  }
  if (path === 'tasks/10002') {
    // 真机形态（2026-10 实测，任务 #10002）：`desc` 为空，但任务挂在一条研发需求上 ——
    // `storyID` / `storyTitle` / `storyStatus` / `storySpec`（需求描述）/ `storyVerify`，
    // 需求正文里还内嵌了截图。早期实现完全没取这些字段，弹窗里就「有内容却看不到」。
    return respond(200, {
      task: {
        id: 10002,
        name: '【示例】APS 提示词改为正常沟通的术语',
        status: 'wait',
        assignedTo: { id: 55, account: 'zhaoliu', realname: '赵六' },
        assignedToRealName: '赵六',
        openedBy: { id: 9, account: 'xiaoxy', realname: '肖潇雨' },
        openedByRealName: '肖潇雨',
        desc: '',
        storyID: 2001,
        storyTitle: '【示例】APS 提示词改为正常沟通的术语',
        storyStatus: 'active',
        storyVersion: 1,
        latestStoryVersion: 1,
        storySpec: '<p>1.先导一份当前 aps 的提示词</p><p><img src="/zentao/file-read-31003.png"></p>',
        storyVerify: '<p>替换后术语正常</p>',
        executionName: '示例执行',
        moduleTitle: '/',
        type: 'devel',
        pri: 1,
        estimate: 1,
        consumed: 0,
        left: 1,
        estStarted: '2026-09-17',
        deadline: '2026-09-17',
        delay: 21,
        files: [],
        actions: [],
      },
    });
  }
  if (path === 'bugs/101') {
    // 形态二：data 包裹 + 单数键
    return respond(200, { data: { bug: { id: 101, title: '列表页崩溃', steps: '<div>点击筛选即白屏</div>' } } });
  }
  if (path === 'stories/201') {
    // 形态三：data 直接就是实体
    return respond(200, { data: { id: 201, title: '支持批量导入', spec: '<p>需要支持 xlsx</p>' } });
  }
  // ---- 附件直链（宿主代理分支会来取） -------------------------------------
  if (path === '/zentao/file-read-31001.mp4') {
    // 真机形态（任务 #10001 的 mp4）：只给 content-type: application/octet-stream，
    // 没有 content-length / accept-ranges，并且完全忽略 Range（三种 Range 都回 200 全量）。
    if (init.headers?.Token !== 'TOKEN-XYZ') {
      return respond(200, '<html>请先登录</html>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    // 用可打印字节（0x2a = '*'）填充，res.body 的字符串长度才等于字节数，便于断言切片边界。
    const mp4 = Buffer.alloc(2048, 0x2a);
    return respond(200, mp4, { headers: { 'content-type': 'application/octet-stream' } });
  }
  if (path.startsWith('/zentao/file-read-')) {
    if (init.headers?.Token !== 'TOKEN-XYZ') {
      // 真实实例行为：没有 Token 头时是 HTTP 200 + 登录页 HTML，浏览器 <img> 只会显示坏图。
      return respond(200, '<html>请先登录</html>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    if (path.endsWith('.docx')) {
      // Word 附件：禅道回的是 octet-stream，宿主只需要「拿到字节」。
      const docx = Buffer.alloc(64, 0x41);
      return respond(200, docx, { headers: { 'content-type': 'application/octet-stream' } });
    }
    if (path.endsWith('.exe')) {
      // 可执行文件：宿主必须按白名单拒绝，绝不能下载后交给系统打开。
      const exe = Buffer.from([0x4d, 0x5a, 0x90, 0x00]);
      return respond(200, exe, { headers: { 'content-type': 'application/octet-stream' } });
    }
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02]);
    return respond(200, png, { headers: { 'content-type': 'image/png', 'content-length': String(png.length) } });
  }
  if (path.startsWith('/zentao/huge-')) {
    // content-length 超上限：宿主应在读取前就拒绝。
    return respond(200, Buffer.alloc(0), {
      headers: { 'content-type': 'application/octet-stream', 'content-length': String(65 * 1024 * 1024) },
    });
  }
  return respond(404, { status: 'fail', message: `no route: ${path}` });
};

// ---------------------------------------------------------------------------
// mock ctx
// ---------------------------------------------------------------------------

const registered = {
  rpcMethod: undefined,
  rpcHandler: undefined,
  rpcRoute: undefined,
  tool: undefined,
  effects: 0,
  effectLabel: undefined,
  webServerRoutes: [],
  injectCalls: [],
  reflectGets: [],
};

/**
 * 假的 llm 服务（AI 预判用）。`undefined` 表示当前实例没有暴露模型服务。
 * 插件读服务走 `ctx.reflect.get('llm')` —— cordis 的 ReflectService 注释原文是
 * 「Read a service from the store without the inject requirement」，不需要写进 inject，
 * 取不到时返回 undefined，所以这里用 Proxy 之外的普通属性复刻即可。
 */
let llmMock;

/**
 * 假的 DSH 默认模型选择服务（`@deepseek-ai/dsh-agent-default-model` 注册为 `agentDefaultModel`，
 * 读法是 `currentSelection()`）。`undefined` 表示 profile 里没装这个包。
 */
let dshModelMock;

/**
 * 忠实复刻 Cordis 的服务可见性规则：
 *
 *  - 只有「注入过」的服务才能从 ctx 读到，否则抛真实报错原文
 *    `cannot get property "<name>" without inject`；
 *  - `ctx.inject(deps, cb)` 派生一个「额外注入 deps」的子上下文并回调；
 *  - 本插件**不再使用 `ctx.connection.rpc`**：那条路径里
 *    `register(owner, channel, handler)` 的 `owner = this.ctx`（Service 的 ctx tracker，
 *    `noShadow: true`）会跳过 ctx.inject 派生的影子上下文，解析回本插件行自己的 fiber，
 *    那里没有 webServer，必然抛 `cannot get property "webServer" without inject`
 *    → apply 抛错 → 插件被跳过 → 界面里的表现是 `HTTP 405`。
 *    所以这里让读 `connection` 直接抛错，一旦代码回退到老写法，冒烟会立刻失败。
 */
function makeCtx(injected) {
  const target = {
    effect(fn, label) {
      registered.effects += 1;
      registered.effectLabel = label;
      return fn();
    },
    inject(deps, cb) {
      const list = Array.isArray(deps) ? deps : [deps];
      registered.injectCalls.push(list);
      return cb(makeCtx(new Set([...injected, ...list])));
    },
    tools: {
      register(tool) {
        registered.tool = tool;
        return () => {};
      },
    },
    reflect: {
      get(name) {
        registered.reflectGets.push(name);
        if (name === 'llm') return llmMock;
        if (name === 'agentDefaultModel') return dshModelMock;
        return undefined;
      },
    },
  };
  return new Proxy(target, {
    get(t, prop) {
      if (prop === 'webServer') {
        if (!injected.has('webServer')) {
          throw new Error('cannot get property "webServer" without inject');
        }
        return {
          register(route) {
            registered.webServerRoutes.push(route);
            return () => {};
          },
        };
      }
      if (prop === 'connection') {
        throw new Error('cannot get property "connection" without inject');
      }
      return Reflect.get(t, prop);
    },
  });
}

/** 造一个最小的 IncomingMessage 替身（serveRpc 只用到 method/url/headers/on/destroy）。 */
function makeReq({ endpoint, method = 'POST', body = '', headers = {}, chunked = false }) {
  let flushed = false;
  return {
    method,
    url: `/zentao-workbench${endpoint === '' ? '' : `/${endpoint}`}`,
    headers: { 'content-type': 'application/json', host: '127.0.0.1:19399', ...headers },
    destroyed: false,
    destroy() {
      this.destroyed = true;
    },
    on(event, fn) {
      if (event === 'end' && !flushed) {
        flushed = true;
        setImmediate(() => {
          const payload = Buffer.from(body, 'utf8');
          const chunks = chunked && payload.length > 1 ? [payload.subarray(0, 1), payload.subarray(1)] : [payload];
          for (const chunk of chunks) {
            if (this.destroyed) return;
            for (const listener of this._data) listener(chunk);
          }
          if (this.destroyed) return;
          for (const listener of this._end) listener();
        });
      }
      if (event === 'data') this._data.push(fn);
      if (event === 'end') this._end.push(fn);
      return this;
    },
    _data: [],
    _end: [],
  };
}

/** 造一个最小的 ServerResponse 替身。 */
function makeRes() {
  let settle;
  const done = new Promise((resolve) => {
    settle = resolve;
  });
  const res = {
    status: undefined,
    headers: undefined,
    body: '',
    done,
    writeHead(status, headers) {
      res.status = status;
      res.headers = headers;
      return res;
    },
    end(chunk) {
      res.body += chunk ?? '';
      settle({ status: res.status, headers: res.headers, body: res.body });
    },
  };
  return res;
}

/** 真正走一遍 HTTP handler（serveRpc），返回 `{status, headers, body}`。 */
async function invokeRpc(endpoint, options = {}) {
  const route = registered.webServerRoutes.find((r) => r.kind === 'prefix' && r.path === '/zentao-workbench');
  if (route === undefined) throw new Error('RPC 路由没注册到 webServer');
  const req = makeReq({
    endpoint,
    method: options.method,
    body: options.body === undefined ? JSON.stringify(options.payload ?? {}) : options.body,
    headers: options.headers,
    chunked: options.chunked,
  });
  const res = makeRes();
  await route.handler(req, res);
  return res.done;
}

const ctx = makeCtx(new Set(pluginInject));

console.log('== 1. apply() 注册期 ==');
let applyError;
try {
  apply(ctx);
} catch (error) {
  applyError = error;
}
ok('apply() 不抛异常', applyError === undefined, applyError);
ok('插件名正确', pluginName === 'zentao-workbench', pluginName);
ok('inject 只有 tools（不再依赖 connection）', JSON.stringify(pluginInject) === JSON.stringify(['tools']), JSON.stringify(pluginInject));
ok(
  "经 ctx.inject(['webServer'], …) 注册 RPC 路由",
  registered.injectCalls.some((deps) => deps.includes('webServer')),
  `injectCalls=${JSON.stringify(registered.injectCalls)}；不走 connection.rpc（它的 owner 会跳过影子上下文），否则界面里表现为 HTTP 405`,
);
ok('注册了 1 个 effect（RPC 路由）', registered.effects >= 1, registered.effects);
ok(
  'RPC 前缀路由已登记到 webServer',
  registered.webServerRoutes.length === 1
    && registered.webServerRoutes[0].kind === 'prefix'
    && registered.webServerRoutes[0].path === '/zentao-workbench'
    && typeof registered.webServerRoutes[0].handler === 'function',
  JSON.stringify(registered.webServerRoutes.map((r) => `${r.kind}:${r.path}:${typeof r.handler}`)),
);
ok('注册了 zentao 工具', registered.tool !== undefined && registered.tool.name === 'zentao');
ok('工具 output.render 是函数', typeof registered.tool?.output?.render === 'function');
ok('工具 output.schema 是 object 根', registered.tool?.output?.schema?.type === 'object');
ok(
  '工具 output.schema 只用受支持子集关键字',
  JSON.stringify(Object.keys(registered.tool.output.schema).sort()) === JSON.stringify(['additionalProperties', 'properties', 'required', 'type']),
  Object.keys(registered.tool.output.schema).join(','),
);
ok('工具 parameters 是合法 JSON 快照', (() => { try { JSON.parse(JSON.stringify(registered.tool.parameters)); return true; } catch { return false; } })());

// ---------------------------------------------------------------------------
console.log('\n== 2. 传输层：POST /zentao-workbench/<endpoint> ==');

const notPost = await invokeRpc('getConfig', { method: 'GET' });
ok('非 POST → 405', notPost.status === 405 && JSON.parse(notPost.body).error.code === 'method-not-allowed', `${notPost.status} ${notPost.body}`);

const crossSite = await invokeRpc('getConfig', { headers: { origin: 'http://evil.example', host: '127.0.0.1:19399' } });
ok('跨站 Origin → 403', crossSite.status === 403 && JSON.parse(crossSite.body).error.code === 'forbidden', `${crossSite.status} ${crossSite.body}`);

const sameSite = await invokeRpc('getConfig', { headers: { origin: 'http://127.0.0.1:19399', 'sec-fetch-site': 'same-origin' } });
ok('同源 Origin 放行', sameSite.status === 200, `${sameSite.status} ${sameSite.body}`);

const badType = await invokeRpc('getConfig', { headers: { 'content-type': 'text/plain' } });
ok('content-type 非 JSON → 415', badType.status === 415, `${badType.status} ${badType.body}`);

const noEndpoint = await invokeRpc('', { headers: { 'content-type': 'application/json' } });
ok('缺端点名 → 400', noEndpoint.status === 400 && JSON.parse(noEndpoint.body).error.code === 'bad-request', `${noEndpoint.status} ${noEndpoint.body}`);

const badJson = await invokeRpc('getConfig', { body: '{oops' });
ok('请求体不是 JSON → 400', badJson.status === 400 && JSON.parse(badJson.body).error.message.includes('合法 JSON'), `${badJson.status} ${badJson.body}`);

const tooBig = await invokeRpc('getConfig', { body: JSON.stringify({ pad: 'x'.repeat(70 * 1024) }), chunked: true });
ok('请求体超上限 → 413', tooBig.status === 413 && JSON.parse(tooBig.body).error.code === 'payload-too-large', `${tooBig.status} ${tooBig.body}`);

ok('响应带 no-store 缓存头', sameSite.headers?.['cache-control'] === 'no-store', JSON.stringify(sameSite.headers));

// ---------------------------------------------------------------------------
console.log('\n== 3. RPC：未登录保护 ==');
const call = async (endpoint, payload) => {
  const result = await invokeRpc(endpoint, { payload: payload ?? {} });
  if (result.status !== 200) throw new Error(`HTTP ${result.status}：${result.body}`);
  return JSON.parse(result.body);
};

const cfg0 = await call('getConfig');
ok('getConfig 返回 ok', cfg0.ok === true, JSON.stringify(cfg0));
ok('getConfig 不带 token 字段', cfg0.value !== undefined && !('token' in cfg0.value), JSON.stringify(cfg0.value));
ok('getConfig.hasToken=false', cfg0.value.hasToken === false);

const refresh0 = await call('refresh', { scope: 'all' });
ok('未登录 refresh 失败', refresh0.ok === false, JSON.stringify(refresh0));
ok('未登录 refresh 有明确中文提示', typeof refresh0.error?.message === 'string' && refresh0.error.message.includes('未登录'), refresh0.error?.message);

const detailBad = await call('fetchDetail', { kind: 'task', id: '1' });
ok('未登录时 fetchDetail 被拒', detailBad.ok === false && detailBad.error.message.includes('未登录'), JSON.stringify(detailBad));

const unknown = await call('whatever', {});
ok('未知端点返回失败而不是抛错', unknown.ok === false && unknown.error.message.includes('未知操作'), JSON.stringify(unknown));

// ---------------------------------------------------------------------------
console.log('\n== 4. RPC：登录 ==');
const loginBad = await call('login', { server: 'http://zentao.example.com:11180/zentao/', account: 'zhangsan', password: 'wrong' });
ok('错误密码返回失败', loginBad.ok === false, JSON.stringify(loginBad));
ok('错误密码提示取自禅道 error 字段', typeof loginBad.error?.message === 'string' && loginBad.error.message.includes('登录失败，请检查'), loginBad.error?.message);
ok('URL 归一化去掉了 /api.php/v1 与尾斜杠', seen.some((entry) => entry.path.startsWith('tokens')) && seen[0].path === 'tokens', JSON.stringify(seen.slice(0, 2)));

const loginOk = await call('login', {
  server: 'http://zentao.example.com:11180/zentao/api.php/v1/',
  account: 'zhangsan',
  password: 'secret',
  role: 'dev',
  rememberToken: false,
});
ok('登录成功', loginOk.ok === true, JSON.stringify(loginOk));
ok('登录后返回 realname', loginOk.value?.realname === '张三', JSON.stringify(loginOk.value));
ok('登录后 hasToken=true', loginOk.value?.hasToken === true);
ok('未勾选记住 Token 时不落盘', loginOk.value?.rememberToken === false);

// ---------------------------------------------------------------------------
console.log('\n== 5. RPC：refresh（任务 + Bug + 需求聚合） ==');

/** 轮询把所有后台扫描跑完；返回按类别归并后的结果（模拟浏览器的增量轮询）。 */
async function settleScans(snapshot) {
  const out = { bugs: [...(snapshot.value?.bugs ?? [])], stories: [...(snapshot.value?.stories ?? [])], polls: 0, finalProgress: undefined };
  for (const job of snapshot.value?.jobs ?? []) {
    for (let i = 0; i < 400; i += 1) {
      const progress = await call('scanProgress', { jobId: job.id });
      out.polls += 1;
      if (progress.ok !== true) break;
      if (job.kind === 'bugs') out.bugs = progress.value?.bugs ?? [];
      else out.stories = progress.value?.stories ?? [];
      if (progress.value?.finished === true) {
        out.finalProgress = progress.value;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  return out;
}

const snapshot = await call('refresh', { scope: 'all' });
ok('refresh 成功', snapshot.ok === true, JSON.stringify(snapshot).slice(0, 300));
ok('任务 2 条', snapshot.value?.tasks?.length === 2, snapshot.value?.tasks?.length);
ok('回带 taskTotal（用于提示「仅显示前 N 条」）', snapshot.value?.taskTotal === 2, JSON.stringify(snapshot.value?.taskTotal));
ok(
  'Bug/需求走渐进扫描：立刻返回 2 个后台任务而不是干等',
  Array.isArray(snapshot.value?.jobs) && snapshot.value.jobs.length === 2 && snapshot.value.jobs.every((job) => typeof job.id === 'string' && job.total === 2),
  JSON.stringify(snapshot.value?.jobs),
);
ok(
  '渐进首包不含尚未扫到的条目（不是假装扫完了）',
  (snapshot.value?.bugs ?? []).length === 0 && (snapshot.value?.stories ?? []).length === 0,
  JSON.stringify({ bugs: snapshot.value?.bugs?.length, stories: snapshot.value?.stories?.length }),
);
const settled = await settleScans(snapshot);
ok('轮询到扫描完成', settled.finalProgress?.finished === true, JSON.stringify(settled.finalProgress));
ok(
  '扫描完成后 Bug 只保留指派给我的（滤掉 wangwu 与未指派）',
  JSON.stringify(settled.bugs.map((item) => String(item.id))) === JSON.stringify(['101']),
  JSON.stringify(settled.bugs),
);
ok(
  '扫描完成后需求只保留指派给我的（滤掉未指派与 wangwu）',
  JSON.stringify(settled.stories.map((item) => String(item.id))) === JSON.stringify(['201']),
  JSON.stringify(settled.stories),
);
// mock 后端按 11 → 12 的升序返回，宿主必须倒序成 12 → 11。
ok(
  '任务按 ID 倒序（12 → 11）',
  JSON.stringify(snapshot.value?.tasks?.map((item) => String(item.id))) === JSON.stringify(['12', '11']),
  JSON.stringify(snapshot.value?.tasks?.map((item) => item.id)),
);
ok('scan 记录扫描产品数', snapshot.value?.scan?.scannedProducts === 2 && snapshot.value.scan.totalProducts === 2, JSON.stringify(snapshot.value?.scan));
ok('tasks 请求带了 page 参数（该实例不传只返回 1 条）', seen.some((entry) => entry.path.startsWith('tasks?page=')), JSON.stringify(seen.filter((e) => e.path.startsWith('tasks')).slice(0, 3)));
ok('后续请求都带了 Token 头', seen.filter((entry) => entry.path !== 'tokens').every((entry) => entry.token === 'TOKEN-XYZ'));

const onlyTasks = await call('refresh', { scope: 'tasks' });
ok('scope=tasks 不拉 Bug/需求', onlyTasks.value?.bugs?.length === 0 && onlyTasks.value?.stories?.length === 0);
ok('scope=tasks 回带 scopes 只有 tasks', JSON.stringify(onlyTasks.value?.scopes) === JSON.stringify(['tasks']), JSON.stringify(onlyTasks.value?.scopes));
ok('scope=tasks 不启动后台扫描', (onlyTasks.value?.jobs ?? []).length === 0, JSON.stringify(onlyTasks.value?.jobs));

// ---- 按类别取数 + 短时缓存（性能改造） --------------------------------------
const beforeBugs = seen.filter((entry) => /\/bugs\?/.test(entry.path)).length;
const onlyBugs = await call('refresh', { scope: 'bugs', force: true });
const afterBugs = seen.filter((entry) => /\/bugs\?/.test(entry.path)).length;
const bugsSettled = await settleScans(onlyBugs);
ok('scope=bugs 只扫 Bug（不扫需求）', afterBugs > beforeBugs && bugsSettled.bugs.length === 1 && bugsSettled.stories.length === 0, JSON.stringify({ bugs: bugsSettled.bugs.length, stories: bugsSettled.stories.length }));
ok('scope=bugs 回带 scopes=[tasks,bugs]', JSON.stringify(onlyBugs.value?.scopes) === JSON.stringify(['tasks', 'bugs']), JSON.stringify(onlyBugs.value?.scopes));
const beforeStories = seen.filter((entry) => /\/stories\?/.test(entry.path)).length;
const onlyStories = await call('refresh', { scope: 'stories', force: true });
const afterStories = seen.filter((entry) => /\/stories\?/.test(entry.path)).length;
const storiesSettled = await settleScans(onlyStories);
ok('scope=stories 只扫需求（不扫 Bug）', afterStories > beforeStories && storiesSettled.stories.length === 1 && storiesSettled.bugs.length === 0, JSON.stringify({ bugs: storiesSettled.bugs.length, stories: storiesSettled.stories.length }));
ok('强制扫描只跑一次产品列表里的该类别（2 个产品 → 2 次请求）', afterBugs - beforeBugs === 2 && afterStories - beforeStories === 2, JSON.stringify({ bug请求: afterBugs - beforeBugs, 需求请求: afterStories - beforeStories }));

const scanCallsBefore = seen.filter((entry) => /\/bugs\?|\/stories\?/.test(entry.path)).length;
const productsBefore = seen.filter((entry) => entry.path.startsWith('products?limit=')).length;
const cachedRun = await call('refresh', { scope: 'all' });
const scanCallsAfter = seen.filter((entry) => /\/bugs\?|\/stories\?/.test(entry.path)).length;
const productsAfter = seen.filter((entry) => entry.path.startsWith('products?limit=')).length;
ok(
  '2 分钟内的重复聚合直接命中缓存（0 个产品扫描请求、无后台任务）',
  scanCallsAfter - scanCallsBefore === 0 && productsAfter - productsBefore === 0 && cachedRun.value?.cached === true && (cachedRun.value?.jobs ?? []).length === 0,
  JSON.stringify({ 扫描请求: scanCallsAfter - scanCallsBefore, 产品请求: productsAfter - productsBefore, cached: cachedRun.value?.cached, jobs: cachedRun.value?.jobs?.length }),
);
ok('缓存命中仍返回完整结果', cachedRun.value?.bugs?.length === 1 && cachedRun.value?.stories?.length === 1 && cachedRun.value?.tasks?.length === 2, JSON.stringify({ bugs: cachedRun.value?.bugs?.length, stories: cachedRun.value?.stories?.length, tasks: cachedRun.value?.tasks?.length }));

const forcedProductsBefore = seen.filter((entry) => entry.path.startsWith('products?limit=')).length;
const forcedScanBefore = seen.filter((entry) => /\/bugs\?|\/stories\?/.test(entry.path)).length;
const forcedRun = await call('refresh', { scope: 'all', force: true });
const forcedProductsAfter = seen.filter((entry) => entry.path.startsWith('products?limit=')).length;
const forcedScanAfter = seen.filter((entry) => /\/bugs\?|\/stories\?/.test(entry.path)).length;
ok(
  'force=true 绕过缓存并只取一次产品列表（Bug/需求共用）',
  forcedProductsAfter - forcedProductsBefore === 1 && forcedScanAfter - forcedScanBefore === 4 && forcedRun.value?.cached === false,
  JSON.stringify({ 产品请求: forcedProductsAfter - forcedProductsBefore, 扫描请求: forcedScanAfter - forcedScanBefore, cached: forcedRun.value?.cached }),
);
const forcedSettled = await settleScans(forcedRun);
ok(
  '强制聚合（渐进轮询完成后）结果不变：任务 2 / Bug 1 / 需求 1',
  forcedRun.value?.tasks?.length === 2 && forcedSettled.bugs.length === 1 && forcedSettled.stories.length === 1,
  JSON.stringify({ tasks: forcedRun.value?.tasks?.length, bugs: forcedSettled.bugs.length, stories: forcedSettled.stories.length }),
);

// 登录后缓存必须作废（换账号不能吃上一个账号的聚合结果）。
const logoutForCache = await call('logout', {});
ok('logout 成功', logoutForCache.ok === true, JSON.stringify(logoutForCache));
const relogin = await call('login', { server: 'http://zentao.example.com:11180/zentao', account: 'zhangsan', password: 'secret' });
ok('重新登录成功', relogin.ok === true, JSON.stringify(relogin).slice(0, 200));
const cacheScanBefore = seen.filter((entry) => /\/bugs\?|\/stories\?/.test(entry.path)).length;
const afterLoginRun = await call('refresh', { scope: 'all' });
const cacheScanAfter = seen.filter((entry) => /\/bugs\?|\/stories\?/.test(entry.path)).length;
ok('重新登录后缓存已作废（必须重新扫描）', cacheScanAfter - cacheScanBefore === 4 && afterLoginRun.value?.cached === false, JSON.stringify({ 扫描请求: cacheScanAfter - cacheScanBefore, cached: afterLoginRun.value?.cached }));

ok(
  '状态给出中文标签（wait→未开始）',
  snapshot.value?.tasks?.some((task) => String(task.id) === '12' && task.statusLabel === '未开始'),
  JSON.stringify(snapshot.value?.tasks),
);

// ---------------------------------------------------------------------------
console.log('\n== 6. RPC：fetchDetail（三种响应形态） ==');
const badKind = await call('fetchDetail', { kind: 'nope', id: '1' });
ok('校验 kind', badKind.ok === false && badKind.error.message.includes('kind'), JSON.stringify(badKind));
const badId = await call('fetchDetail', { kind: 'task', id: '' });
ok('校验 id', badId.ok === false && badId.error.message.includes('id'), JSON.stringify(badId));

const detail = await call('fetchDetail', { kind: 'task', id: '11' });
ok('形态一 {task:{...}} 解析成功', detail.ok === true && detail.value?.title === '修复登录超时', JSON.stringify(detail).slice(0, 200));
ok('HTML 描述被转成纯文本', detail.value?.description === '登录接口\n偶发 15s 超时', JSON.stringify(detail.value?.description));
ok('历史动作去标签', detail.value?.actions?.[0]?.comment === '线上问题', JSON.stringify(detail.value?.actions));
ok(
  '历史动作给出中文标签（opened→创建、commented→备注）',
  detail.value?.actions?.[0]?.actionLabel === '创建' && detail.value?.actions?.[1]?.actionLabel === '备注',
  JSON.stringify(detail.value?.actions),
);
ok(
  '原始链接不重复拼接 /zentao',
  detail.value?.link === 'http://zentao.example.com:11180/zentao/task-view-11.html',
  detail.value?.link,
);

const bugDetail = await call('fetchDetail', { kind: 'bug', id: '101' });
ok('形态二 {data:{bug:{...}}} 解析成功', bugDetail.value?.title === '列表页崩溃', JSON.stringify(bugDetail.value).slice(0, 200));
ok('Bug 取 steps 作为描述', bugDetail.value?.description === '点击筛选即白屏', JSON.stringify(bugDetail.value?.description));

const storyDetail = await call('fetchDetail', { kind: 'story', id: '201' });
ok('形态三 {data:{...}} 解析成功', storyDetail.value?.title === '支持批量导入', JSON.stringify(storyDetail.value).slice(0, 200));
ok('需求取 spec 作为描述', storyDetail.value?.description === '需要支持 xlsx', JSON.stringify(storyDetail.value?.description));

const expired = await call('fetchDetail', { kind: 'task', id: '99' });
ok('Token 失效（HTTP 401）给出重新登录提示', expired.ok === false && expired.error.message.includes('登录状态已失效'), JSON.stringify(expired));

// 真实实例形态：空字符串 desc + 正文/附件都在 bugSteps 里
const realDetail = await call('fetchDetail', { kind: 'task', id: '10004' });
ok('标题回退到 name 字段', realDetail.value?.title === '客户端偶发白屏', JSON.stringify(realDetail.value?.title));
ok(
  '空字符串 desc 不再吞掉 bugSteps',
  typeof realDetail.value?.description === 'string' && realDetail.value.description.includes('复现步骤：打开页面即白屏'),
  JSON.stringify(realDetail.value?.description),
);
ok(
  '详情按字段给出 sections（带中文标签）',
  Array.isArray(realDetail.value?.sections) &&
    realDetail.value.sections.some((section) => section.label === '重现步骤' && section.text.includes('复现步骤')),
  JSON.stringify(realDetail.value?.sections),
);
ok(
  '附件从正文 <img> 抽成绝对地址',
  realDetail.value?.attachments?.[0]?.url === 'http://zentao.example.com:11180/zentao/file-read-31002.png',
  JSON.stringify(realDetail.value?.attachments),
);
ok('附件带文件名', realDetail.value?.attachments?.[0]?.name === 'file-read-31002.png', JSON.stringify(realDetail.value?.attachments));
ok(
  '附件带上宿主代理地址（直链在浏览器里只会拿到登录页）',
  realDetail.value?.attachments?.[0]?.proxyUrl ===
    `/zentao-workbench/attachment?url=${encodeURIComponent('http://zentao.example.com:11180/zentao/file-read-31002.png')}`,
  JSON.stringify(realDetail.value?.attachments?.[0]),
);

// 任务挂在研发需求上的形态：研发需求标题 / 状态 / 描述 / 验收标准 / 散字段都要出来
const storyLinked = await call('fetchDetail', { kind: 'task', id: '10002' });
ok(
  '任务的研发需求描述进 sections',
  Array.isArray(storyLinked.value?.sections) &&
    storyLinked.value.sections.some((section) => section.label === '研发需求描述' && section.text.includes('先导一份当前 aps 的提示词')),
  JSON.stringify(storyLinked.value?.sections),
);
ok(
  '任务的研发需求验收标准进 sections',
  Array.isArray(storyLinked.value?.sections) &&
    storyLinked.value.sections.some((section) => section.label === '研发需求验收标准' && section.text.includes('替换后术语正常')),
  JSON.stringify(storyLinked.value?.sections),
);
ok(
  '给出研发需求 id / 标题 / 中文状态 / 链接',
  storyLinked.value?.story?.id === '2001' &&
    storyLinked.value.story.title === '【示例】APS 提示词改为正常沟通的术语' &&
    storyLinked.value.story.statusLabel === '激活' &&
    storyLinked.value.story.link === 'http://zentao.example.com:11180/zentao/story-view-2001.html',
  JSON.stringify(storyLinked.value?.story),
);
ok(
  '研发需求正文里的截图也进附件（走宿主代理）',
  Array.isArray(storyLinked.value?.attachments) &&
    storyLinked.value.attachments.some(
      (file) =>
        file.url === 'http://zentao.example.com:11180/zentao/file-read-31003.png' &&
        file.proxyUrl === `/zentao-workbench/attachment?url=${encodeURIComponent('http://zentao.example.com:11180/zentao/file-read-31003.png')}`,
    ),
  JSON.stringify(storyLinked.value?.attachments),
);
const metaOf = (detailValue, label) => (Array.isArray(detailValue?.meta) ? detailValue.meta.find((row) => row.label === label)?.value : undefined);
ok(
  '散字段整理成 meta（执行 / 模块 / 类型中文化）',
  metaOf(storyLinked.value, '所属执行') === '示例执行' && metaOf(storyLinked.value, '模块') === '/' && metaOf(storyLinked.value, '类型') === '开发',
  JSON.stringify(storyLinked.value?.meta),
);
ok(
  '散字段整理成 meta（工时 / 时间 / 延期）',
  metaOf(storyLinked.value, '预计工时') === '1' &&
    metaOf(storyLinked.value, '已耗工时') === '0' &&
    metaOf(storyLinked.value, '剩余工时') === '1' &&
    metaOf(storyLinked.value, '计划开始') === '2026-09-17' &&
    metaOf(storyLinked.value, '延期（天）') === '21',
  JSON.stringify(storyLinked.value?.meta),
);
const detailTool = await registered.tool.execute({ action: 'detail', kind: 'task', id: '10002' }, { signal: undefined });
ok(
  '任务工具输出含研发需求与中文化类型',
  detailTool.content.includes('研发需求：#2001') && detailTool.content.includes('类型：开发'),
  detailTool.content.slice(0, 400),
);

// ---------------------------------------------------------------------------
console.log('\n== 7. zentao 工具 ==');
const exec = { signal: undefined };

const toolMine = await registered.tool.execute({ action: 'mine' }, exec);
ok('action=mine 返回 content', typeof toolMine.content === 'string' && toolMine.content.includes('禅道「指派给我」'));
ok('content 含任务与 Bug', toolMine.content.includes('#11') && toolMine.content.includes('#101'), toolMine.content.slice(0, 200));

const toolTasks = await registered.tool.execute({ action: 'tasks' }, exec);
ok('action=tasks 只含任务', toolTasks.content.includes('#11') && !toolTasks.content.includes('#101'));

const toolDetail = await registered.tool.execute({ action: 'detail', kind: 'task', id: '11' }, exec);
ok('action=detail 返回详情', toolDetail.content.includes('禅道任务 #11') && toolDetail.content.includes('原始链接'), toolDetail.content.slice(0, 200));

const toolReal = await registered.tool.execute({ action: 'detail', kind: 'task', id: '10004' }, exec);
ok(
  '工具文本含分段正文与附件地址',
  toolReal.content.includes('重现步骤：') && toolReal.content.includes('附件：') && toolReal.content.includes('http://zentao.example.com:11180/zentao/file-read-31002.png'),
  toolReal.content.slice(0, 400),
);

const toolBad = await registered.tool.execute({ action: 'detail', kind: 'task' }, exec);
ok('action=detail 缺 id 给出提示', toolBad.content.includes('需要同时提供'), toolBad.content);

const renderOut = registered.tool.output.render({ action: 'mine' }, toolMine);
ok('output.render 产出 text 块', Array.isArray(renderOut) && renderOut[0].type === 'text' && renderOut[0].text === toolMine.content);

// 退出登录后工具应提示未登录而不是抛错
await call('logout');
const toolLoggedOut = await registered.tool.execute({ action: 'mine' }, exec);
ok('退出后工具提示未登录', toolLoggedOut.content.includes('未登录'), toolLoggedOut.content);

console.log('\n== 8. 附件代理（GET /zentao-workbench/attachment） ==');
const ATTACHMENT = encodeURIComponent('http://zentao.example.com:11180/zentao/file-read-31002.png');
const sameSiteHeaders = { 'sec-fetch-site': 'same-origin' };

// 第 7 节末尾已登出，这里先验证未登录保护。
const anonymous = await invokeRpc(`attachment?url=${ATTACHMENT}`, { method: 'GET', headers: sameSiteHeaders });
ok('未登录时不代取附件 → 401', anonymous.status === 401, JSON.stringify(anonymous));

await call('login', {
  server: 'http://zentao.example.com:11180/zentao/',
  account: 'zhangsan',
  password: 'secret',
  rememberToken: false,
});

const proxied = await invokeRpc(`attachment?url=${ATTACHMENT}`, { method: 'GET', headers: sameSiteHeaders });
ok('代理图片返回 200 且 content-type 为 image/png', proxied.status === 200 && proxied.headers['content-type'] === 'image/png', JSON.stringify(proxied.headers));
ok('代理响应带 private 缓存头', String(proxied.headers['cache-control'] ?? '').includes('private'), JSON.stringify(proxied.headers));
ok('代理是带 Token 头回源（不是把裸直链丢给浏览器）', seen.some((entry) => entry.path === '/zentao/file-read-31002.png' && entry.token === 'TOKEN-XYZ'));

const noUrl = await invokeRpc('attachment', { method: 'GET', headers: sameSiteHeaders });
ok('缺 url 参数 → 400', noUrl.status === 400, JSON.stringify(noUrl));
const crossSiteAttachment = await invokeRpc(`attachment?url=${ATTACHMENT}`, {
  method: 'GET',
  headers: { origin: 'http://evil.example', host: '127.0.0.1:19399' },
});
ok('跨站 Origin → 403', crossSiteAttachment.status === 403, JSON.stringify(crossSiteAttachment));
const foreignOrigin = await invokeRpc(`attachment?url=${encodeURIComponent('http://evil.example/zentao/file-read-1.png')}`, {
  method: 'GET',
  headers: sameSiteHeaders,
});
ok('非当前禅道服务器的地址 → 403', foreignOrigin.status === 403, JSON.stringify(foreignOrigin));
const notAttachment = await invokeRpc(`attachment?url=${encodeURIComponent('http://zentao.example.com:11180/zentao/api.php/v1/tasks')}`, {
  method: 'GET',
  headers: sameSiteHeaders,
});
ok('同源但路径不像附件 → 403', notAttachment.status === 403, JSON.stringify(notAttachment));
const tooHuge = await invokeRpc(`attachment?url=${encodeURIComponent('http://zentao.example.com:11180/zentao/huge-file-read-1.bin')}`, {
  method: 'GET',
  headers: sameSiteHeaders,
});
ok('附件超过 64 MiB → 413', tooHuge.status === 413, JSON.stringify(tooHuge));

// ---- 视频（mp4）：content-type 改写 + Range 切片 ----------------------------
// 禅道对 mp4 直链回 application/octet-stream，浏览器 <video> 不会播；宿主按扩展名改回 video/mp4。
const MP4 = encodeURIComponent('http://zentao.example.com:11180/zentao/file-read-31001.mp4');

const wholeVideo = await invokeRpc(`attachment?url=${MP4}`, { method: 'GET', headers: sameSiteHeaders });
ok(
  'mp4 附件：上游给 application/octet-stream 时改回 video/mp4（否则 <video> 根本不播）',
  wholeVideo.status === 200 && wholeVideo.headers['content-type'] === 'video/mp4',
  JSON.stringify(wholeVideo.headers),
);
ok(
  'mp4 附件：整份返回补上 content-length 与 accept-ranges（禅道自己两个都不给）',
  wholeVideo.headers['content-length'] === '2048' &&
    wholeVideo.headers['accept-ranges'] === 'bytes' &&
    wholeVideo.headers['content-range'] === undefined,
  JSON.stringify(wholeVideo.headers),
);

const ranged = await invokeRpc(`attachment?url=${MP4}`, {
  method: 'GET',
  headers: { ...sameSiteHeaders, range: 'bytes=0-1023' },
});
ok('Range bytes=0-1023 → 206', ranged.status === 206, JSON.stringify(ranged.status));
ok(
  'Range 切片响应带 content-range / content-length',
  ranged.headers['content-range'] === 'bytes 0-1023/2048' && ranged.headers['content-length'] === '1024',
  JSON.stringify(ranged.headers),
);
ok('Range 切片真的只发 1024 字节', ranged.body.length === 1024, ranged.body.length);

const openEnded = await invokeRpc(`attachment?url=${MP4}`, {
  method: 'GET',
  headers: { ...sameSiteHeaders, range: 'bytes=1024-' },
});
ok(
  '开放式 Range bytes=1024- → 206 + bytes 1024-2047/2048',
  openEnded.status === 206 && openEnded.headers['content-range'] === 'bytes 1024-2047/2048' && openEnded.body.length === 1024,
  JSON.stringify(openEnded.headers),
);

const suffix = await invokeRpc(`attachment?url=${MP4}`, {
  method: 'GET',
  headers: { ...sameSiteHeaders, range: 'bytes=-100' },
});
ok(
  '后缀 Range bytes=-100 → 206 + bytes 1948-2047/2048',
  suffix.status === 206 && suffix.headers['content-range'] === 'bytes 1948-2047/2048' && suffix.body.length === 100,
  JSON.stringify(suffix.headers),
);

const outOfRange = await invokeRpc(`attachment?url=${MP4}`, {
  method: 'GET',
  headers: { ...sameSiteHeaders, range: 'bytes=99999-' },
});
ok(
  '越界 Range → 416 + content-range: bytes */2048',
  outOfRange.status === 416 && outOfRange.headers['content-range'] === 'bytes */2048',
  JSON.stringify(outOfRange.headers),
);

const malformedRange = await invokeRpc(`attachment?url=${MP4}`, {
  method: 'GET',
  headers: { ...sameSiteHeaders, range: 'pages=1-2' },
});
ok(
  '非法 Range 头（非 bytes=）按整份返回 200，不报错',
  malformedRange.status === 200 && malformedRange.body.length === 2048,
  JSON.stringify(malformedRange.headers),
);

console.log('\n== 9. 「处理」→ 任务置为开始（POST tasks/{id}/start） ==');
// 第 8 节末尾已登录。

const startOk = await call('startTask', { id: '5001' });
ok('wait 任务：ok', startOk.ok === true, JSON.stringify(startOk));
ok('wait 任务：changed=true', startOk.value?.changed === true, JSON.stringify(startOk.value));
ok('wait 任务：回读状态是 doing，previousStatus=wait', startOk.value?.status === 'doing' && startOk.value?.previousStatus === 'wait', JSON.stringify(startOk.value));
ok('wait 任务：状态是中文标签「进行中」', startOk.value?.statusLabel === '进行中', JSON.stringify(startOk.value));
ok('wait 任务：回读确认的前提是打了 start 路由', startBodies.length === 1, JSON.stringify(startBodies));
ok('start 请求体带 realStarted（YYYY-MM-DD）', /^\d{4}-\d{2}-\d{2}$/.test(String(startBodies[0]?.realStarted)), JSON.stringify(startBodies[0]));
ok('start 请求体带上原 consumed/left（不让禅道把工时覆盖成 0）', startBodies[0]?.consumed === 3 && startBodies[0]?.left === 7, JSON.stringify(startBodies[0]));

const startAlready = await call('startTask', { id: '5002' });
ok('已 doing 的任务：changed=false 且不重复写', startAlready.value?.changed === false && startBodies.length === 1, JSON.stringify(startAlready.value));
ok('已 doing 的任务：提示「已经是进行中」', String(startAlready.value?.note ?? '').includes('已经是进行中'), JSON.stringify(startAlready.value));

const startDone = await call('startTask', { id: '5003' });
ok('已完成的任务：不冒险开始（changed=false）', startDone.value?.changed === false && startBodies.length === 1, JSON.stringify(startDone.value));
ok('已完成的任务：提示只有未开始的能开始', String(startDone.value?.note ?? '').includes('未开始'), JSON.stringify(startDone.value));

const startNoChange = await call('startTask', { id: '5004' });
ok('禅道返回 200 但状态没变：changed=false（不谎报成功）', startNoChange.value?.changed === false && startBodies.length === 2, JSON.stringify(startNoChange.value));
ok('禅道返回 200 但状态没变：提示没改变状态', String(startNoChange.value?.note ?? '').includes('没有改变任务状态'), JSON.stringify(startNoChange.value));

const startNoId = await invokeRpc('startTask', { payload: {} });
const startNoIdBody = JSON.parse(startNoId.body);
ok(
  '缺 id → ok=false + bad-request（信封错误，HTTP 仍是 200）',
  startNoId.status === 200 && startNoIdBody.ok === false && startNoIdBody.error.code === 'bad-request',
  `${startNoId.status} ${startNoId.body}`,
);

console.log('\n== 10. 「完成」/「指派」/ 成员列表 ==');
// 第 9 节末尾已登录。

// 对象形状的 assignedTo 必须被解成账号 + 真名（早期 asString(对象) 会收成空串）。
// 注意用 settled（渐进扫描完成后的结果）：首包可能还没扫到 Bug。
ok(
  '对象形状的 assignedTo 解出账号与真名',
  settled.bugs[0]?.assignedTo === 'zhangsan' && settled.bugs[0]?.assignedToName === '张三',
  JSON.stringify(settled.bugs[0]),
);
ok(
  '「指派给我」过滤对对象形状同样生效（wangwu 被滤掉）',
  settled.bugs.length === 1 && settled.bugs[0]?.id === '101',
  JSON.stringify(settled.bugs),
);
ok('工具文本用真名（@张三）而不是裸账号', toolTasks.content.includes('@张三'), toolTasks.content.slice(0, 200));

// ---- 完成：POST tasks/{id}/finish ------------------------------------------
const finishOk = await call('finishTask', { id: '6001', hours: 2.5, comment: '自测通过' });
ok('完成：ok', finishOk.ok === true, JSON.stringify(finishOk));
ok(
  '完成：changed=true 且回读状态是 done',
  finishOk.value?.changed === true && finishOk.value?.status === 'done',
  JSON.stringify(finishOk.value),
);
ok(
  '完成：previousStatus=wait、状态中文「已完成」',
  finishOk.value?.previousStatus === 'wait' && finishOk.value?.statusLabel === '已完成',
  JSON.stringify(finishOk.value),
);
ok('完成：累计耗时 = 已登记 3 + 本次 2.5', finishOk.value?.consumed === 5.5, JSON.stringify(finishOk.value));
ok(
  '完成：请求体补了 realStarted / finishedDate（YYYY-MM-DD）',
  /^\d{4}-\d{2}-\d{2}$/.test(String(finishBodies[0]?.body?.realStarted)) &&
    /^\d{4}-\d{2}-\d{2}$/.test(String(finishBodies[0]?.body?.finishedDate)),
  JSON.stringify(finishBodies[0]),
);
ok(
  '完成：本次耗时走 currentConsumed，备注原样带上',
  finishBodies[0]?.body?.currentConsumed === 2.5 && finishBodies[0]?.body?.comment === '自测通过',
  JSON.stringify(finishBodies[0]),
);

const finishNoChange = await call('finishTask', { id: '6002', hours: 1 });
ok(
  '完成：禅道收下但状态没变 → changed=false（不谎报成功）',
  finishNoChange.value?.changed === false && finishBodies.length === 2,
  JSON.stringify(finishNoChange.value),
);
ok(
  '完成：禅道收下但状态没变 → 提示「没有改变任务状态」',
  String(finishNoChange.value?.note ?? '').includes('没有改变任务状态'),
  JSON.stringify(finishNoChange.value),
);

const finishDone = await call('finishTask', { id: '5003', hours: 1 });
ok(
  '完成：已完成的任务 changed=false 且不重复写',
  finishDone.value?.changed === false && finishBodies.length === 2,
  JSON.stringify(finishDone.value),
);
ok('完成：已完成的任务提示「无需再完成」', String(finishDone.value?.note ?? '').includes('无需再完成'), JSON.stringify(finishDone.value));

await call('finishTask', { id: '6002', hours: '' });
ok('完成：耗时留空按 0 处理', finishBodies[2]?.body?.currentConsumed === 0, JSON.stringify(finishBodies[2]));

const finishBadHours = await invokeRpc('finishTask', { payload: { id: '6001', hours: -1 } });
ok(
  '完成：耗时为负 → bad-request',
  JSON.parse(finishBadHours.body).error?.code === 'bad-request',
  finishBadHours.body,
);
const finishNan = await invokeRpc('finishTask', { payload: { id: '6001', hours: 'abc' } });
ok('完成：耗时不是数字 → bad-request', JSON.parse(finishNan.body).error?.code === 'bad-request', finishNan.body);
const finishNoId = await invokeRpc('finishTask', { payload: { hours: 1 } });
ok('完成：缺 id → bad-request', JSON.parse(finishNoId.body).error?.code === 'bad-request', finishNoId.body);

// ---- 指派：PUT tasks/{id} ---------------------------------------------------
const assignOk = await call('assignTask', { id: '6001', account: 'lisi' });
ok('指派：ok 且 changed=true', assignOk.ok === true && assignOk.value?.changed === true, JSON.stringify(assignOk.value));
ok(
  '指派：回读真名「李四」、previousAccount=zhangsan',
  assignOk.value?.realname === '李四' && assignOk.value?.previousAccount === 'zhangsan',
  JSON.stringify(assignOk.value),
);
ok(
  '指派：请求体只带 assignedTo（不覆盖其它字段）',
  assignBodies[0]?.body?.assignedTo === 'lisi' && Object.keys(assignBodies[0].body).length === 1,
  JSON.stringify(assignBodies[0]),
);
ok(
  '指派：未开始的任务被禅道激活为 doing，statusChanged=true',
  assignOk.value?.statusChanged === true && assignOk.value?.status === 'doing',
  JSON.stringify(assignOk.value),
);

const assignSame = await call('assignTask', { id: '6001', account: 'lisi' });
ok(
  '指派：指派给同一个人 changed=false 且不重复写',
  assignSame.value?.changed === false && assignBodies.length === 1,
  JSON.stringify(assignSame.value),
);
ok('指派：同一个人提示「已经指派给」', String(assignSame.value?.note ?? '').includes('已经指派给'), JSON.stringify(assignSame.value));

const assignNoStatusChange = await call('assignTask', { id: '6003', account: 'lisi' });
ok(
  '指派：换人成功但状态没变 → changed=true 且 statusChanged=false',
  assignNoStatusChange.value?.changed === true && assignNoStatusChange.value?.statusChanged === false,
  JSON.stringify(assignNoStatusChange.value),
);

const assignGhost = await call('assignTask', { id: '6002', account: 'ghost' });
ok('指派：禅道 200 但没改指派人 → changed=false（回读兜底）', assignGhost.value?.changed === false, JSON.stringify(assignGhost.value));
ok(
  '指派：禅道 200 但没改指派人 → 提示「没有改变指派人」',
  String(assignGhost.value?.note ?? '').includes('没有改变指派人'),
  JSON.stringify(assignGhost.value),
);

const assignNoAccount = await invokeRpc('assignTask', { payload: { id: '6001' } });
ok('指派：缺 account → bad-request', JSON.parse(assignNoAccount.body).error?.code === 'bad-request', assignNoAccount.body);
const assignNoId = await invokeRpc('assignTask', { payload: { account: 'lisi' } });
ok('指派：缺 id → bad-request', JSON.parse(assignNoId.body).error?.code === 'bad-request', assignNoId.body);

// ---- 成员列表 ---------------------------------------------------------------
const users = await call('listUsers', {});
ok('成员列表：ok 且带 total/self', users.ok === true && users.value?.total === 2 && users.value?.self === 'zhangsan', JSON.stringify(users));
ok(
  '成员列表：按真名中文排序（李四 在 张三 前）',
  JSON.stringify(users.value?.users?.map((user) => user.account)) === JSON.stringify(['lisi', 'zhangsan']),
  JSON.stringify(users.value?.users),
);
ok(
  '成员列表：每条都是 {account, realname}',
  users.value?.users?.every((user) => typeof user.account === 'string' && typeof user.realname === 'string'),
  JSON.stringify(users.value?.users),
);
ok('成员列表：请求参数是 limit=100（users 的 limit 有效）', seen.some((entry) => entry.path === 'users?limit=100'), JSON.stringify(seen.filter((e) => e.path.startsWith('users')).slice(0, 3)));

console.log('\n== 11. 配置落盘安全 ==');
let raw = '';
try {
  raw = readFileSync(process.env.DSH_ZENTAO_WORKBENCH_CONFIG, 'utf8');
} catch {
  raw = '';
}
ok('配置写到了临时文件（未污染 ~/.dsh-zentao-workbench.json）', raw !== '');
ok('配置文件不含密码', raw !== '' && !raw.includes('secret'));
ok('未勾选「记住 Token」时 token 为空串', JSON.parse(raw === '' ? '{}' : raw).token === '');

// ---- 12. 用系统默认程序打开附件（ppt/word/excel 走这条路） -------------------
console.log('\n== 12. 用默认程序打开附件 ==');
const DOCX_URL = 'http://zentao.example.com:11180/zentao/file-read-31005.docx';

const docxOpen = await call('openAttachment', { url: DOCX_URL, name: 'file-read-31005.docx' });
ok('打开 docx：ok=true 且 opened=true', docxOpen.ok === true && docxOpen.value?.opened === true, JSON.stringify(docxOpen));
ok(
  '打开 docx：返回落盘路径 / 字节数 / 扩展名',
  typeof docxOpen.value?.savedPath === 'string' &&
    docxOpen.value.savedPath.startsWith(openDir) &&
    docxOpen.value.size === 64 &&
    docxOpen.value.extension === 'docx',
  JSON.stringify(docxOpen.value),
);
ok(
  '打开 docx：文件真的落到了本机（内容一致）',
  (() => {
    try {
      const bytes = readFileSync(docxOpen.value.savedPath);
      return bytes.length === 64 && bytes.every((byte) => byte === 0x41);
    } catch {
      return false;
    }
  })(),
  docxOpen.value?.savedPath,
);
ok(
  '打开 docx：回源带了 Token 头',
  seen.some((entry) => entry.path === '/zentao/file-read-31005.docx' && entry.token === 'TOKEN-XYZ'),
);
ok(
  '打开 docx：文件名已去危险字符（只留一个前缀 + 原名）',
  /^\d+-file-read-31005\.docx$/.test(String(docxOpen.value?.savedPath ?? '').split(/[\\/]/).pop() ?? ''),
  docxOpen.value?.savedPath,
);

const exeOpen = await invokeRpc('openAttachment', { payload: { url: 'http://zentao.example.com:11180/zentao/file-read-2.exe', name: 'x.exe' } });
const exeBody = JSON.parse(exeOpen.body);
ok(
  '可执行文件被白名单拒绝（forbidden 信封）',
  exeOpen.status === 200 && exeBody.ok === false && exeBody.error.code === 'forbidden' && exeBody.error.message.includes('.exe'),
  exeOpen.body,
);
ok(
  '被拒的可执行文件没有被下载',
  seen.every((entry) => entry.path !== '/zentao/file-read-2.exe'),
);

const foreignOpen = await invokeRpc('openAttachment', { payload: { url: 'http://evil.example.com/zentao/file-read-1.docx' } });
const foreignBody = JSON.parse(foreignOpen.body);
ok(
  '异地地址被拒绝（forbidden 信封）',
  foreignOpen.status === 200 && foreignBody.ok === false && foreignBody.error.code === 'forbidden',
  foreignOpen.body,
);

const noExtOpen = await call('openAttachment', { url: 'http://zentao.example.com:11180/zentao/file-read-3', name: '' });
ok('没有扩展名 → bad-request', noExtOpen.ok === false && noExtOpen.error.code === 'bad-request', JSON.stringify(noExtOpen));
const noUrlOpen = await call('openAttachment', {});
ok('缺附件地址 → bad-request', noUrlOpen.ok === false && noUrlOpen.error.code === 'bad-request', JSON.stringify(noUrlOpen));

// ---- 13. AI 预判（analyze：读 llm 服务 + 解析模型输出） ----------------------
console.log('\n== 13. AI 预判（analyze） ==');

/** 造一个假的 llm 服务；overrides 可覆盖 providers / models / chunks。 */
function makeLlm(overrides = {}) {
  const calls = [];
  const models = overrides.models ?? {
    deepseek: [
      { provider: 'deepseek', id: 'deepseek-chat' },
      { provider: 'deepseek', id: 'deepseek-flash' },
    ],
  };
  return {
    calls,
    providers: overrides.providers ?? [{ id: 'deepseek' }],
    async listProviders() {
      calls.push('listProviders');
      if (overrides.providersError) throw new Error('no catalog');
      return this.providers;
    },
    async listModels(provider) {
      calls.push(`listModels:${provider}`);
      return models[provider] ?? [];
    },
    stream(options) {
      calls.push(options);
      const chunks = overrides.chunks ?? [
        { type: 'text-delta', index: 0, text: '```json\n{"category":"optimize",' },
        { type: 'text-delta', index: 0, text: '"confidence":82,"headline":"列表加载慢",' },
        {
          type: 'text-delta',
          index: 0,
          text: '"reason":"功能可用但慢","steps":["看慢查询","加索引"],"questions":["是否只在弱网复现"]}\n```\n以上。',
        },
        { type: 'finish', reason: { kind: 'stop' } },
      ];
      return (async function* chunks_() {
        for (const chunk of chunks) yield chunk;
      })();
    },
  };
}

// 13.1 实例没暴露模型服务（reflect.get('llm') 返回 undefined）→ 明确报错，不崩
llmMock = undefined;
const analyzeNoLlm = await call('analyze', { kind: 'task', id: '10002' });
ok(
  '没有 llm 服务时 analyze 明确报 llm-unavailable',
  analyzeNoLlm.ok === false && analyzeNoLlm.error.code === 'llm-unavailable',
  JSON.stringify(analyzeNoLlm),
);
ok(
  "读模型服务走 reflect.get('llm')（不必写进 inject）",
  registered.reflectGets.includes('llm'),
  JSON.stringify(registered.reflectGets.slice(0, 3)),
);

// 13.2 kind / id 校验先于远端读取
const analyzeBadKind = await call('analyze', { kind: 'nope', id: '10002' });
ok('analyze kind 非法 → bad-request', analyzeBadKind.ok === false && analyzeBadKind.error.code === 'bad-request', JSON.stringify(analyzeBadKind));
const analyzeNoId = await call('analyze', { kind: 'task' });
ok('analyze 缺 id → bad-request', analyzeNoId.ok === false && analyzeNoId.error.code === 'bad-request', JSON.stringify(analyzeNoId));

// 13.3 正常一轮：带 ``` 围栏 + 尾部废话也要能解析
const llm = makeLlm();
llmMock = llm;
const analysis = await call('analyze', { kind: 'task', id: '10002' });
ok('analyze 返回 ok', analysis.ok === true, JSON.stringify(analysis).slice(0, 300));
ok('analyze 解析出 category=optimize', analysis.value?.category === 'optimize', JSON.stringify(analysis.value));
ok('analyze 带中文类别名', analysis.value?.categoryLabel === '体验或性能优化', String(analysis.value?.categoryLabel));
ok('analyze 置信度取整为 82', analysis.value?.confidence === 82, String(analysis.value?.confidence));
ok('analyze 步骤数组（2 条，<=5）', Array.isArray(analysis.value?.steps) && analysis.value.steps.length === 2, JSON.stringify(analysis.value?.steps));
ok('analyze 待确认问题进 questions', analysis.value?.questions?.[0] === '是否只在弱网复现', JSON.stringify(analysis.value?.questions));
ok(
  'analyze 回带 kind/id/title',
  analysis.value?.kind === 'task' && analysis.value?.id === '10002' && analysis.value?.title !== '',
  JSON.stringify({ kind: analysis.value?.kind, id: analysis.value?.id, title: analysis.value?.title }),
);
ok('analyze 回带 analyzedAt（ISO）', typeof analysis.value?.analyzedAt === 'string' && analysis.value.analyzedAt.includes('T'), String(analysis.value?.analyzedAt));
ok('分析返回详情内容指纹', /^[a-f0-9]{64}$/.test(analysis.value?.contentFingerprint ?? ''));
ok('analyze 记录路由来源 auto', analysis.value?.routeSource === 'auto', String(analysis.value?.routeSource));
ok(
  '自动挑便宜路由：优先 flash 模型',
  analysis.value?.provider === 'deepseek' && analysis.value?.model === 'deepseek-flash',
  JSON.stringify({ provider: analysis.value?.provider, model: analysis.value?.model }),
);
const streamed = llm.calls.find((entry) => typeof entry === 'object' && entry !== null && 'messages' in entry);
ok(
  '只发了一次 stream 调用',
  llm.calls.filter((entry) => typeof entry === 'object' && entry !== null && 'messages' in entry).length === 1,
  JSON.stringify(llm.calls.map((entry) => (typeof entry === 'string' ? entry : 'stream'))),
);
ok(
  'stream 的 system 写死了「只输出 JSON」的口径',
  typeof streamed?.system === 'string' && streamed.system.includes('只输出一个 JSON 对象'),
  String(streamed?.system).slice(0, 60),
);
ok(
  '送进模型的是 user 消息且带 source',
  streamed?.messages?.[0]?.role === 'user' && streamed?.messages?.[0]?.source?.kind === 'dsh-zentao-workbench',
  JSON.stringify(streamed?.messages?.[0]?.source),
);
const sentText = streamed?.messages?.[0]?.content?.[0]?.text ?? '';
ok('送进模型的是详情正文（不是空壳）', sentText.includes('编号：10002') && sentText.includes('正文：'), sentText.slice(0, 140));
ok('maxTokens 有上限', streamed?.maxTokens === 4000, String(streamed?.maxTokens));

// 13.4 模型输出不是 JSON
llmMock = makeLlm({
  chunks: [
    { type: 'text-delta', index: 0, text: '抱歉，我不能判断。' },
    { type: 'finish', reason: { kind: 'stop' } },
  ],
});
const analyzeBadJson = await call('analyze', { kind: 'task', id: '10002' });
ok('模型没吐 JSON → llm-parse', analyzeBadJson.ok === false && analyzeBadJson.error.code === 'llm-parse', JSON.stringify(analyzeBadJson));

// 13.4b 带推理的模型（比如 deepseek-flash）常以 max-tokens 收尾：只要 JSON 已吐完就照用
llmMock = makeLlm({
  chunks: [
    { type: 'text-delta', index: 0, text: '{"category":"feature","confidence":70,"headline":"想加导出","reason":"正文写的是新能力","steps":["确认范围"],"questions":[]}' },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ],
});
const analyzeTruncatedOk = await call('analyze', { kind: 'task', id: '10002' });
ok(
  'finish=max-tokens 但 JSON 已完整 → 照用，不白扔这次调用',
  analyzeTruncatedOk.ok === true && analyzeTruncatedOk.value?.category === 'feature',
  JSON.stringify(analyzeTruncatedOk).slice(0, 200),
);
ok('截断但可用时标 truncated=true', analyzeTruncatedOk.value?.truncated === true, String(analyzeTruncatedOk.value?.truncated));

llmMock = makeLlm({
  chunks: [
    { type: 'text-delta', index: 0, text: '{"category":"feature","confidence":70,"headline":"想加导出' },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ],
});
const analyzeTruncatedBad = await call('analyze', { kind: 'task', id: '10002' });
ok(
  '截断且 JSON 不完整 → llm-parse，且说清是被 maxTokens 截断',
  analyzeTruncatedBad.ok === false &&
    analyzeTruncatedBad.error.code === 'llm-parse' &&
    analyzeTruncatedBad.error.message.includes('maxTokens=4000') &&
    analyzeTruncatedBad.error.message.includes('截断'),
  JSON.stringify(analyzeTruncatedBad).slice(0, 220),
);

// 13.5 上游失败 / 取消
llmMock = makeLlm({ chunks: [{ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: '太挤' } } }] });
const analyzeFailed = await call('analyze', { kind: 'task', id: '10002' });
ok(
  '模型失败 → llm-failed 且带上游原因',
  analyzeFailed.ok === false && analyzeFailed.error.code === 'llm-failed' && analyzeFailed.error.message.includes('RATE_LIMIT') && analyzeFailed.error.message.includes('太挤'),
  JSON.stringify(analyzeFailed),
);
llmMock = makeLlm({ chunks: [{ type: 'finish', reason: { kind: 'aborted' } }] });
const analyzedAborted = await call('analyze', { kind: 'task', id: '10002' });
ok('被取消 → llm-aborted', analyzedAborted.ok === false && analyzedAborted.error.code === 'llm-aborted', JSON.stringify(analyzedAborted));

// 13.6 一个 provider 都没有
llmMock = makeLlm({ providers: [], models: {} });
const analyzeNoProvider = await call('analyze', { kind: 'task', id: '10002' });
ok('没有可用路由 → llm-unavailable', analyzeNoProvider.ok === false && analyzeNoProvider.error.code === 'llm-unavailable', JSON.stringify(analyzeNoProvider));

// 13.7 环境变量强制指定路由
llmMock = makeLlm();
process.env.DSH_ZENTAO_WORKBENCH_LLM = 'openai/gpt-x';
const analyzeOverride = await call('analyze', { kind: 'bug', id: '101' });
ok(
  'DSH_ZENTAO_WORKBENCH_LLM 覆盖路由（routeSource=env）',
  analyzeOverride.ok === true && analyzeOverride.value?.provider === 'openai' && analyzeOverride.value?.model === 'gpt-x' && analyzeOverride.value?.routeSource === 'env',
  JSON.stringify({ ok: analyzeOverride.ok, provider: analyzeOverride.value?.provider, model: analyzeOverride.value?.model, source: analyzeOverride.value?.routeSource }),
);
delete process.env.DSH_ZENTAO_WORKBENCH_LLM;

// 13.8 zentao 工具也能做预判
llmMock = makeLlm();
const toolAnalyze = await registered.tool.execute({ action: 'analyze', kind: 'task', id: '10002' }, exec);
ok(
  '工具 action=analyze 输出中文类别与步骤',
  typeof toolAnalyze.content === 'string' && toolAnalyze.content.includes('体验或性能优化') && toolAnalyze.content.includes('建议步骤'),
  toolAnalyze.content.slice(0, 160),
);
const toolAnalyzeBad = await registered.tool.execute({ action: 'analyze', kind: 'task' }, exec);
ok('工具 action=analyze 缺 id 给提示', typeof toolAnalyzeBad.content === 'string' && toolAnalyzeBad.content.includes('action=analyze'), toolAnalyzeBad.content.slice(0, 80));

// 13.9 「跟随 DSH」：默认模型来自 agentDefaultModel.currentSelection()
/** 假的 DSH 默认模型服务（`@deepseek-ai/dsh-agent-default-model` 注册名 agentDefaultModel）。 */
function makeDefaultModel(selection) {
  return {
    currentSelection() {
      if (selection instanceof Error) throw selection;
      return selection;
    },
  };
}

llmMock = undefined;
dshModelMock = makeDefaultModel({ provider: 'zai-coding-cn', model: 'glm-5.3', reasoningEffort: 'high' });
const analyzeNoLlmWithDefault = await call('analyze', { kind: 'task', id: '10002' });
ok(
  '没有 llm 服务时仍报 llm-unavailable（不会因为读默认模型而改变）',
  analyzeNoLlmWithDefault.ok === false && analyzeNoLlmWithDefault.error.code === 'llm-unavailable',
  JSON.stringify(analyzeNoLlmWithDefault),
);

// 13.9.1 DSH 默认模型可用 → 直接跟随它，不去挑便宜的
const dshLlm = makeLlm({
  providers: [{ id: 'zai-coding-cn' }, { id: 'deepseek' }],
  models: {
    'zai-coding-cn': [{ provider: 'zai-coding-cn', id: 'glm-5.3' }],
    deepseek: [{ provider: 'deepseek', id: 'deepseek-flash' }],
  },
});
llmMock = dshLlm;
dshModelMock = makeDefaultModel({ provider: 'zai-coding-cn', model: 'glm-5.3', reasoningEffort: 'high' });
const analyzeDsh = await call('analyze', { kind: 'task', id: '10002' });
ok(
  'DSH 默认模型可用时 analyze 跟随它（routeSource=dsh）',
  analyzeDsh.ok === true && analyzeDsh.value?.routeSource === 'dsh' && analyzeDsh.value?.provider === 'zai-coding-cn' && analyzeDsh.value?.model === 'glm-5.3',
  JSON.stringify({ ok: analyzeDsh.ok, provider: analyzeDsh.value?.provider, model: analyzeDsh.value?.model, source: analyzeDsh.value?.routeSource }),
);
ok('跟随 DSH 时不再挑 flash', analyzeDsh.value?.model !== 'deepseek-flash', String(analyzeDsh.value?.model));
ok(
  '跟随 DSH 时不枚举模型（不走自动挑选那条路）',
  !dshLlm.calls.some((entry) => typeof entry === 'string' && entry.startsWith('listModels')),
  JSON.stringify(dshLlm.calls.map((entry) => (typeof entry === 'string' ? entry : 'stream'))),
);
ok('跟随 DSH 时不回带 routeNote', analyzeDsh.value?.routeNote === undefined, String(analyzeDsh.value?.routeNote));
ok("读默认模型走 reflect.get('agentDefaultModel')（同样不必写进 inject）", registered.reflectGets.includes('agentDefaultModel'), JSON.stringify(registered.reflectGets.slice(-3)));
const dshStreamed = dshLlm.calls.find((entry) => typeof entry === 'object' && entry !== null && 'messages' in entry);
ok(
  '真正的 stream 用的是 DSH 默认模型',
  dshStreamed?.provider === 'zai-coding-cn' && dshStreamed?.model === 'glm-5.3',
  JSON.stringify({ provider: dshStreamed?.provider, model: dshStreamed?.model }),
);

// 13.9.2 DSH 默认模型的 provider 没注册 → 回退自动挑选 + 说明
llmMock = makeLlm();
dshModelMock = makeDefaultModel({ provider: 'not-there', model: 'x-1' });
const analyzeFallback = await call('analyze', { kind: 'task', id: '10002' });
ok(
  'DSH 默认模型的 provider 没注册 → 回退 auto 且挑 flash',
  analyzeFallback.ok === true && analyzeFallback.value?.routeSource === 'auto' && analyzeFallback.value?.model === 'deepseek-flash',
  JSON.stringify({ ok: analyzeFallback.ok, model: analyzeFallback.value?.model, source: analyzeFallback.value?.routeSource }),
);
ok(
  '回退时回带 routeNote 说明原委',
  typeof analyzeFallback.value?.routeNote === 'string' && analyzeFallback.value.routeNote.includes('not-there/x-1') && analyzeFallback.value.routeNote.includes('没有注册'),
  String(analyzeFallback.value?.routeNote),
);

// 13.9.3 provider 枚举失败，但 DSH 有默认模型 → 还是按默认模型发（不武断回退）
llmMock = makeLlm({ providersError: true, providers: [], models: {} });
dshModelMock = makeDefaultModel({ provider: 'zai-coding-cn', model: 'glm-5.3' });
const analyzeBlind = await call('analyze', { kind: 'task', id: '10002' });
ok(
  '枚举 provider 失败时仍按 DSH 默认模型发',
  analyzeBlind.ok === true && analyzeBlind.value?.routeSource === 'dsh' && analyzeBlind.value?.provider === 'zai-coding-cn',
  JSON.stringify({ ok: analyzeBlind.ok, provider: analyzeBlind.value?.provider, source: analyzeBlind.value?.routeSource }),
);

// 13.9.4 环境变量优先级最高
llmMock = makeLlm();
dshModelMock = makeDefaultModel({ provider: 'zai-coding-cn', model: 'glm-5.3' });
process.env.DSH_ZENTAO_WORKBENCH_LLM = 'openai/gpt-x';
const analyzeEnvBeatsDsh = await call('analyze', { kind: 'task', id: '10002' });
ok(
  '环境变量优先于 DSH 默认模型',
  analyzeEnvBeatsDsh.ok === true && analyzeEnvBeatsDsh.value?.provider === 'openai' && analyzeEnvBeatsDsh.value?.model === 'gpt-x' && analyzeEnvBeatsDsh.value?.routeSource === 'env',
  JSON.stringify({ provider: analyzeEnvBeatsDsh.value?.provider, model: analyzeEnvBeatsDsh.value?.model, source: analyzeEnvBeatsDsh.value?.routeSource }),
);
delete process.env.DSH_ZENTAO_WORKBENCH_LLM;

// 13.9.5 默认模型服务读不到 / 抛错 / 形状不对 → 安静回退，不崩
llmMock = makeLlm();
dshModelMock = makeDefaultModel(new Error('boom'));
const analyzeDefaultThrows = await call('analyze', { kind: 'task', id: '10002' });
ok(
  '默认模型服务抛错 → 回退 auto 且不崩',
  analyzeDefaultThrows.ok === true && analyzeDefaultThrows.value?.routeSource === 'auto' && analyzeDefaultThrows.value?.routeNote === undefined,
  JSON.stringify({ ok: analyzeDefaultThrows.ok, source: analyzeDefaultThrows.value?.routeSource, note: analyzeDefaultThrows.value?.routeNote }),
);
dshModelMock = makeDefaultModel({ provider: '', model: '' });
const analyzeDefaultEmpty = await call('analyze', { kind: 'task', id: '10002' });
ok(
  '默认模型选择字段为空 → 回退 auto 且不崩',
  analyzeDefaultEmpty.ok === true && analyzeDefaultEmpty.value?.routeSource === 'auto' && analyzeDefaultEmpty.value?.routeNote === undefined,
  JSON.stringify({ ok: analyzeDefaultEmpty.ok, source: analyzeDefaultEmpty.value?.routeSource }),
);
dshModelMock = { currentSelection: 'not a function' };
const analyzeDefaultWrongShape = await call('analyze', { kind: 'task', id: '10002' });
ok(
  '默认模型服务形状不对 → 当作没有（回退 auto）',
  analyzeDefaultWrongShape.ok === true && analyzeDefaultWrongShape.value?.routeSource === 'auto',
  JSON.stringify({ ok: analyzeDefaultWrongShape.ok, source: analyzeDefaultWrongShape.value?.routeSource }),
);

// 13.9.6 工具 action=analyze 也要标出模型来源
llmMock = makeLlm({
  providers: [{ id: 'zai-coding-cn' }],
  models: { 'zai-coding-cn': [{ provider: 'zai-coding-cn', id: 'glm-5.3' }] },
});
dshModelMock = makeDefaultModel({ provider: 'zai-coding-cn', model: 'glm-5.3' });
const toolAnalyzeDsh = await registered.tool.execute({ action: 'analyze', kind: 'task', id: '10002' }, exec);
ok(
  '工具 action=analyze 标出「DSH 默认模型」',
  typeof toolAnalyzeDsh.content === 'string' && toolAnalyzeDsh.content.includes('zai-coding-cn/glm-5.3') && toolAnalyzeDsh.content.includes('DSH 默认模型'),
  toolAnalyzeDsh.content.slice(0, 160),
);
dshModelMock = makeDefaultModel({ provider: 'not-there', model: 'x-1' });
const toolAnalyzeNote = await registered.tool.execute({ action: 'analyze', kind: 'task', id: '10002' }, exec);
ok(
  '工具 action=analyze 回退时带上说明',
  typeof toolAnalyzeNote.content === 'string' && toolAnalyzeNote.content.includes('说明：') && toolAnalyzeNote.content.includes('not-there/x-1'),
  toolAnalyzeNote.content.slice(0, 200),
);
llmMock = undefined;
dshModelMock = undefined;

rmSync(configDir, { recursive: true, force: true });
rmSync(openDir, { recursive: true, force: true });

console.log(`\n== 结果：${checks - failures}/${checks} 通过 ==`);
process.exit(failures === 0 ? 0 : 1);
