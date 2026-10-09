/**
 * 浏览器半侧离线冒烟测试。
 *
 * 目的：在没有真实浏览器/DSH 客户端运行时的前提下，用极简 React/DOM 替身加载
 * lib/client.js，验证 factory 契约、slot 注册、样式注入、渲染与「处理」交互链路。
 *
 * 运行：node client-smoke.mjs
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8');

let failures = 0;
let checks = 0;
function ok(label, condition, extra) {
  checks += 1;
  if (condition) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${label}${extra === undefined ? '' : ` -> ${String(extra)}`}`);
  }
}

/** 让已排队的 promise 链跑完（组件里的 effect 与点击处理都是异步的）。 */
const flush = async (rounds = 6) => {
  for (let index = 0; index < rounds; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

// ---------------------------------------------------------------------------
// React 替身：hooks 可编程，用于强制走「已登录 / 有数据」分支
// ---------------------------------------------------------------------------

/** 每次「渲染趟」注入的一组初始 state；undefined 表示用组件里的默认值。 */
const hookState = { index: 0, presets: [], effectRuns: 0, cleanups: [], setters: [] };

function createElement(type, props, ...children) {
  const flat = children.flat();
  const resolved = flat.length > 0 ? flat : props?.children === undefined ? [] : [props.children].flat();
  return { type, props: props ?? {}, children: resolved };
}

/** React 替身。useEffect 会真的执行，以便覆盖挂载时的自动加载链路。 */
const React = {
  createElement,
  Fragment: Symbol('Fragment'),
  useState(initial) {
    const index = hookState.index;
    const preset = hookState.presets[index];
    hookState.index += 1;
    // React 语义：initial 是函数时会被调用一次（惰性初始化），这里必须一致。
    const fallback = typeof initial === 'function' ? initial() : initial;
    // setState 是空操作（不做真实重渲染），但把调用记下来，用于断言「点遮罩/Esc 关闭弹窗」。
    // React 语义：setter 可以接收函数式更新。这里按当前 state 求值后记录结果，
    // 这样 `setX((prev) => ({...prev, y}))` 也能被断言，而普通值写入行为不变。
    const current = preset === undefined ? fallback : preset;
    const setter = (value) => {
      const resolved = typeof value === 'function' ? value(current) : value;
      hookState.setters.push({ index, value: resolved, updater: typeof value === 'function' });
    };
    return [preset === undefined ? fallback : preset, setter];
  },
  // cleanup 不在当趟立即执行（否则 Esc 监听会被马上摘掉），改为下一趟渲染前统一执行。
  useEffect(fn) {
    hookState.effectRuns += 1;
    const cleanup = fn();
    if (typeof cleanup === 'function') hookState.cleanups.push(cleanup);
  },
  // 注意：只有 useState 消耗注入下标，useCallback/useMemo/useRef 不能，否则预设会错位。
  useCallback(fn) { return fn; },
  useMemo(fn) { return fn(); },
  useRef(value) { return { current: value }; },
};

/** 执行上一趟渲染登记的 cleanup（模拟卸载），避免订阅与监听泄漏。 */
function runCleanups() {
  const pending = hookState.cleanups;
  hookState.cleanups = [];
  for (const cleanup of pending) cleanup();
}

// ---------------------------------------------------------------------------
// DOM 替身（只覆盖 client.js 用到的 API）
// ---------------------------------------------------------------------------

const createdStyles = [];
const appendedStyles = [];
const documentListeners = new Map();

globalThis.document = {
  createElement(tag) {
    const node = {
      tagName: tag,
      dataset: {},
      style: {},
      setAttribute() {},
      remove() { node._removed = true; },
      appendChild() {},
      _text: '',
    };
    Object.defineProperty(node, 'textContent', {
      get() { return node._text; },
      set(v) { node._text = v; },
    });
    if (tag === 'style') createdStyles.push(node);
    return node;
  },
  head: { appendChild(node) { if (node?.tagName === 'style') appendedStyles.push(node); } },
  querySelector() { return null; },
  addEventListener(type, fn) {
    const list = documentListeners.get(type) ?? [];
    list.push(fn);
    documentListeners.set(type, list);
  },
  removeEventListener(type, fn) {
    const list = documentListeners.get(type) ?? [];
    const index = list.indexOf(fn);
    if (index >= 0) list.splice(index, 1);
  },
};

/** 模拟 document 上的键盘事件（用于验证 Esc 关闭弹窗）。 */
function fireDocumentKey(key) {
  for (const fn of documentListeners.get('keydown') ?? []) fn({ key });
}
// Node 22 自带只读的 globalThis.navigator，必须用 defineProperty 覆盖。
Object.defineProperty(globalThis, 'navigator', {
  value: { clipboard: { writeText: async () => true } },
  configurable: true,
  writable: true,
});

// ---------------------------------------------------------------------------
// 模块加载器替身
// ---------------------------------------------------------------------------

let loaded;
const localStorageData = new Map();
globalThis.window = {
  __ModuleLoader__: { load(spec) { loaded = spec; } },
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id),
  // 快照持久化用：内存版 localStorage（不碰真实浏览器存储）。
  localStorage: {
    getItem: (key) => (localStorageData.has(key) ? localStorageData.get(key) : null),
    setItem: (key, value) => { localStorageData.set(key, String(value)); },
    removeItem: (key) => { localStorageData.delete(key); },
  },
};

// 组件里的异步点击处理是「fire and forget」的，失败会变成未处理的 rejection；
// 这里把它记下来而不是让进程直接崩掉，方便定位。
const unhandled = [];
process.on('unhandledRejection', (reason) => { unhandled.push(reason); });

const requireShim = (id) => {
  if (id === 'react') return React;
  if (id === 'react/jsx-runtime') return { jsx: createElement, jsxs: createElement, Fragment: React.Fragment };
  throw new Error(`client.js 试图 require 基线之外的模块: ${id}`);
};

console.log('== 1. 加载与 factory 契约 ==');
let caught;
try {
  // 普通副作用脚本：用 Function 包一层，暴露 window/require/document/navigator
  new Function('window', 'require', 'document', 'navigator', source)(
    globalThis.window, requireShim, globalThis.document, globalThis.navigator,
  );
} catch (error) {
  caught = error;
}
ok('脚本加载不抛异常', caught === undefined, caught?.stack ?? caught);
ok('调用了 __ModuleLoader__.load', loaded !== undefined);
ok('bundle id 等于包名', loaded?.id === 'dsh-zentao-workbench', loaded?.id);

const mod = loaded.factory(requireShim);
ok('exports 有 inject/apply（与参考实现一致）', Array.isArray(mod?.inject) && typeof mod?.apply === 'function');
ok(
  'inject 覆盖 slots/sessions/workspaces（不再需要 connection）',
  ['slots', 'sessions', 'workspaces'].every((key) => mod.inject.includes(key)) && !mod.inject.includes('connection'),
  mod.inject.join(','),
);

// ---------------------------------------------------------------------------
// mock ctx / RPC
// ---------------------------------------------------------------------------

const calls = [];
let slotRegistration;
let slotHost = 'unset';

const loggedInConfig = {
  hasToken: true,
  server: 'http://zentao.example.com:11180/zentao',
  account: 'zhangsan',
  realname: '张三',
  role: 'dev',
  rememberToken: true,
  // 已保存密码（密文只在宿主侧，前端只拿到这个布尔值）
  rememberPassword: true,
};
// 任务故意乱序给出：id 倒序（42 → 11 → 7）由渲染层负责。
const loggedInData = {
  fetchedAt: '2026-06-30 12:00:00',
  tasks: [
    { id: '11', kind: 'task', title: '修复登录超时', status: 'doing', statusLabel: '进行中', assignedTo: 'zhangsan', assignedToName: '张三', link: 'http://x/zentao/task-view-11.html' },
    { id: '42', kind: 'task', title: '补充单元测试', status: 'wait', statusLabel: '未开始', assignedTo: 'zhangsan', assignedToName: '张三', link: 'http://x/zentao/task-view-42.html' },
    { id: '7', kind: 'task', title: '历史遗留任务', status: 'done', statusLabel: '已完成', assignedTo: 'zhangsan', assignedToName: '张三', link: 'http://x/zentao/task-view-7.html' },
  ],
  bugs: [{ id: '101', kind: 'bug', title: '列表页崩溃', status: 'active', statusLabel: '激活', assignedTo: 'zhangsan', link: 'http://x/zentao/bug-view-101.html' }],
  stories: [{ id: '201', kind: 'story', title: '支持批量导入', status: 'reviewing', statusLabel: '评审中', assignedTo: 'zhangsan', link: 'http://x/zentao/story-view-201.html' }],
  scan: { scannedProducts: 2, totalProducts: 2, joined: 3 },
};

// 宿主半侧自有的 HTTP 路由：这里用 fetch 替身，按 endpoint 回信封，并记录调用。
// startTask 的返回值可切换，用来验证「成功 / 禅道没改状态」两种提示。
let startTaskReply = { changed: true, previousStatus: 'wait', status: 'doing', statusLabel: '进行中', note: '' };
// finishTask / assignTask / listUsers 的返回值也能切换，用来验证成功与「禅道没改」两种提示。
let finishTaskReply = { changed: true, previousStatus: 'wait', status: 'done', statusLabel: '已完成', consumed: 5.5, finishedDate: '2026-10-08', note: '' };
let assignTaskReply = {
  changed: true,
  previousAccount: 'zhangsan',
  previousName: '张三',
  account: 'lisi',
  realname: '李四',
  status: 'doing',
  statusLabel: '进行中',
  statusChanged: true,
  note: '',
};
const usersReply = {
  users: [
    { account: 'lisi', realname: '李四' },
    { account: 'zhangsan', realname: '张三' },
  ],
  total: 2,
  self: 'zhangsan',
};
// openAttachment（用系统默认程序打开 ppt/word/excel）的回答可切换，用来验证成功与失败两种提示。
let openAttachmentFails = false;
const openAttachmentReply = {
  opened: true,
  name: '需求说明.docx',
  savedPath: 'C:\\Temp\\dsh-zentao-workbench\\1-需求说明.docx',
  size: 64,
  extension: 'docx',
};
// analyze（AI 预判：Bug / 优化 / 需求）的回答可切换，用来验证成功与失败两条路径。
let analyzeFails = false;
let detailFails = false;
let analyzeGate;
let detailFingerprint = '测试正文指纹';
/** 渐进扫描模拟开关：开启后 refresh 只回首包 + jobId，由 scanProgress 轮询补齐。 */
let scanJobMode = false;
const scanPolls = [];
/** 模拟禅道 Token 过期：除登录/读配置/退出外的端点全部回 unauthorized。 */
let authFails = false;
const analyzeReply = {
  kind: 'task',
  id: '42',
  title: '补充单元测试',
  category: 'bug',
  categoryLabel: 'Bug 修复',
  confidence: 86,
  headline: '筛选条件为空时没兜底，列表直接崩了',
  reason: '详情里的重现步骤写明「点击筛选即白屏」，属功能与预期不符。',
  steps: ['复现并抓到报错栈', '在列表渲染前补空值兜底', '补一条回归用例'],
  questions: ['只有「筛选」入口会触发吗？'],
  provider: 'deepseek',
  model: 'deepseek-flash',
  routeSource: 'dsh',
  analyzedAt: '2026-10-08T00:00:00.000Z',
  contentFingerprint: '测试正文指纹',
};
const rpc = {
  async fetch(url, init) {
    const endpoint = decodeURIComponent(String(url).slice('/zentao-workbench/'.length));
    const payload = JSON.parse(init?.body ?? '{}');
    if (authFails && endpoint !== 'login' && endpoint !== 'getConfig' && endpoint !== 'logout' && endpoint !== 'scanProgress') {
      // 模拟 Token 过期：宿主回 unauthorized（可恢复），而不是把 401 当普通错误抛出来。
      calls.push({ endpoint, url, method: init?.method, headers: init?.headers, credentials: init?.credentials, payload });
      return { status: 200, async json() { return { ok: false, error: { code: 'unauthorized', message: '禅道登录状态已失效，请重新登录。' } }; } };
    }
    calls.push({ endpoint, url, method: init?.method, headers: init?.headers, credentials: init?.credentials, payload });
    if (endpoint === 'analyze' && analyzeGate !== undefined) await analyzeGate;
    const body = (() => {
      if (endpoint === 'getConfig') return { ok: true, value: loggedInConfig };
      if (endpoint === 'forgetPassword') return { ok: true, value: { ...loggedInConfig, rememberPassword: false } };
      if (endpoint === 'refresh') {
        // 真实宿主会按 scope 只回对应类别，并回带 scopes 让客户端合并（而不是整体替换）。
        const scope = payload.scope ?? 'all';
        const scopes =
          scope === 'all'
            ? ['tasks', 'bugs', 'stories']
            : scope === 'bugs'
              ? ['tasks', 'bugs']
              : scope === 'stories'
                ? ['tasks', 'stories']
                : ['tasks'];
        // scanJobMode：模拟「宿主没等扫完就返回」的渐进路径（首包空 + jobId）。
        const jobs = scanJobMode && scope !== 'tasks'
          ? [{ kind: scope === 'stories' ? 'stories' : 'bugs', id: 'job-1', done: 0, total: 2, finished: false }]
          : [];
        return {
          ok: true,
          value: {
            ...loggedInData,
            scopes,
            cached: false,
            jobs,
            bugs: scanJobMode && scope !== 'stories' ? [] : loggedInData.bugs,
            stories: scanJobMode && scope === 'stories' ? [] : loggedInData.stories,
          },
        };
      }
      if (endpoint === 'scanProgress') {
        scanPolls.push(payload.jobId);
        // 第一次还没扫完，第二次返回最终结果 —— 覆盖「边扫边显示」与「扫完停止轮询」。
        const finished = scanPolls.filter((id) => id === payload.jobId).length >= 2;
        return {
          ok: true,
          value: {
            missing: false,
            finished,
            done: finished ? 2 : 1,
            total: 2,
            error: '',
            bugs: finished ? loggedInData.bugs : [],
            stories: finished ? loggedInData.stories : [],
          },
        };
      }
      if (endpoint === 'fetchDetail') {
        if (detailFails) return { ok: false, error: { code: 'detail-failed', message: '测试详情失败' } };
        // 真实宿主形态：sections（描述 / 步骤）+ attachments（正文内嵌图片补全成绝对地址）。
        return {
          ok: true,
          value: {
            kind: payload.kind ?? 'task',
            contentFingerprint: detailFingerprint,
            id: payload.id,
            title: '列表页崩溃',
            status: 'active',
            statusLabel: '激活',
            assignedTo: 'zhangsan',
            openedBy: 'lisi',
            sections: [
              { label: '重现步骤', text: '点击筛选即白屏\n[附件] http://zentao.example.com:11180/zentao/file-read-16547.png' },
              { label: '描述', text: '偶发，刷新后恢复' },
            ],
            // 真实宿主 normalizeDetail 会把 sections 合成一段纯文本 description（lib/index.js:593）——
            // 提示词里的正文用的就是它。
            description: '点击筛选即白屏\n[附件] http://zentao.example.com:11180/zentao/file-read-16547.png\n\n偶发，刷新后恢复',
            attachments: [
              {
                name: 'file-read-16547.png',
                url: 'http://zentao.example.com:11180/zentao/file-read-16547.png',
                proxyUrl: '/zentao-workbench/attachment?url=http%3A%2F%2Fzentao.example.com%3A11180%2Fzentao%2Ffile-read-16547.png',
              },
              {
                // 真实实例（任务 #10001）确实挂了 mp4：名字是哈希、扩展名来自 files[].extension。
                name: '3731022dfe2104eb2ec746e27b619cc7.mp4',
                url: 'http://zentao.example.com:11180/zentao/file-read-31001.mp4',
                proxyUrl: '/zentao-workbench/attachment?url=http%3A%2F%2Fzentao.example.com%3A11180%2Fzentao%2Ffile-read-31001.mp4',
              },
              {
                // 非媒体附件：word/excel/ppt 走「用系统默认程序打开」。
                name: '需求说明.docx',
                url: 'http://zentao.example.com:11180/zentao/file-read-32001.docx',
                proxyUrl: '/zentao-workbench/attachment?url=http%3A%2F%2Fzentao.example.com%3A11180%2Fzentao%2Ffile-read-32001.docx',
              },
              {
                // PDF 在工作台里用 iframe 预览（宿主代理带 content-disposition: inline）。
                name: '作业指导书.pdf',
                url: 'http://zentao.example.com:11180/zentao/file-read-32002.pdf',
                proxyUrl: '/zentao-workbench/attachment?url=http%3A%2F%2Fzentao.example.com%3A11180%2Fzentao%2Ffile-read-32002.pdf',
              },
            ],
            link: 'http://x/zentao/bug-view-101.html',
            // 宿主 2026-10 新增：任务挂在研发需求上时给出 story + 散字段 meta。
            story: {
              id: '2001',
              title: '【示例】APS 提示词改为正常沟通的术语',
              status: 'active',
              statusLabel: '激活',
              link: 'http://zentao.example.com:11180/zentao/story-view-2001.html',
            },
            fromBug: '3001',
            fromBugLink: 'http://zentao.example.com:11180/zentao/bug-view-3001.html',
            meta: [
              { label: '所属执行', value: '示例执行' },
              { label: '类型', value: '开发' },
              { label: '严重程度', value: '3 轻微' },
              { label: '预计工时', value: '1' },
            ],
            actions: [{ date: '2026-10-08 14:14:47', actor: '肖潇雨', action: 'opened', actionLabel: '创建', comment: '由 Bug 转入' }],
          },
        };
      }
      if (endpoint === 'startTask') return { ok: true, value: startTaskReply };
      if (endpoint === 'analyze') {
        return analyzeFails
          ? { ok: false, error: { code: 'llm-failed', message: '模型调用未正常结束（error）：模型服务暂时不可用' } }
          : { ok: true, value: analyzeReply };
      }
      if (endpoint === 'finishTask') return { ok: true, value: finishTaskReply };
      if (endpoint === 'assignTask') return { ok: true, value: assignTaskReply };
      if (endpoint === 'listUsers') return { ok: true, value: usersReply };
      if (endpoint === 'openAttachment') {
        return openAttachmentFails
          ? { ok: false, error: { code: 'forbidden', message: '出于安全考虑，不支持用默认程序打开 .exe 附件' } }
          : { ok: true, value: openAttachmentReply };
      }
      return { ok: true, value: loggedInConfig };
    })();
    return {
      status: 200,
      async json() {
        return body;
      },
    };
  },
};

globalThis.fetch = (url, init) => rpc.fetch(url, init);

const sentPrompts = [];
const sessionApi = [];
const uiCalls = [];

const conversationService = {
  async send(text) {
    sentPrompts.push(text);
  },
};

// 两个工作区：ws-1 是「主面板正在看」的项目，ws-9 的会话更新（所以「最近活跃」会指向 ws-9）。
const workspaceItems = [
  { workspaceId: 'ws-1', title: '禅道工作台插件', path: 'E:\\Eworkspace\\dsh-zentao-workbench', createdAt: '2026-01-01T00:00:00.000Z', sessionIds: ['session-1'] },
  { workspaceId: 'ws-9', title: '另一个项目', path: 'E:\\Eworkspace\\other', createdAt: '2026-08-01T00:00:00.000Z', sessionIds: ['session-2'] },
];
const sessionRows = {
  'session-1': { id: 'session-1', updatedAt: 100, retainedBy: { mainView: 1 } },
  'session-2': { id: 'session-2', updatedAt: 9999, retainedBy: {} },
};
const snapshotLog = [];
// 记录订阅回调：插件的 watchTarget 会订阅工作区/会话快照，第 12 节手动触发以验证「选中的工作区消失后回退」。
const listSubscribers = [];
const makeList = (name, snapshot) => ({
  getSnapshot: () => {
    const value = snapshot();
    snapshotLog.push({ name, value });
    return value;
  },
  subscribe(listener) {
    listSubscribers.push(listener);
    return () => {};
  },
});

// 忠实复刻本机 DSH 0.2.0-rc.2 的服务面：sessions 没有 open()、workspaces 没有 connectWorkspace()。
let uiAvailable = true;
const uiWorkspace = {
  async connectWorkspace(workspaceId) {
    uiCalls.push({ op: 'connectWorkspace', workspaceId });
    return 'session-ui';
  },
  openSession(sessionId) {
    uiCalls.push({ op: 'openSession', sessionId });
  },
};

const ctx = {
  effect(fn) { return fn(); },
  get(name) {
    if (name === 'uiWorkspace') return uiAvailable ? uiWorkspace : undefined;
    if (name === 'conversation') return conversationService;
    return undefined;
  },
  slots: {
    inject(name, factory) { slotHost = name; return factory(); },
    register(registration, Component) { slotRegistration = { registration, Component }; return () => {}; },
  },
  sessions: {
    list: makeList('sessions', () => ({ ids: Object.keys(sessionRows), byId: sessionRows, phase: 'ready' })),
    async create(opts) {
      sessionApi.push({ op: 'create', opts });
      return 'session-created';
    },
    retain(sessionId, options) {
      sessionApi.push({ op: 'retain', sessionId, options });
      return {
        sessionId,
        ready: Promise.resolve({ sessionId, ctx: { get: (name) => (name === 'conversation' ? conversationService : undefined) } }),
        release() { sessionApi.push({ op: 'release', sessionId }); },
      };
    },
    scope(id) {
      sessionApi.push({ op: 'scope', id });
      return undefined;
    },
  },
  workspaces: {
    list: makeList('workspaces', () => ({ items: workspaceItems })),
  },
};

console.log('\n== 2. apply()：样式注入与 slot 注册 ==');
try {
  mod.apply(ctx);
  caught = undefined;
} catch (error) {
  caught = error;
}
ok('apply() 不抛异常', caught === undefined, caught?.stack ?? caught);
ok('创建了 style 元素', createdStyles.length === 1, createdStyles.length);
ok('style 带 data-plugin-css 标记', createdStyles[0]?.dataset?.pluginCss === 'dsh-zentao-workbench', JSON.stringify(createdStyles[0]?.dataset));
ok('style 已插入 head 且内容非空', appendedStyles.length === 1 && appendedStyles[0]._text.includes('.dzw-root'), appendedStyles[0]?._text?.length);
ok('注册到 shell.overlay', slotHost === 'shell.overlay', slotHost);
ok('slot 名与 id 正确', slotRegistration?.registration?.name === 'shell.overlay' && slotRegistration.registration.id === 'zentao-workbench', JSON.stringify(slotRegistration?.registration));
ok('slot order=20', slotRegistration?.registration.order === 20);
ok('注册了 React 组件', typeof slotRegistration.Component === 'function');
const cssText = appendedStyles[0]?._text ?? '';
ok('样式含详情悬浮卡片（无全屏遮罩层）', cssText.includes('.dzw-modal') && !cssText.includes('.dzw-mask'), cssText.slice(0, 200));
ok('tab 按钮不再被压缩（flex: 1 0 auto + nowrap）', /\.dzw-tab\s*\{[^}]*flex:\s*1 0 auto/.test(cssText) && /\.dzw-tab\s*\{[^}]*white-space:\s*nowrap/.test(cssText), cssText.match(/\.dzw-tab\s*\{[^}]*\}/)?.[0]);
ok('附件样式存在', cssText.includes('.dzw-attach'));
ok('正文/次要文字用的是可读的 label-secondary（caption 在浅色主题下太淡）', !cssText.includes('--dsw-alias-label-caption') && cssText.includes('--dsw-alias-label-secondary') && /\.dzw-section pre\s*\{[^}]*color:\s*var\(--dsw-alias-label-primary/.test(cssText));
ok('悬浮卡片 fixed、浮在面板左侧且不压暗（无 inset: 0 / 无遮罩色）', /\.dzw-modal\s*\{[^}]*position:\s*fixed/.test(cssText) && !/\.dzw-modal\s*\{[^}]*inset:\s*0/.test(cssText) && !/\.dzw-modal\s*\{[^}]*--dsw-alias-bg-mask/.test(cssText) && /\.dzw-modal\s*\{[^}]*right:\s*430px/.test(cssText) && /\.dzw-modal\s*\{[^}]*bottom:\s*78px/.test(cssText));
ok('缩略图样式限高并带边框', /\.dzw-thumb\s*\{[^}]*max-height:\s*190px/.test(cssText) && /\.dzw-thumb\s*\{[^}]*border:/.test(cssText));
ok(
  '面板高度固定（切分类 / 空列表都不缩水）',
  /\.dzw-root\s*\{[^}]*--dzw-frame-height:\s*min\(76vh,\s*720px\)/.test(cssText) &&
    /\.dzw-panel\s*\{[^}]*height:\s*var\(--dzw-frame-height\)/.test(cssText) &&
    /\.dzw-list\s*\{[^}]*flex:\s*1/.test(cssText) &&
    /\.dzw-list\s*\{[^}]*overflow-y:\s*auto/.test(cssText),
);
ok(
  '详情卡片与工作台面板等高',
  /\.dzw-modal\s*\{[^}]*height:\s*var\(--dzw-frame-height\)/.test(cssText) && /\.dzw-modal-body\s*\{[^}]*flex:\s*1/.test(cssText),
);
ok(
  '放大预览层：透明点击层（fixed + inset: 0 + z-index 70，盖在详情卡片 z-index 60 之上）**不铺灰色遮罩**',
  /\.dzw-preview\s*\{[^}]*position:\s*fixed/.test(cssText) &&
    /\.dzw-preview\s*\{[^}]*inset:\s*0/.test(cssText) &&
    /\.dzw-preview\s*\{[^}]*z-index:\s*70/.test(cssText) &&
    /\.dzw-preview\s*\{[^}]*background:\s*transparent/.test(cssText) &&
    !/\.dzw-preview\s*\{[^}]*--dsw-alias-bg-mask/.test(cssText),
  cssText.match(/\.dzw-preview\s*\{[^}]*\}/)?.[0],
);
ok(
  '预览图片装在一张悬浮卡片里（边框 + 阴影 + 圆角，不整屏铺灰）',
  /\.dzw-preview-card\s*\{[^}]*border:/.test(cssText) &&
    /\.dzw-preview-card\s*\{[^}]*box-shadow:/.test(cssText) &&
    /\.dzw-preview-card\s*\{[^}]*background:\s*var\(--dsw-alias-bg-layer-2/.test(cssText) &&
    !/\.dzw-preview-card\s*\{[^}]*inset:\s*0/.test(cssText),
  cssText.match(/\.dzw-preview-card\s*\{[^}]*\}/)?.[0],
);
ok(
  '大图按视口缩放且不变形（max-width/max-height + object-fit: contain）',
  /\.dzw-preview-img\s*\{[^}]*max-width:/.test(cssText) &&
    /\.dzw-preview-img\s*\{[^}]*max-height:\s*calc\(100vh - 150px\)/.test(cssText) &&
    /\.dzw-preview-img\s*\{[^}]*object-fit:\s*contain/.test(cssText),
  cssText.match(/\.dzw-preview-img\s*\{[^}]*\}/)?.[0],
);
ok(
  '预览卡片底部有关闭行 + 提示（不让人以为只有右上角能关）',
  /\.dzw-preview-foot\s*\{[^}]*display:\s*flex/.test(cssText) && /\.dzw-preview-hint\s*\{/.test(cssText),
);
ok('缩略图与「放大」都是手型光标', /\.dzw-thumb-link\s*\{[^}]*cursor:\s*zoom-in/.test(cssText) && /\.dzw-zoom\s*\{[^}]*cursor:\s*zoom-in/.test(cssText));
ok(
  'AI 预判块样式存在（虚线框标出「这只是参考」+ 类别加粗）',
  /\.dzw-analysis\s*\{[^}]*border:\s*1px dashed/.test(cssText) &&
    /\.dzw-analysis\s*\{[^}]*border-radius:\s*var\(--dsw-radius-xs/.test(cssText) &&
    /\.dzw-analysis-tag\s*\{[^}]*font-weight:\s*600/.test(cssText),
  cssText.match(/\.dzw-analysis\s*\{[^}]*\}/)?.[0],
);
ok(
  '回退说明的样式用可读的 label-secondary（不引新令牌）',
  /\.dzw-analysis-note\s*\{[^}]*color:\s*var\(--dsw-alias-label-secondary/.test(cssText),
  cssText.match(/\.dzw-analysis-note\s*\{[^}]*\}/)?.[0],
);
ok(
  '视频附件样式存在（卡片里高度 190px 的播放器 + 大屏预览同样按视口缩放）',
  /\.dzw-video\s*\{[^}]*max-height:\s*190px/.test(cssText) &&
    /\.dzw-video\s*\{[^}]*background:\s*#000/.test(cssText) &&
    /\.dzw-preview-video\s*\{[^}]*max-height:\s*calc\(100vh - 150px\)/.test(cssText) &&
    /\.dzw-preview-video\s*\{[^}]*background:\s*#000/.test(cssText),
  cssText.match(/\.dzw-video\s*\{[^}]*\}/)?.[0],
);
ok(
  'PDF 预览样式存在（高框 iframe，跟着视口走）',
  /\.dzw-preview-pdf\s*\{[^}]*display:\s*block/.test(cssText) &&
    /\.dzw-preview-pdf\s*\{[^}]*height:\s*calc\(100vh - 190px\)/.test(cssText) &&
    /\.dzw-preview-pdf\s*\{[^}]*border:/.test(cssText),
  cssText.match(/\.dzw-preview-pdf\s*\{[^}]*\}/)?.[0],
);
ok(
  '关闭按钮做得醒目：实心底色 + 边框 + 阴影，右上角那颗固定在视口角落并压在图上（深色半透明底）',
  /\.dzw-preview-close\s*\{[^}]*background:\s*var\(--dsw-alias-bg-layer-3/.test(cssText) &&
    /\.dzw-preview-close\s*\{[^}]*border:\s*1px solid/.test(cssText) &&
    /\.dzw-preview-close\s*\{[^}]*box-shadow:/.test(cssText) &&
    /\.dzw-preview-close-float\s*\{[^}]*position:\s*fixed/.test(cssText) &&
    /\.dzw-preview-close-float\s*\{[^}]*top:\s*16px/.test(cssText) &&
    /\.dzw-preview-close-float\s*\{[^}]*right:\s*16px/.test(cssText) &&
    /\.dzw-preview-close-float\s*\{[^}]*z-index:\s*71/.test(cssText) &&
    /\.dzw-preview-close-float\s*\{[^}]*background:\s*var\(--dsw-alias-bg-mask-3/.test(cssText) &&
    /\.dzw-preview-close-solid\s*\{[^}]*background:\s*var\(--dsw-alias-button-primary-fill/.test(cssText),
  cssText.match(/\.dzw-preview-close-float\s*\{[^}]*\}/)?.[0],
);
ok('所有用到的 --dsw-* 令牌都在 DSH 主题确有定义（无拼错）', (() => {
  // DSH 0.2.0-rc.2 主题令牌白名单（取自 dsh-client-ui-theme 的默认值集合）。
  // 拼错一个令牌不会报错，只会静默走 fallback —— 曾经把 --dsw-alias-bg-mask 写成了不存在的名字。
  const known = new Set([
    '--dsw-alias-bg-layer-2', '--dsw-alias-bg-layer-3', '--dsw-alias-bg-mask-1', '--dsw-alias-bg-mask-2',
    '--dsw-alias-bg-mask-3', '--dsw-alias-border-l1', '--dsw-alias-border-l2', '--dsw-alias-border-l3',
    '--dsw-alias-border-l4', '--dsw-alias-button-primary-fill', '--dsw-alias-button-primary-hover',
    '--dsw-alias-interactive-bg-active', '--dsw-alias-interactive-bg-hover',
    '--dsw-alias-interactive-bg-hover-danger', '--dsw-alias-label-dimmed', '--dsw-alias-label-primary',
    '--dsw-alias-label-primary-foreground', '--dsw-alias-label-secondary', '--dsw-alias-label-tertiary',
    '--dsw-alias-link', '--dsw-alias-scrollbar-bg-l2', '--dsw-alias-state-business-primary',
    '--dsw-alias-state-error-primary', '--dsw-alias-state-success-primary', '--dsw-font-family',
    '--dsw-menu-backdrop-filter', '--dsw-menu-surface-fill', '--dsw-radius-lg', '--dsw-radius-sm',
    '--dsw-radius-xs', '--dsw-shadow-lv3', '--dsw-specific-input-major', '--dsw-specific-menu',
  ]);
  const used = Array.from(new Set(Array.from(cssText.matchAll(/var\((--dsw-[a-z0-9-]+)/g), (m) => m[1])));
  const unknown = used.filter((name) => !known.has(name));
  if (unknown.length > 0) return false;
  const themePath = process.env.DSH_THEME_BUNDLE;
  if (themePath === undefined || !existsSync(themePath)) return true;
  const theme = readFileSync(themePath, 'utf8');
  return used.every((name) => theme.includes(`${name}:`));
})(), (() => {
  const used = Array.from(new Set(Array.from(cssText.matchAll(/var\((--dsw-[a-z0-9-]+)/g), (m) => m[1])));
  return used.join(' ');
})());

// ---------------------------------------------------------------------------
// 极简渲染器：递归展开函数组件
// ---------------------------------------------------------------------------

function render(node, depth = 0) {
  if (node === null || node === undefined || typeof node === 'boolean') return null;
  if (typeof node === 'string' || typeof node === 'number') return node;
  if (Array.isArray(node)) return node.map((child) => render(child, depth + 1));
  if (typeof node.type === 'function') {
    if (depth > 40) throw new Error('渲染递归过深（疑似无限渲染）');
    return render(node.type({ ...node.props, children: node.children }), depth + 1);
  }
  return { type: node.type, props: node.props, children: node.children.map((child) => render(child, depth + 1)) };
}

function walk(tree, visit) {
  if (tree === null || tree === undefined || typeof tree === 'boolean') return;
  if (Array.isArray(tree)) { tree.forEach((child) => walk(child, visit)); return; }
  visit(tree);
  if (typeof tree === 'object') tree.children?.forEach((child) => walk(child, visit));
}

function textOf(tree) {
  let out = '';
  walk(tree, (node) => { if (typeof node === 'string' || typeof node === 'number') out += `${String(node)} `; });
  return out;
}

/** 收集所有带 onClick 的元素（按钮 + 可点击标题）。 */
const clickablesOf = (tree) => {
  const found = [];
  walk(tree, (node) => { if (typeof node === 'object' && node !== null && typeof node.props?.onClick === 'function') found.push(node); });
  return found;
};
const findByText = (tree, needle) => clickablesOf(tree).find((node) => textOf(node).includes(needle));

/** 按 className 收集**所有**匹配节点（findByClass 只给第一个）。 */
const walkCollect = (tree, cls) => {
  const found = [];
  walk(tree, (node) => {
    if (typeof node !== 'object' || node === null) return;
    const className = node.props?.className;
    if (typeof className === 'string' && className.split(/\s+/).includes(cls)) found.push(node);
  });
  return found;
};

/** 按 className（支持多类名）找第一个匹配节点。 */
const findByClass = (tree, cls) => {
  let hit;
  walk(tree, (node) => {
    if (hit !== undefined || typeof node !== 'object' || node === null) return;
    const className = node.props?.className;
    if (typeof className === 'string' && className.split(/\s+/).includes(cls)) hit = node;
  });
  return hit;
};

/** 渲染一趟；presets 是这一趟注入的初始 state（按 useState 调用顺序，undefined 用默认值）。 */
function renderPass(presets) {
  runCleanups();
  hookState.index = 0;
  hookState.presets = presets ?? [];
  hookState.setters = [];
  return render(slotRegistration.Component({}));
}

console.log('\n== 3. 渲染：首次挂载（未登录） ==');
// useState 顺序：open, target, config, form, busy, error, toast, tab, data, detail
// 首趟不给注入值：open 默认 true（面板直接展开），config 为 null（未登录）。
let tree;
try {
  tree = renderPass([]);
  caught = undefined;
} catch (error) {
  caught = error;
}
await flush();
ok('首屏渲染不抛异常', caught === undefined, caught?.stack ?? caught);
const firstText = textOf(tree);
ok('显示面板标题', firstText.includes('禅道工作台'), firstText.slice(0, 160));
ok('显示登录表单字段', ['服务器', '账号', '密码', '登录'].every((label) => firstText.includes(label)), firstText.slice(0, 200));
ok('登录表单不再有职位选择', !firstText.includes('职位'), firstText.slice(0, 200));
ok('显示未登录状态', firstText.includes('未登录'));
ok('挂载后调用 getConfig', calls.some((entry) => entry.endpoint === 'getConfig'), JSON.stringify(calls));

console.log('\n== 4. 渲染：已登录 + 有数据 ==');
// 注入 open=true、target=默认、config=已登录、tab=task、data=有数据；其余用默认值。
try {
  tree = renderPass([true, undefined, loggedInConfig, undefined, undefined, undefined, undefined, 'task', loggedInData, null]);
  caught = undefined;
} catch (error) {
  caught = error;
}
await flush();
ok('已登录渲染不抛异常', caught === undefined, caught?.stack ?? caught);
if (process.env.DEBUG_HOOKS === '1') console.error('[debug] useState 调用次数 =', hookState.index, '| presets 长度 =', hookState.presets.length);
const treeText = textOf(tree);
ok('显示账号名（职位选择已取消）', treeText.includes('张三') && !treeText.includes('职位'), treeText.slice(0, 200));
ok('显示任务标题', treeText.includes('修复登录超时'));
ok('三个 tab 都在', ['任务', 'Bug', '需求'].every((label) => treeText.includes(label)));
ok('有「处理」按钮', findByText(tree, '处理') !== undefined);
ok('有「复制提示词」按钮', findByText(tree, '复制提示词') !== undefined);
ok('有原始链接', treeText.includes('task-view-11.html') || JSON.stringify(tree).includes('task-view-11.html'));
ok('有刷新与收起按钮', findByText(tree, '刷新') !== undefined && findByText(tree, '收起') !== undefined);
ok(
  '显示发送目标（来自主面板当前工作区，而不是「最近活跃」的 ws-9）',
  treeText.includes('发送目标：禅道工作台插件（E:\\Eworkspace\\dsh-zentao-workbench）'),
  treeText.slice(0, 300),
);
// 列表按 id 倒序：42 → 11 → 7（loggedInData 故意乱序给出）。
const order = ['补充单元测试', '修复登录超时', '历史遗留任务'].map((title) => treeText.indexOf(title));
ok('任务列表按 ID 倒序（42 → 11 → 7）', order.every((index) => index >= 0) && order[0] < order[1] && order[1] < order[2], JSON.stringify(order));
ok(
  '列表状态显示中文（未开始 / 进行中 / 已完成）',
  ['未开始', '进行中', '已完成'].every((label) => treeText.includes(label)) && !treeText.includes('wait'),
  treeText.slice(0, 300),
);

console.log('\n== 5. 交互：点「处理」建会话并发送提示词（uiWorkspace 可用） ==');
const handle = findByText(tree, '处理');
try {
  handle.props.onClick();
  await flush();
  caught = undefined;
} catch (error) {
  caught = error;
}
ok('点击「处理」不抛异常', caught === undefined, caught?.stack ?? caught);
if (process.env.DEBUG_HANDLE === '1') {
  console.error('[debug] handle =', JSON.stringify(textOf(handle).slice(0, 60)));
  console.error('[debug] uiCalls =', JSON.stringify(uiCalls));
  console.error('[debug] sessionApi =', JSON.stringify(sessionApi));
  console.error('[debug] sent =', sentPrompts.length);
  console.error('[debug] snapshots =', JSON.stringify(snapshotLog.map((entry) => ({ name: entry.name, keys: Object.keys(entry.value), items: entry.value.items?.length, byId: entry.value.byId && Object.keys(entry.value.byId) }))));
}
ok('点击「处理」没有未处理的异步失败', unhandled.length === 0, unhandled.map((reason) => reason?.stack ?? String(reason)).join('\n'));
ok('选中了主面板当前工作区 ws-1', uiCalls.some((entry) => entry.op === 'connectWorkspace' && entry.workspaceId === 'ws-1'), JSON.stringify(uiCalls));
ok('用的是 uiWorkspace.connectWorkspace（DSH 真实 API）', uiCalls.some((entry) => entry.op === 'connectWorkspace'), JSON.stringify(uiCalls));
ok('在界面上打开了新会话', uiCalls.some((entry) => entry.op === 'openSession' && entry.sessionId === 'session-ui'), JSON.stringify(uiCalls));
ok('retain 了新会话（source=zentao-workbench）', sessionApi.some((entry) => entry.op === 'retain' && entry.sessionId === 'session-ui' && entry.options?.source === 'zentao-workbench'), JSON.stringify(sessionApi));
ok('打开后释放了 retain 引用', sessionApi.some((entry) => entry.op === 'release' && entry.sessionId === 'session-ui'), JSON.stringify(sessionApi));
ok('没有依赖不存在的 sessions.open / workspaces.connectWorkspace', typeof ctx.sessions.open === 'undefined' && typeof ctx.workspaces.connectWorkspace === 'undefined');
ok('向 conversation.send 发送了提示词', sentPrompts.length === 1, sentPrompts.length);
ok(
  '提示词抬头先要求判类别（Bug 修复 / 体验或性能优化 / 新增需求 / 其它）',
  sentPrompts[0]?.includes('第一步：先判类别') && sentPrompts[0].includes('Bug 修复 / 体验或性能优化 / 新增需求 / 其它'),
  sentPrompts[0]?.slice(0, 200),
);
ok(
  '提示词按类别给了四套套路（不再只有开发一套话术）',
  ['Bug 修复：复现路径', '体验或性能优化：现状与基线', '新增需求：目标与验收标准', '其它：先澄清目标'].every((line) => sentPrompts[0]?.includes(line)),
  sentPrompts[0]?.slice(0, 400),
);
ok(
  '提示词带上了正文（fetchDetail 的描述 / 重现步骤）',
  sentPrompts[0]?.includes('### 描述 / 重现步骤 / 研发需求') && sentPrompts[0].includes('点击筛选即白屏'),
  sentPrompts[0]?.slice(0, 600),
);
ok(
  '提示词列出了附件清单',
  sentPrompts[0]?.includes('### 附件（4 个）') && sentPrompts[0].includes('需求说明.docx'),
  sentPrompts[0]?.slice(0, 700),
);
ok(
  '提示词带字段线索段（工作台先给一个确定性猜测，判断权仍在模型）',
  sentPrompts[0]?.includes('## 线索') && sentPrompts[0].includes('工作台的初步猜测：其它'),
  sentPrompts[0]?.slice(0, 500),
);
// 点的是渲染后的第一条（ID 最大 = 42 补充单元测试）。
ok(
  '提示词含条目标题与详情指引',
  sentPrompts[0]?.includes('补充单元测试') && sentPrompts[0].includes('action=detail'),
  sentPrompts[0]?.slice(-200),
);
ok('提示词带禅道原始链接', sentPrompts[0]?.includes('task-view-42.html'), sentPrompts[0]?.slice(-300));
ok('提示词指明当前工作区（标题 + 绝对路径）', sentPrompts[0]?.includes('当前工作区') && sentPrompts[0]?.includes('E:\\Eworkspace\\dsh-zentao-workbench'), sentPrompts[0]?.slice(-400));

console.log('\n== 5b. 交互：AI 分析（先判 Bug / 优化 / 需求，结论再带进提示词） ==');
// 这一段刻意自带两个小工具（后面的 P() / byExactText 定义在更下面，这里够不着）。
const exactButtons = (t, needle) => clickablesOf(t).filter((node) => textOf(node).trim() === needle);
const T = (over) => [
  over.open ?? true, undefined, loggedInConfig, undefined, undefined, undefined, undefined,
  over.tab ?? 'task', over.data ?? loggedInData,
  over.detail === undefined ? null : over.detail,
  null, null, null, null, '',
  over.analyses ?? undefined,
  over.progress ?? undefined,
  over.authExpired ?? undefined,
];
tree = renderPass(T({}));
await flush();
const analyzeButtons = exactButtons(tree, 'AI 分析');
ok('每条任务都有「AI 分析」按钮（3 条 → 3 个）', analyzeButtons.length === 3, analyzeButtons.length);
ok(
  '「AI 分析」按钮的 title 说明结论会带进提示词',
  String(analyzeButtons[0]?.props?.title ?? '').includes('带进提示词'),
  JSON.stringify(analyzeButtons[0]?.props?.title),
);
const analyzeBefore = calls.filter((entry) => entry.endpoint === 'analyze').length;
try {
  analyzeButtons[0].props.onClick();
  await flush();
  caught = undefined;
} catch (error) {
  caught = error;
}
ok('点「AI 分析」不抛异常', caught === undefined, caught?.stack ?? caught);
ok('也没有未处理的异步失败', unhandled.length === 0, unhandled.map((reason) => reason?.stack ?? String(reason)).join('\n'));
const analyzeCalls = calls.filter((entry) => entry.endpoint === 'analyze');
ok('调用宿主 analyze 端点', analyzeCalls.length === analyzeBefore + 1, JSON.stringify(analyzeCalls.map((entry) => entry.payload)));
ok(
  'analyze 载荷带 kind 与 id（点的是 #42）',
  analyzeCalls.at(-1)?.payload?.kind === 'task' && analyzeCalls.at(-1)?.payload?.id === '42',
  JSON.stringify(analyzeCalls.at(-1)?.payload),
);
const analysesSetter = hookState.setters.findLast((entry) => entry.index === 15);
ok(
  '预判结果写进第 16 个 state（analyses，下标 15，键含账号与条目版本）',
  Object.entries(analysesSetter?.value ?? {}).some(([key, value]) => {
    const [server, account, kind, item] = JSON.parse(key);
    return server === loggedInConfig.server && account === loggedInConfig.account && kind === 'task' && item.id === '42' && value?.category === 'bug' && value.confidence === 86;
  }),
  JSON.stringify(analysesSetter?.value),
);
ok(
  '分析成功后给提示（类别 + 置信度）',
  String(hookState.setters.find((entry) => entry.index === 6)?.value ?? '').includes('AI 预判：Bug 修复') &&
    String(hookState.setters.find((entry) => entry.index === 6)?.value ?? '').includes('置信度 86'),
  JSON.stringify(hookState.setters.find((entry) => entry.index === 6)?.value),
);

const cacheKey42 = JSON.stringify([loggedInConfig.server, loggedInConfig.account, 'task', loggedInData.tasks.find((item) => item.id === '42')]);
const analysisFor42 = (extra = {}) => ({
  [cacheKey42]: { ...analyzeReply, ...extra },
});
tree = renderPass(T({ analyses: analysisFor42() }));
await flush();
const analysisBlock = findByClass(tree, 'dzw-analysis');
ok('列表行下方渲染 AI 预判块', analysisBlock !== undefined);
ok(
  '预判块显示中文类别 + 置信度 + 模型',
  analysisBlock !== undefined &&
    textOf(analysisBlock).includes('Bug 修复') &&
    textOf(analysisBlock).includes('置信度 86') &&
    textOf(analysisBlock).includes('deepseek/deepseek-flash'),
  analysisBlock === undefined ? '(没有预判块)' : textOf(analysisBlock),
);
ok('预判块给出依据与一句话结论', textOf(analysisBlock).includes('筛选条件为空时没兜底') && textOf(analysisBlock).includes('依据：'), textOf(analysisBlock));
ok(
  '预判块列出建议步骤与待确认项',
  textOf(findByClass(tree, 'dzw-analysis-steps')).includes('补一条回归用例') && textOf(analysisBlock).includes('待确认：只有「筛选」入口会触发吗？'),
  textOf(analysisBlock),
);
ok('有预判的那条按钮变成「重新分析」（只有 #42 分析过 → 1 个）', exactButtons(tree, '重新分析').length === 1, exactButtons(tree, '重新分析').length);
ok(
  '预判块标出模型来源（跟随 DSH 默认模型）',
  textOf(analysisBlock).includes('deepseek/deepseek-flash（DSH 默认模型）'),
  textOf(analysisBlock),
);
tree = renderPass(T({ analyses: analysisFor42({ truncated: true }) }));
await flush();
ok(
  '输出被截断时预判块如实标注',
  textOf(findByClass(tree, 'dzw-analysis')).includes('输出可能被截断'),
  textOf(findByClass(tree, 'dzw-analysis')),
);
tree = renderPass(T({ analyses: analysisFor42() }));
await flush();

// 带预判再点「处理」：提示词要同时含正文、附件、线索与 AI 预判。
sentPrompts.length = 0;
hookState.setters = [];
const handleWithAnalysis = findByText(tree, '处理');
try {
  handleWithAnalysis.props.onClick();
  await flush(12);
  caught = undefined;
} catch (error) {
  caught = error;
}
ok('带预判点「处理」不抛异常', caught === undefined, caught?.stack ?? caught);
ok('提示词含 AI 预判段（类别 + 一句话 + 步骤 + 待确认）', (() => {
  const text = sentPrompts[0] ?? '';
  return (
    text.includes('## AI 预判（工作台按当前模型给出') &&
    text.includes('类别：Bug 修复（置信度 86）') &&
    text.includes('一句话：筛选条件为空时没兜底') &&
    text.includes('1. 复现并抓到报错栈') &&
    text.includes('待确认：只有「筛选」入口会触发吗？')
  );
})(), sentPrompts[0]?.slice(0, 900));
ok(
  '提示词里写明预判由哪个模型给出',
  (sentPrompts[0] ?? '').includes('由 deepseek/deepseek-flash（DSH 默认模型）在'),
  sentPrompts[0]?.slice(0, 900),
);
ok(
  '预判不替代正文：提示词仍带详情正文与附件',
  sentPrompts[0]?.includes('点击筛选即白屏') && sentPrompts[0].includes('### 附件（4 个）'),
  sentPrompts[0]?.slice(0, 900),
);

// analyze 失败：只提示，不写入预判。
analyzeFails = true;
hookState.setters = [];
const reanalyzeButtons = exactButtons(tree, '重新分析');
try {
  reanalyzeButtons[0].props.onClick();
  await flush();
  caught = undefined;
} catch (error) {
  caught = error;
}
analyzeFails = false;
ok('analyze 失败时不抛异常', caught === undefined, caught?.stack ?? caught);
ok(
  'analyze 失败时把宿主错误显示到面板错误条（run() 的错误走 error state）',
  // run() 先 setError('') 再 setError(message)，同一个 state 会 push 两个 setter，取最后一个。
  String(
    hookState.setters.filter((entry) => entry.index === 5).at(-1)?.value ?? '',
  ).includes('模型调用未正常结束'),
  JSON.stringify(hookState.setters.filter((entry) => entry.index === 5).map((entry) => entry.value)),
);
ok(
  'analyze 失败时不写脏预判（analyses 没被改）',
  !hookState.setters.some((entry) => entry.index === 15),
  JSON.stringify(hookState.setters.filter((entry) => entry.index === 15).map((entry) => entry.value)),
);
ok('失败后仍可重试（「重新分析」按钮还在）', exactButtons(tree, '重新分析').length === 1, exactButtons(tree, '重新分析').length);

// 宿主回退到自动挑路由时：界面上要给出说明，提示词也要带上。
const routeNoteReply = {
  ...analyzeReply,
  routeSource: 'auto',
  routeNote: 'DSH 默认模型 zai-coding-cn/glm-5.3 在当前实例里没有注册，已改为自动挑选一条可用路由。',
};
tree = renderPass(T({ analyses: analysisFor42(routeNoteReply) }));
await flush();
const routeNoteBlock = findByClass(tree, 'dzw-analysis');
ok(
  '回退时预判块标出「自动挑选」并显示说明',
  routeNoteBlock !== undefined &&
    textOf(routeNoteBlock).includes('（自动挑选）') &&
    textOf(routeNoteBlock).includes('已改为自动挑选一条可用路由'),
  routeNoteBlock === undefined ? '(没有预判块)' : textOf(routeNoteBlock),
);
sentPrompts.length = 0;
caught = undefined;
try {
  findByText(tree, '处理').props.onClick();
  await flush(12);
} catch (error) {
  caught = error;
}
ok('带回退说明再点「处理」不抛异常', caught === undefined, caught?.stack ?? caught);
ok(
  '回退说明也进提示词',
  (sentPrompts[0] ?? '').includes('- 说明：') && (sentPrompts[0] ?? '').includes('已改为自动挑选一条可用路由'),
  sentPrompts[0]?.slice(0, 900),
);

console.log('\n== 6. 交互：切到 Bug 页 + 详情弹窗 ==');
try {
  tree = renderPass([true, undefined, loggedInConfig, undefined, undefined, undefined, undefined, 'bug', loggedInData, null]);
  await flush();
  caught = undefined;
} catch (error) {
  caught = error;
}
ok('Bug 页渲染不抛异常', caught === undefined, caught?.stack ?? caught);
ok('Bug 页显示 Bug 标题', textOf(tree).includes('列表页崩溃'), textOf(tree).slice(0, 200));
ok('未点标题时没有弹窗', findByClass(tree, 'dzw-modal') === undefined);

// 切到没有条目的分类：面板仍要占满固定高度（原来会跟着内容缩成一小条）。
try {
  tree = renderPass([true, undefined, loggedInConfig, undefined, undefined, undefined, undefined, 'bug', { ...loggedInData, bugs: [] }, null]);
  await flush();
  caught = undefined;
} catch (error) {
  caught = error;
}
const emptyTabText = textOf(tree);
ok('空分类渲染不抛异常', caught === undefined, caught?.stack ?? caught);
ok(
  '空分类下面板仍在、列表换成空状态（高度靠固定高度撑住）',
  findByClass(tree, 'dzw-panel') !== undefined && findByClass(tree, 'dzw-list') === undefined && emptyTabText.includes('暂无条目'),
  emptyTabText.slice(0, 200),
);

// 回到 Bug 页继续做弹窗断言。
try {
  tree = renderPass([true, undefined, loggedInConfig, undefined, undefined, undefined, undefined, 'bug', loggedInData, null]);
  await flush();
  caught = undefined;
} catch (error) {
  caught = error;
}
ok('Bug 页恢复渲染不抛异常', caught === undefined, caught?.stack ?? caught);

const title = findByText(tree, '#101');
// 挂载时的自动刷新也会调用 setDetail(null)，先清空记录，只看点击之后的 setter。
hookState.setters = [];
try {
  title.props.onClick();
  await flush();
  caught = undefined;
} catch (error) {
  caught = error;
}
ok('点击标题拉详情不抛异常', caught === undefined, caught?.stack ?? caught);
ok('调用了 fetchDetail', calls.some((entry) => entry.endpoint === 'fetchDetail'), JSON.stringify(calls.map((entry) => entry.endpoint)));

// setState 被记录下来了：detail 是第 10 个 state（下标 9）。
const detailSetter = hookState.setters.find((entry) => entry.index === 9);
ok('点标题后把详情交给 detail state（弹窗开关）', detailSetter !== undefined && detailSetter.value?.key === 'bug-101', JSON.stringify(detailSetter));

// 用真实拿到的详情再渲染一趟，验证弹窗内容。
try {
  tree = renderPass([true, undefined, loggedInConfig, undefined, undefined, undefined, undefined, 'bug', loggedInData, detailSetter?.value ?? null]);
  await flush();
  caught = undefined;
} catch (error) {
  caught = error;
}
ok('弹窗渲染不抛异常', caught === undefined, caught?.stack ?? caught);
const modalText = textOf(tree);
ok('弹窗是悬浮卡片（不是全屏遮罩层）', findByClass(tree, 'dzw-modal') !== undefined && findByClass(tree, 'dzw-mask') === undefined);
ok('弹窗显示标题', modalText.includes('#101') && modalText.includes('列表页崩溃'), modalText.slice(0, 200));
ok('弹窗显示分段正文（重现步骤 / 描述）', modalText.includes('重现步骤') && modalText.includes('点击筛选即白屏') && modalText.includes('偶发，刷新后恢复'), modalText.slice(0, 300));
const attachLink = (() => {
  let hit;
  walk(tree, (node) => {
    if (hit !== undefined || typeof node !== 'object' || node === null) return;
    if (node.type === 'a' && String(node.props?.href ?? '').includes('file-read-16547.png')) hit = node;
  });
  return hit;
})();
ok('弹窗列出附件链接（新窗口打开）', attachLink !== undefined && attachLink.props.target === '_blank', JSON.stringify(attachLink?.props));
ok(
  '图片附件直接出缩略图，且走宿主代理地址',
  (() => {
    const thumb = findByClass(tree, 'dzw-thumb');
    return (
      thumb !== undefined &&
      thumb.type === 'img' &&
      String(thumb.props?.src ?? '').includes('/zentao-workbench/attachment?url=') &&
      String(thumb.props?.src ?? '').includes(encodeURIComponent('http://zentao.example.com:11180/zentao/file-read-16547.png'))
    );
  })(),
  JSON.stringify(findByClass(tree, 'dzw-thumb')?.props),
);
ok('正文里的 [附件] 行不再重复显示', !modalText.includes('[附件]'), modalText.slice(0, 400));
ok(
  '弹窗状态与历史动作显示中文（不再出现 opened / active）',
  modalText.includes('状态：激活') && modalText.includes('创建') && !modalText.includes('opened') && !modalText.includes('激活中'),
  modalText.slice(0, 400),
);
ok('弹窗有「在禅道中打开」入口', modalText.includes('在禅道中打开'));

// 研发需求（用户 m03893）：任务挂着需求时，弹窗要能看到需求标题/状态/描述，而不是「有内容却看不到」
const storyAnchor = (() => {
  let hit;
  walk(tree, (node) => {
    if (hit !== undefined || typeof node !== 'object' || node === null) return;
    if (node.type === 'a' && String(node.props?.href ?? '').includes('story-view-2001.html')) hit = node;
  });
  return hit;
})();
ok('弹窗给出研发需求链接（可跳禅道需求页）', storyAnchor !== undefined && storyAnchor.props.target === '_blank', JSON.stringify(storyAnchor?.props));
ok(
  '研发需求行含 id / 标题 / 中文状态',
  modalText.includes('研发需求：#2001') &&
    modalText.includes('【示例】APS 提示词改为正常沟通的术语') &&
    modalText.includes('（激活）'),
  modalText.slice(0, 400),
);
ok('来源 Bug 行仍然保留', modalText.includes('来源 Bug：#3001'), modalText.slice(0, 400));
ok(
  '散字段 meta 逐条渲染（避免「详情里有、弹窗里没有」）',
  modalText.includes('所属执行：示例执行') &&
    modalText.includes('类型：开发') &&
    modalText.includes('严重程度：3 轻微') &&
    modalText.includes('预计工时：1'),
  modalText.slice(0, 400),
);
ok(
  '没有 meta 时不渲染多余行（兼容旧宿主）',
  (() => {
    const base = detailSetter?.value ?? {};
    const bare = renderPass([
      true,
      undefined,
      loggedInConfig,
      undefined,
      undefined,
      undefined,
      undefined,
      'bug',
      loggedInData,
      { ...base, data: { ...(base.data ?? {}), story: undefined, meta: undefined } },
    ]);
    return textOf(bare).includes('列表页崩溃') && !textOf(bare).includes('所属执行：');
  })(),
  'ok',
);

// 关闭方式一：关闭按钮
hookState.setters = [];
const closeButton = (() => {
  let hit;
  walk(tree, (node) => {
    if (hit !== undefined || typeof node !== 'object' || node === null) return;
    if (node.type === 'button' && node.props?.className === 'dzw-modal-close') hit = node;
  });
  return hit;
})();
try {
  closeButton.props.onClick();
  caught = undefined;
} catch (error) {
  caught = error;
}
ok('点「关闭」不抛异常', caught === undefined, caught?.stack ?? caught);
ok('点「关闭」把 detail 置空', hookState.setters.some((entry) => entry.index === 9 && entry.value === null), JSON.stringify(hookState.setters));

// 关闭方式二：Esc（弹窗打开时 document 上应挂着 keydown）
ok('弹窗打开时注册了 keydown 监听', (documentListeners.get('keydown') ?? []).length === 1, (documentListeners.get('keydown') ?? []).length);
hookState.setters = [];
try {
  fireDocumentKey('Escape');
  caught = undefined;
} catch (error) {
  caught = error;
}
ok('Esc 不抛异常', caught === undefined, caught?.stack ?? caught);
ok('Esc 把 detail 置空', hookState.setters.some((entry) => entry.index === 9 && entry.value === null), JSON.stringify(hookState.setters));
hookState.setters = [];

console.log('\n== 7. 传输契约：同源 fetch POST ==');
const rpcCalls = calls.filter((entry) => entry.url !== undefined);
ok('全部走 /zentao-workbench/<endpoint>', rpcCalls.length > 0 && rpcCalls.every((entry) => entry.url === `/zentao-workbench/${entry.endpoint}`), JSON.stringify(rpcCalls.map((entry) => entry.url)));
ok('全部是 POST', rpcCalls.every((entry) => entry.method === 'POST'), JSON.stringify(rpcCalls.map((entry) => entry.method)));
ok('全部声明 application/json', rpcCalls.every((entry) => entry.headers?.['content-type'] === 'application/json'));
ok('全部带 credentials: same-origin', rpcCalls.every((entry) => entry.credentials === 'same-origin'));
ok('fetchDetail 载荷带 kind/id', (() => {
  const entry = rpcCalls.find((item) => item.endpoint === 'fetchDetail');
  return ['task', 'bug', 'story'].includes(entry?.payload?.kind) && typeof entry.payload.id === 'string' && entry.payload.id !== '';
})(), JSON.stringify(rpcCalls.find((item) => item.endpoint === 'fetchDetail')?.payload));
ok('没有调用 ctx.connection（已废弃的 RPC 通道）', ctx.connection === undefined);

console.log('\n== 8. 降级：uiWorkspace 不可用时仍能建会话 ==');
uiAvailable = false;
try {
  tree = renderPass([true, undefined, loggedInConfig, undefined, undefined, undefined, undefined, 'task', loggedInData, null]);
  await flush();
  caught = undefined;
} catch (error) {
  caught = error;
}
ok('uiWorkspace 缺失时渲染不抛异常', caught === undefined, caught?.stack ?? caught);
const fallbackHandle = findByText(tree, '处理');
try {
  fallbackHandle.props.onClick();
  await flush();
  caught = undefined;
} catch (error) {
  caught = error;
}
ok('uiWorkspace 缺失时点「处理」不抛异常', caught === undefined, caught?.stack ?? caught);
ok('降级走 sessions.create({ workspaceId: ws-1 })', sessionApi.some((entry) => entry.op === 'create' && entry.opts?.workspaceId === 'ws-1'), JSON.stringify(sessionApi));
ok('降级会话也 retain 了', sessionApi.some((entry) => entry.op === 'retain' && entry.sessionId === 'session-created'), JSON.stringify(sessionApi));
ok('降级时**不**释放 retain（避免会话被回收打断任务）', !sessionApi.some((entry) => entry.op === 'release' && entry.sessionId === 'session-created'), JSON.stringify(sessionApi));
ok('降级后仍发出了提示词', sentPrompts.length === 2, sentPrompts.length);

console.log('\n== 9. 图片放大预览（点缩略图 / 点「放大」/ 三种关法） ==');
const detailValue = detailSetter?.value ?? null;
tree = renderPass([true, undefined, loggedInConfig, undefined, undefined, undefined, undefined, 'bug', loggedInData, detailValue]);
await flush();

const thumbButton = findByClass(tree, 'dzw-thumb-link');
ok('缩略图是可点击按钮（点击放大，不再直接跳新窗口）', thumbButton !== undefined && thumbButton.type === 'button', JSON.stringify(thumbButton?.type));
const zoomButton = findByClass(tree, 'dzw-zoom');
ok('附件旁有「放大」按钮', zoomButton !== undefined && textOf(zoomButton).includes('放大'), JSON.stringify(zoomButton?.props?.className));

hookState.setters = [];
try {
  thumbButton.props.onClick();
  caught = undefined;
} catch (error) {
  caught = error;
}
ok('点缩略图不抛异常', caught === undefined, caught?.stack ?? caught);
const previewSetter = hookState.setters.find((entry) => entry.index === 10);
ok('点缩略图写入第 11 个 state（preview，下标 10）', previewSetter !== undefined, JSON.stringify(hookState.setters.map((entry) => entry.index)));
ok(
  'preview = {name,url}，url 走宿主代理',
  previewSetter?.value?.name === 'file-read-16547.png' && String(previewSetter?.value?.url ?? '').includes('/zentao-workbench/attachment?url='),
  JSON.stringify(previewSetter?.value),
);

// 用刚拿到的值再渲染一趟，验证放大层内容。
const previewValue = previewSetter?.value ?? null;
tree = renderPass([true, undefined, loggedInConfig, undefined, undefined, undefined, undefined, 'bug', loggedInData, detailValue, previewValue]);
await flush();
const previewLayer = findByClass(tree, 'dzw-preview');
const previewCardNode = findByClass(tree, 'dzw-preview-card');
const bigImage = findByClass(tree, 'dzw-preview-img');
ok('放大层已渲染（fixed 全屏点击层）', previewLayer !== undefined && bigImage !== undefined && bigImage.type === 'img', JSON.stringify(bigImage?.props));
ok('图片装在悬浮卡片里（外层透明点击层之下有 dzw-preview-card）', previewCardNode !== undefined, JSON.stringify(previewCardNode?.props?.className));
ok('大图 src 就是宿主代理地址', String(bigImage?.props?.src ?? '') === String(previewValue?.url ?? 'x'), String(bigImage?.props?.src));
ok('放大层显示文件名与「新窗口打开」', textOf(tree).includes('file-read-16547.png') && textOf(tree).includes('新窗口打开'), textOf(tree).slice(0, 200));
ok('底部有「点空白处或按 Esc 也能关闭」的提示', textOf(previewCardNode).includes('点空白处或按 Esc 也能关闭'), textOf(previewCardNode).slice(0, 200));
const closeButtons = walkCollect(tree, 'dzw-preview-close');
ok('卡片刻意给了两个「关闭」按钮（右上角 + 底部，不让人以为只有右上角能关）', closeButtons.length === 2, closeButtons.length);
ok(
  '右上角那颗是固定在视口角落的实心按钮（带 ✕ 图标，不跟着图片大小跑）',
  closeButtons[0]?.props?.className.includes('dzw-preview-close-float') &&
    textOf(closeButtons[0]).includes('✕') &&
    textOf(closeButtons[0]).includes('关闭'),
  `${closeButtons[0]?.props?.className} / ${textOf(closeButtons[0]).trim()}`,
);
ok(
  '底部那颗是主题色实心按钮（不再是灰色文字）',
  closeButtons[1]?.props?.className.includes('dzw-preview-close-solid') && textOf(closeButtons[1]).includes('✕'),
  `${closeButtons[1]?.props?.className} / ${textOf(closeButtons[1]).trim()}`,
);
ok('放大层打开时详情卡片仍在（预览盖在上面，不关详情）', findByClass(tree, 'dzw-modal') !== undefined);

// 关法一：点空白处（外层透明层）
hookState.setters = [];
try {
  previewLayer.props.onClick();
  caught = undefined;
} catch (error) {
  caught = error;
}
ok('点放大层空白处不抛异常', caught === undefined, caught?.stack ?? caught);
ok('点空白处把 preview 置空', hookState.setters.some((entry) => entry.index === 10 && entry.value === null), JSON.stringify(hookState.setters));

// 关法二：底部那个「关闭」按钮（第二个）
hookState.setters = [];
const bottomClose = closeButtons[1];
try {
  bottomClose.props.onClick();
  caught = undefined;
} catch (error) {
  caught = error;
}
ok('点底部「关闭」不抛异常', caught === undefined, caught?.stack ?? caught);
ok('点底部「关闭」把 preview 置空', hookState.setters.some((entry) => entry.index === 10 && entry.value === null), JSON.stringify(hookState.setters));

// 关法三：右上角「关闭」（第一个）
hookState.setters = [];
const previewClose = closeButtons[0];
try {
  previewClose.props.onClick();
  caught = undefined;
} catch (error) {
  caught = error;
}
ok('点右上角「关闭」不抛异常', caught === undefined, caught?.stack ?? caught);
ok('点右上角「关闭」把 preview 置空', hookState.setters.some((entry) => entry.index === 10 && entry.value === null), JSON.stringify(hookState.setters));

// 点卡片本身（含工具条/图片）必须吞掉冒泡，否则点「新窗口打开」会顺手把预览关掉；冒烟里 onClick 不传 event，要能防御。
hookState.setters = [];
try {
  previewCardNode.props.onClick();
  caught = undefined;
} catch (error) {
  caught = error;
}
ok('点预览卡片（无 event）不抛异常', caught === undefined, caught?.stack ?? caught);
ok('点预览卡片不会顺手关掉预览', !hookState.setters.some((entry) => entry.index === 10 && entry.value === null), JSON.stringify(hookState.setters));

// 关法三：Esc —— 预览优先关，详情保持打开。
ok('预览/详情打开时都挂着 keydown 监听（只挂一个）', (documentListeners.get('keydown') ?? []).length === 1, (documentListeners.get('keydown') ?? []).length);
hookState.setters = [];
try {
  fireDocumentKey('Escape');
  caught = undefined;
} catch (error) {
  caught = error;
}
ok('Esc 不抛异常', caught === undefined, caught?.stack ?? caught);
ok('Esc 先关预览（preview 置空）', hookState.setters.some((entry) => entry.index === 10 && entry.value === null), JSON.stringify(hookState.setters));
ok('Esc 不会连着把详情也关掉', !hookState.setters.some((entry) => entry.index === 9 && entry.value === null), JSON.stringify(hookState.setters));

// 面板收起时也能看大图（预览层不在面板内部）。
tree = renderPass([false, undefined, loggedInConfig, undefined, undefined, undefined, undefined, 'bug', loggedInData, null, previewValue]);
await flush();
ok('面板收起时放大层仍能显示', findByClass(tree, 'dzw-preview-img') !== undefined && findByClass(tree, 'dzw-panel') === undefined);

// ---- 视频附件（mp4，见任务 #10001）：卡片里直接出播放器，可「放大播放」 ----
tree = renderPass([true, undefined, loggedInConfig, undefined, undefined, undefined, undefined, 'bug', loggedInData, detailValue, null]);
await flush();
const videoNode = findByClass(tree, 'dzw-video');
ok('mp4 附件在卡片里渲染成 <video>（不再只是一行链接）', videoNode !== undefined && videoNode.type === 'video', JSON.stringify(videoNode?.type));
ok(
  '播放器 src 走宿主代理（禅道直链不带 Token 只会返回登录页）',
  String(videoNode?.props?.src ?? '') ===
    '/zentao-workbench/attachment?url=http%3A%2F%2Fzentao.example.com%3A11180%2Fzentao%2Ffile-read-31001.mp4',
  String(videoNode?.props?.src),
);
ok(
  '播放器带 controls 且只预取 metadata（不自动整段下载）',
  videoNode?.props?.controls === true && videoNode?.props?.preload === 'metadata' && videoNode?.props?.playsInline === true,
  JSON.stringify(videoNode?.props),
);
const videoZoom = clickablesOf(tree).filter((node) => textOf(node).trim() === '放大播放');
ok('视频旁有「放大播放」按钮', videoZoom.length === 1, videoZoom.length);

const detailLinks = walkCollect(tree, 'dzw-link');
const mp4Link = detailLinks.find((node) => textOf(node).includes('3731022dfe2104eb2ec746e27b619cc7.mp4'));
const docxLink = detailLinks.find((node) => textOf(node).includes('需求说明.docx'));
ok('视频文件名仍是可点链接（新窗口打开原视频）', mp4Link !== undefined && mp4Link.props?.target === '_blank', JSON.stringify(mp4Link?.props));
ok('word/excel 附件的文件名仍是可点链接（新窗口打开原件）', docxLink !== undefined && docxLink.type === 'a', JSON.stringify(docxLink?.type));
const officeOpenButtons = clickablesOf(tree).filter((node) => textOf(node).trim() === '用默认程序打开');
ok('word/excel 附件旁有「用默认程序打开」按钮', officeOpenButtons.length === 1, officeOpenButtons.length);
const pdfPreviewButtons = clickablesOf(tree).filter((node) => textOf(node).trim() === '预览 PDF');
ok('PDF 附件旁有「预览 PDF」按钮', pdfPreviewButtons.length === 1, pdfPreviewButtons.length);

hookState.setters = [];
try {
  videoZoom[0].props.onClick();
  caught = undefined;
} catch (error) {
  caught = error;
}
ok('点「放大播放」不抛异常', caught === undefined, caught?.stack ?? caught);
const videoPreviewSetter = hookState.setters.find((entry) => entry.index === 10);
ok(
  '点「放大播放」写入 preview 且 kind=video（和图片预览共用第 11 个 state）',
  videoPreviewSetter?.value?.kind === 'video' && String(videoPreviewSetter?.value?.name ?? '').endsWith('.mp4'),
  JSON.stringify(videoPreviewSetter?.value),
);

const videoPreviewValue = videoPreviewSetter?.value ?? null;
tree = renderPass([true, undefined, loggedInConfig, undefined, undefined, undefined, undefined, 'bug', loggedInData, detailValue, videoPreviewValue]);
await flush();
const previewVideo = findByClass(tree, 'dzw-preview-video');
ok('放大播放层出 <video class="dzw-preview-video">', previewVideo !== undefined && previewVideo.type === 'video', JSON.stringify(previewVideo?.type));
ok(
  '放大播放层带 controls、不自动播放（用户要求点击才播放）',
  previewVideo?.props?.controls === true && previewVideo?.props?.autoPlay === undefined && previewVideo?.props?.preload === 'metadata',
  JSON.stringify(previewVideo?.props),
);
ok('放大播放层不再渲染 <img class="dzw-preview-img">', findByClass(tree, 'dzw-preview-img') === undefined);
ok(
  '放大播放层提示「点播放键开始播放」',
  String(textOf(tree)).includes('点播放键开始播放'),
  String(textOf(tree)).slice(0, 120),
);

tree = renderPass([true, undefined, loggedInConfig, undefined, undefined, undefined, undefined, 'bug', loggedInData, detailValue, previewValue]);
await flush();
ok(
  '图片预览仍走 <img>（两种预览共用同一个浮层，按 kind 分叉）',
  findByClass(tree, 'dzw-preview-img') !== undefined && findByClass(tree, 'dzw-preview-video') === undefined,
);

// ---- PDF 附件：在工作台内用 iframe 预览（宿主代理已回 application/pdf + inline） ----
tree = renderPass([true, undefined, loggedInConfig, undefined, undefined, undefined, undefined, 'bug', loggedInData, detailValue, null]);
await flush();
hookState.setters = [];
try {
  pdfPreviewButtons[0].props.onClick();
  caught = undefined;
} catch (error) {
  caught = error;
}
ok('点「预览 PDF」不抛异常', caught === undefined, caught?.stack ?? caught);
const pdfSetter = hookState.setters.find((entry) => entry.index === 10);
ok(
  '点「预览 PDF」写入 preview 且 kind=pdf（与图片/视频共用第 11 个 state）',
  pdfSetter?.value?.kind === 'pdf' && String(pdfSetter?.value?.name ?? '').endsWith('.pdf'),
  JSON.stringify(pdfSetter?.value),
);

tree = renderPass([true, undefined, loggedInConfig, undefined, undefined, undefined, undefined, 'bug', loggedInData, detailValue, pdfSetter?.value ?? null]);
await flush();
const pdfFrame = findByClass(tree, 'dzw-preview-pdf');
ok('PDF 预览层出 <iframe class="dzw-preview-pdf">', pdfFrame !== undefined && pdfFrame.type === 'iframe', JSON.stringify(pdfFrame?.type));
ok(
  'iframe 的 src 走宿主代理（禅道直链不带 Token 只会返回登录页）',
  String(pdfFrame?.props?.src ?? '') ===
    '/zentao-workbench/attachment?url=http%3A%2F%2Fzentao.example.com%3A11180%2Fzentao%2Ffile-read-32002.pdf',
  String(pdfFrame?.props?.src),
);
ok(
  'PDF 预览层不再渲染 <img>/<video>（三种预览互斥）',
  findByClass(tree, 'dzw-preview-img') === undefined && findByClass(tree, 'dzw-preview-video') === undefined,
);
ok(
  'PDF 预览层有「新窗口打开」+ 关闭按钮 + Esc 提示',
  String(textOf(tree)).includes('新窗口打开') && String(textOf(tree)).includes('关闭') && String(textOf(tree)).includes('Esc'),
);

// ---- word / excel / ppt：交给电脑上的默认程序打开（宿主下载到临时目录再调系统打开） ----
tree = renderPass([true, undefined, loggedInConfig, undefined, undefined, undefined, undefined, 'bug', loggedInData, detailValue, null]);
await flush();
openAttachmentFails = false;
const officeCallsBefore = calls.filter((entry) => entry.endpoint === 'openAttachment').length;
hookState.setters = [];
try {
  officeOpenButtons[0].props.onClick();
  await flush();
  caught = undefined;
} catch (error) {
  caught = error;
}
ok('点「用默认程序打开」不抛异常', caught === undefined, caught?.stack ?? caught);
const officeCalls = calls.filter((entry) => entry.endpoint === 'openAttachment');
ok('点「用默认程序打开」调用宿主 openAttachment', officeCalls.length === officeCallsBefore + 1, JSON.stringify(officeCalls.map((entry) => entry.payload)));
ok(
  'openAttachment 收到原件地址 + 文件名',
  officeCalls[officeCalls.length - 1]?.payload?.url === 'http://zentao.example.com:11180/zentao/file-read-32001.docx' &&
    officeCalls[officeCalls.length - 1]?.payload?.name === '需求说明.docx',
  JSON.stringify(officeCalls[officeCalls.length - 1]?.payload),
);
ok(
  '成功后 toast 提示已交给系统默认程序',
  String(hookState.setters.find((entry) => entry.index === 6)?.value ?? '').includes('已交给系统默认程序打开'),
  JSON.stringify(hookState.setters.find((entry) => entry.index === 6)?.value),
);

openAttachmentFails = true;
hookState.setters = [];
try {
  officeOpenButtons[0].props.onClick();
  await flush();
  caught = undefined;
} catch (error) {
  caught = error;
}
ok(
  '失败时 toast 提示打开附件失败（不静默）',
  caught === undefined && String(hookState.setters.find((entry) => entry.index === 6)?.value ?? '').includes('打开附件失败'),
  JSON.stringify(hookState.setters.find((entry) => entry.index === 6)?.value),
);
openAttachmentFails = false;

console.log('\n== 10. 点「处理」后把任务在禅道里置为「开始」 ==');
uiAvailable = true;
startTaskReply = { changed: true, previousStatus: 'wait', status: 'doing', statusLabel: '进行中', note: '' };
tree = renderPass([true, undefined, loggedInConfig, undefined, undefined, undefined, undefined, 'task', loggedInData, null]);
await flush();

const startCallsBefore = calls.filter((entry) => entry.endpoint === 'startTask').length;
hookState.setters = [];
const taskHandle = findByText(tree, '处理'); // 列表按 ID 倒序，第一条是 wait 的 #42
try {
  taskHandle.props.onClick();
  await flush();
  caught = undefined;
} catch (error) {
  caught = error;
}
ok('任务上点「处理」不抛异常', caught === undefined, caught?.stack ?? caught);
const startCalls = calls.filter((entry) => entry.endpoint === 'startTask');
ok('点「处理」会额外调用宿主 startTask', startCalls.length === startCallsBefore + 1, JSON.stringify(startCalls.map((entry) => entry.payload)));
ok('startTask 带的是这条任务的 id（#42）', startCalls[startCalls.length - 1]?.payload?.id === '42', JSON.stringify(startCalls[startCalls.length - 1]?.payload));
ok(
  '开始成功后有明确提示（含中文状态）',
  hookState.setters.some((entry) => entry.index === 6 && String(entry.value).includes('已置为') && String(entry.value).includes('进行中')),
  JSON.stringify(hookState.setters.filter((entry) => entry.index === 6).map((entry) => entry.value)),
);
ok('开始成功后会刷新列表（refresh 被再次调用）', calls.filter((entry) => entry.endpoint === 'refresh').length >= 2, calls.filter((entry) => entry.endpoint === 'refresh').length);
ok('等待任务上「处理」按钮提示会同时置为开始', String(taskHandle.props?.title ?? '').includes('置为「开始」'), String(taskHandle.props?.title));

// 禅道没改状态时不许谎报成功。
startTaskReply = { changed: false, previousStatus: 'done', status: 'done', statusLabel: '已完成', note: '任务当前是「已完成」，只有未开始的任务能置为开始' };
tree = renderPass([true, undefined, loggedInConfig, undefined, undefined, undefined, undefined, 'task', loggedInData, null]);
await flush();
hookState.setters = [];
const taskHandle2 = findByText(tree, '处理');
try {
  taskHandle2.props.onClick();
  await flush();
  caught = undefined;
} catch (error) {
  caught = error;
}
ok('禅道没改状态时不抛异常', caught === undefined, caught?.stack ?? caught);
ok(
  '禅道没改状态时提示「状态未变」而不是成功',
  hookState.setters.some((entry) => entry.index === 6 && String(entry.value).includes('状态未变')) &&
    !hookState.setters.some((entry) => entry.index === 6 && String(entry.value).includes('已置为')),
  JSON.stringify(hookState.setters.filter((entry) => entry.index === 6).map((entry) => entry.value)),
);

// Bug / 需求不写状态。
startTaskReply = { changed: true, previousStatus: 'active', status: 'active', statusLabel: '激活', note: '' };
tree = renderPass([true, undefined, loggedInConfig, undefined, undefined, undefined, undefined, 'bug', loggedInData, null]);
await flush();
const bugStartBefore = calls.filter((entry) => entry.endpoint === 'startTask').length;
const bugHandle = findByText(tree, '处理');
try {
  bugHandle.props.onClick();
  await flush();
  caught = undefined;
} catch (error) {
  caught = error;
}
ok('Bug 上点「处理」不抛异常', caught === undefined, caught?.stack ?? caught);
ok('Bug / 需求不会被置为开始（只对任务动手）', calls.filter((entry) => entry.endpoint === 'startTask').length === bugStartBefore, JSON.stringify(calls.filter((entry) => entry.endpoint === 'startTask').map((entry) => entry.payload)));

console.log('\n== 11. 完成（填耗时）/ 指派（PUT tasks/{id}） ==');
// useState 顺序：open, target, config, form, busy, error, toast, tab, data, detail, preview, finishFor, assignFor, users, pick, analyses
const P = (over) => [
  over.open ?? true,
  undefined,
  loggedInConfig,
  undefined,
  undefined,
  undefined,
  undefined,
  over.tab ?? 'task',
  loggedInData,
  over.detail === undefined ? null : over.detail,
  over.preview === undefined ? null : over.preview,
  over.finishFor === undefined ? null : over.finishFor,
  over.assignFor === undefined ? null : over.assignFor,
  over.users === undefined ? null : over.users,
  over.pick ?? '',
  over.analyses ?? undefined,
];
uiAvailable = true;
finishTaskReply = { changed: true, previousStatus: 'wait', status: 'done', statusLabel: '已完成', consumed: 5.5, finishedDate: '2026-10-08', note: '' };
assignTaskReply = {
  changed: true,
  previousAccount: 'zhangsan',
  previousName: '张三',
  account: 'lisi',
  realname: '李四',
  status: 'doing',
  statusLabel: '进行中',
  statusChanged: true,
  note: '',
};

const inputsOf = (tree) => {
  const found = [];
  walk(tree, (node) => {
    if (typeof node === 'object' && node !== null && (node.type === 'input' || node.type === 'textarea')) found.push(node);
  });
  return found;
};
const byExactText = (tree, needle) => clickablesOf(tree).filter((node) => textOf(node).trim() === needle);

tree = renderPass(P({}));
await flush();

const doneButtons = byExactText(tree, '完成');
ok('任务条目有「完成」按钮（3 条任务 → 3 个）', doneButtons.length === 3, doneButtons.length);
ok('已完成任务（#7）的「完成」按钮被禁用', doneButtons[2]?.props?.disabled === true, JSON.stringify(doneButtons.map((button) => button.props?.disabled)));
ok(
  '「完成」按钮的 title 说明会登记耗时',
  String(doneButtons[0]?.props?.title ?? '').includes('耗时'),
  JSON.stringify(doneButtons[0]?.props?.title),
);
const assignButtons = byExactText(tree, '指派');
ok('任务条目有「指派」按钮（3 条任务 → 3 个）', assignButtons.length === 3, assignButtons.length);
ok(
  '「指派」按钮的 title 提示会把未开始的任务激活',
  String(assignButtons[0]?.props?.title ?? '').includes('进行中'),
  JSON.stringify(assignButtons[0]?.props?.title),
);
ok('列表 meta 用真名（@张三）而不是裸账号', textOf(tree).includes('@张三'), textOf(tree).slice(0, 200));

// ---- 打开「完成」卡片 ------------------------------------------------------
hookState.setters = [];
try {
  doneButtons[0].props.onClick();
  caught = undefined;
} catch (error) {
  caught = error;
}
ok('点「完成」不抛异常', caught === undefined, caught?.stack ?? caught);
const finishSetter = hookState.setters.find((entry) => entry.index === 11);
ok(
  '点「完成」写入第 12 个 state（finishFor，下标 11）',
  finishSetter !== undefined && finishSetter.value?.id === '42' && finishSetter.value?.hours === '' && finishSetter.value?.comment === '',
  JSON.stringify(finishSetter?.value),
);

const finishValue = finishSetter.value;
tree = renderPass(P({ finishFor: finishValue }));
await flush();
ok(
  '完成卡片渲染标题与耗时输入框',
  textOf(tree).includes('完成任务 #42') && textOf(tree).includes('本次耗时（小时）') && textOf(tree).includes('备注'),
  textOf(tree).slice(0, 260),
);
const finishInputs = inputsOf(tree);
ok('完成卡片有两个输入（耗时 input + 备注 textarea）', finishInputs.length === 2, JSON.stringify(finishInputs.map((node) => node.type)));

hookState.setters = [];
finishInputs[0].props.onChange({ target: { value: '2.5' } });
const hoursSetter = hookState.setters.find((entry) => entry.index === 11);
ok(
  '修改耗时写回 finishFor 且保留 id / title',
  hoursSetter?.value?.hours === '2.5' && hoursSetter.value.id === '42' && hoursSetter.value.title === '补充单元测试',
  JSON.stringify(hoursSetter?.value),
);
hookState.setters = [];
finishInputs[1].props.onChange({ target: { value: '自测通过' } });
ok(
  '修改备注写回 finishFor',
  hookState.setters.find((entry) => entry.index === 11)?.value?.comment === '自测通过',
  JSON.stringify(hookState.setters.find((entry) => entry.index === 11)?.value),
);

// ---- 提交完成 --------------------------------------------------------------
tree = renderPass(P({ finishFor: { ...finishValue, hours: '2.5', comment: '自测通过' } }));
await flush();
const finishBefore = calls.filter((entry) => entry.endpoint === 'finishTask').length;
const refreshBeforeFinish = calls.filter((entry) => entry.endpoint === 'refresh').length;
const confirmFinish = findByText(tree, '确认完成');
hookState.setters = [];
try {
  confirmFinish.props.onClick();
  await flush();
  caught = undefined;
} catch (error) {
  caught = error;
}
ok('点「确认完成」不抛异常', caught === undefined, caught?.stack ?? caught);
const finishCalls = calls.filter((entry) => entry.endpoint === 'finishTask');
ok('点「确认完成」调用 finishTask', finishCalls.length === finishBefore + 1, JSON.stringify(finishCalls.map((entry) => entry.payload)));
ok(
  'finishTask 参数 = {id, hours:2.5, comment}',
  finishCalls.at(-1)?.payload?.id === '42' && finishCalls.at(-1)?.payload?.hours === 2.5 && finishCalls.at(-1)?.payload?.comment === '自测通过',
  JSON.stringify(finishCalls.at(-1)?.payload),
);
ok(
  '完成成功 toast 带状态中文与累计耗时',
  String(hookState.setters.find((entry) => entry.index === 6)?.value ?? '').includes('已完成') &&
    String(hookState.setters.find((entry) => entry.index === 6)?.value ?? '').includes('5.5'),
  JSON.stringify(hookState.setters.find((entry) => entry.index === 6)?.value),
);
ok('完成后关闭卡片（finishFor 置空）', hookState.setters.some((entry) => entry.index === 11 && entry.value === null), JSON.stringify(hookState.setters.map((entry) => entry.index)));
ok(
  '完成后刷新列表（refresh 再次被调用）',
  calls.filter((entry) => entry.endpoint === 'refresh').length === refreshBeforeFinish + 1,
  calls.filter((entry) => entry.endpoint === 'refresh').length,
);

// 耗时非法：本地拦住，不发请求。
tree = renderPass(P({ finishFor: { ...finishValue, hours: 'abc' } }));
await flush();
const finishBadBefore = calls.filter((entry) => entry.endpoint === 'finishTask').length;
hookState.setters = [];
findByText(tree, '确认完成').props.onClick();
await flush();
ok('耗时非法时提示且不发请求', calls.filter((entry) => entry.endpoint === 'finishTask').length === finishBadBefore && String(hookState.setters.find((entry) => entry.index === 6)?.value ?? '').includes('必须是不小于 0 的数字'), JSON.stringify(hookState.setters.find((entry) => entry.index === 6)?.value));
ok('耗时非法时卡片不关（还能改）', !hookState.setters.some((entry) => entry.index === 11 && entry.value === null), JSON.stringify(hookState.setters.map((entry) => entry.index)));

// 禅道收下但状态没变 → 不谎报成功。
finishTaskReply = { changed: false, previousStatus: 'wait', status: 'wait', statusLabel: '未开始', consumed: 3, note: '禅道没有改变任务状态（可能是权限、状态不允许或耗时未填对）' };
tree = renderPass(P({ finishFor: { ...finishValue, hours: '1' } }));
await flush();
hookState.setters = [];
findByText(tree, '确认完成').props.onClick();
await flush();
const finishToast = String(hookState.setters.find((entry) => entry.index === 6)?.value ?? '');
ok('完成：状态没变时提示「状态未变」，不出现「已完成」', finishToast.includes('状态未变') && !finishToast.includes('已完成'), finishToast);
finishTaskReply = { changed: true, previousStatus: 'wait', status: 'done', statusLabel: '已完成', consumed: 5.5, finishedDate: '2026-10-08', note: '' };

// 「取消」关闭卡片。
tree = renderPass(P({ finishFor: finishValue }));
await flush();
hookState.setters = [];
findByText(tree, '取消').props.onClick();
ok('点「取消」关闭完成卡片', hookState.setters.some((entry) => entry.index === 11 && entry.value === null), JSON.stringify(hookState.setters));

// 面板收起时卡片仍能显示（卡片挂在 .dzw-root 上，不在面板内部）。
tree = renderPass(P({ open: false, finishFor: finishValue }));
await flush();
ok('面板收起时「完成」卡片仍能显示', textOf(tree).includes('完成任务 #42') && findByClass(tree, 'dzw-panel') === undefined);

// ---- 打开「指派」卡片 ------------------------------------------------------
tree = renderPass(P({}));
await flush();
const assignButtons2 = byExactText(tree, '指派');
const usersBefore = calls.filter((entry) => entry.endpoint === 'listUsers').length;
hookState.setters = [];
try {
  assignButtons2[0].props.onClick();
  await flush();
  caught = undefined;
} catch (error) {
  caught = error;
}
ok('点「指派」不抛异常', caught === undefined, caught?.stack ?? caught);
const assignSetter = hookState.setters.find((entry) => entry.index === 12);
ok(
  '点「指派」写入第 13 个 state（assignFor，下标 12），current 是真名',
  assignSetter?.value?.id === '42' && assignSetter.value?.current === '张三' && assignSetter.value?.query === '',
  JSON.stringify(assignSetter?.value),
);
ok('第一次打开指派卡片会拉成员列表（listUsers）', calls.filter((entry) => entry.endpoint === 'listUsers').length === usersBefore + 1, JSON.stringify(calls.filter((entry) => entry.endpoint === 'listUsers').map((entry) => entry.payload)));
const usersSetter = hookState.setters.find((entry) => entry.index === 13);
const usersValue = Array.isArray(usersSetter?.value) ? usersSetter.value : usersReply.users;
ok('成员列表写入第 14 个 state（users，下标 13）', Array.isArray(usersSetter?.value) && usersSetter.value.length === 2, JSON.stringify(usersSetter?.value));

const assignValue = assignSetter.value;
tree = renderPass(P({ assignFor: assignValue, users: usersValue }));
await flush();
const userRows = (t) => clickablesOf(t).filter((node) => typeof node.props?.className === 'string' && node.props.className.split(/\s+/).includes('dzw-user'));
ok(
  '成员列表渲染成可点行（真名 + 账号）',
  userRows(tree).length === 2 && textOf(userRows(tree)[0]).includes('李四') && textOf(userRows(tree)[0]).includes('lisi'),
  JSON.stringify(userRows(tree).map((row) => textOf(row))),
);
ok('指派卡片显示当前指派人并提示状态副作用', textOf(tree).includes('当前指派给：张三') && textOf(tree).includes('激活为「进行中」'), textOf(tree).slice(0, 300));

// 搜索过滤（真名 / 账号都能命中）。
const searchInput = inputsOf(tree)[0];
hookState.setters = [];
searchInput.props.onChange({ target: { value: '李' } });
const querySetter = hookState.setters.find((entry) => entry.index === 12);
ok('搜索写回 assignFor.query 且保留 id', querySetter?.value?.query === '李' && querySetter.value.id === '42', JSON.stringify(querySetter?.value));
tree = renderPass(P({ assignFor: { ...assignValue, query: '李' }, users: usersValue }));
await flush();
ok('按真名过滤只剩一条（李四）', userRows(tree).length === 1 && textOf(userRows(tree)[0]).includes('李四'), JSON.stringify(userRows(tree).map((row) => textOf(row))));
tree = renderPass(P({ assignFor: { ...assignValue, query: 'zhangsan' }, users: usersValue }));
await flush();
ok('按账号也能过滤（zhangsan → 张三）', userRows(tree).length === 1 && textOf(userRows(tree)[0]).includes('张三'), JSON.stringify(userRows(tree).map((row) => textOf(row))));
tree = renderPass(P({ assignFor: { ...assignValue, query: '不存在的人' }, users: usersValue }));
await flush();
ok('没有匹配时给出空态而不是空白', textOf(tree).includes('没有匹配的成员'), textOf(tree).slice(0, 200));

// ---- 点一行完成指派 --------------------------------------------------------
tree = renderPass(P({ assignFor: assignValue, users: usersValue }));
await flush();
const assignBefore = calls.filter((entry) => entry.endpoint === 'assignTask').length;
const refreshBeforeAssign = calls.filter((entry) => entry.endpoint === 'refresh').length;
hookState.setters = [];
try {
  userRows(tree)[0].props.onClick();
  await flush();
  caught = undefined;
} catch (error) {
  caught = error;
}
ok('点成员行不抛异常', caught === undefined, caught?.stack ?? caught);
const assignCalls = calls.filter((entry) => entry.endpoint === 'assignTask');
ok('点成员行调用 assignTask', assignCalls.length === assignBefore + 1, JSON.stringify(assignCalls.map((entry) => entry.payload)));
ok(
  'assignTask 参数 = {id:42, account:lisi}',
  assignCalls.at(-1)?.payload?.id === '42' && assignCalls.at(-1)?.payload?.account === 'lisi',
  JSON.stringify(assignCalls.at(-1)?.payload),
);
const assignToast = String(hookState.setters.find((entry) => entry.index === 6)?.value ?? '');
ok('指派成功 toast 含「已指派给」「李四」与状态变化提示', assignToast.includes('已指派给') && assignToast.includes('李四') && assignToast.includes('进行中'), assignToast);
ok('指派成功后关闭卡片（assignFor 置空）', hookState.setters.some((entry) => entry.index === 12 && entry.value === null), JSON.stringify(hookState.setters.map((entry) => entry.index)));
ok(
  '指派成功后刷新列表',
  calls.filter((entry) => entry.endpoint === 'refresh').length === refreshBeforeAssign + 1,
  calls.filter((entry) => entry.endpoint === 'refresh').length,
);

// 禅道没改指派人 → 不谎报成功。
assignTaskReply = { changed: false, previousAccount: 'zhangsan', previousName: '张三', account: 'zhangsan', realname: '张三', status: 'wait', statusLabel: '未开始', statusChanged: false, note: '禅道没有改变指派人（可能是权限不足或账号不存在）' };
tree = renderPass(P({ assignFor: assignValue, users: usersValue }));
await flush();
hookState.setters = [];
userRows(tree)[0].props.onClick();
await flush();
const assignFailToast = String(hookState.setters.find((entry) => entry.index === 6)?.value ?? '');
ok('指派：禅道没改人时提示「未变」，不出现「已指派给」', assignFailToast.includes('未变') && !assignFailToast.includes('已指派给'), assignFailToast);

// 「取消」关闭指派卡片。
tree = renderPass(P({ assignFor: assignValue, users: usersValue }));
await flush();
hookState.setters = [];
findByText(tree, '取消').props.onClick();
ok('点「取消」关闭指派卡片', hookState.setters.some((entry) => entry.index === 12 && entry.value === null), JSON.stringify(hookState.setters));

// ---- Esc 的关闭顺序：预览 > 完成 > 指派 > 详情 ------------------------------
const detailValueForEsc = { key: 'bug-101', loading: false, error: '', data: { id: '101', title: '列表页崩溃', status: 'active', statusLabel: '激活', sections: [], attachments: [], actions: [] } };
tree = renderPass(P({ detail: detailValueForEsc, finishFor: finishValue, assignFor: assignValue, users: usersValue }));
await flush();
hookState.setters = [];
fireDocumentKey('Escape');
ok(
  'Esc 先关「完成」卡片（完成/指派/详情都开着时）',
  hookState.setters.some((entry) => entry.index === 11 && entry.value === null) &&
    !hookState.setters.some((entry) => entry.index === 12 && entry.value === null) &&
    !hookState.setters.some((entry) => entry.index === 9 && entry.value === null),
  JSON.stringify(hookState.setters.map((entry) => entry.index)),
);
tree = renderPass(P({ detail: detailValueForEsc, assignFor: assignValue, users: usersValue }));
await flush();
hookState.setters = [];
fireDocumentKey('Escape');
ok(
  '只剩「指派」与详情时 Esc 关指派、详情保留',
  hookState.setters.some((entry) => entry.index === 12 && entry.value === null) && !hookState.setters.some((entry) => entry.index === 9 && entry.value === null),
  JSON.stringify(hookState.setters.map((entry) => entry.index)),
);
tree = renderPass(P({ finishFor: finishValue }));
await flush();
hookState.setters = [];
fireDocumentKey('Escape');
ok('只有「完成」卡片时 Esc 也能关掉它', hookState.setters.some((entry) => entry.index === 11 && entry.value === null), JSON.stringify(hookState.setters));

// ---- CSS -------------------------------------------------------------------
ok(
  'CSS：.dzw-actions 允许换行（5 个按钮不会挤爆 400px 面板）',
  /\.dzw-actions\s*\{[^}]*flex-wrap:\s*wrap/.test(cssText),
  (cssText.match(/\.dzw-actions\s*\{[^}]*\}/) ?? [''])[0],
);
ok(
  'CSS：完成 / 指派卡片的表单与成员列表样式都已定义',
  ['.dzw-field', '.dzw-hint', '.dzw-textarea', '.dzw-user-list', '.dzw-user', '.dzw-user-name', '.dzw-user-account'].every((cls) => cssText.includes(cls)),
  ['.dzw-field', '.dzw-hint', '.dzw-textarea', '.dzw-user-list', '.dzw-user'].filter((cls) => !cssText.includes(cls)),
);
ok('CSS：成员行有 hover 反馈', /\.dzw-user:hover\s*\{[^}]*background/.test(cssText), (cssText.match(/\.dzw-user:hover\s*\{[^}]*\}/) ?? [''])[0]);

console.log('\n== 12. 发送目标：工作区有多个时可以切换（用户 m03741） ==');
uiAvailable = true;
tree = renderPass(P({}));
await flush();
const targetRow = findByClass(tree, 'dzw-target');
const picker = findByClass(tree, 'dzw-select');
ok('发送目标行存在且是可并排的容器（文字 + 下拉）', targetRow !== undefined, JSON.stringify(targetRow?.props?.className));
ok('有多个工作区时渲染下拉选择器', picker !== undefined && picker.type === 'select', `${picker?.type} / ${JSON.stringify(picker?.props?.className)}`);
ok('下拉默认停在「跟随当前工作区」', String(picker?.props?.value ?? 'x') === '', JSON.stringify(picker?.props?.value));
const optionNodes = Array.isArray(picker?.children) ? picker.children : [picker?.children];
const optionTexts = optionNodes.filter(Boolean).map((node) => textOf(node).trim());
ok(
  '下拉列出「跟随当前工作区 + 两个工作区」共三项',
  optionTexts.length === 3 && optionTexts[0].includes('跟随当前工作区') && optionTexts.some((label) => label.includes('另一个项目（E:\\Eworkspace\\other）')),
  JSON.stringify(optionTexts),
);
ok(
  '没选时文案显示当前工作区并注明是跟随状态',
  textOf(tree).includes('发送目标：禅道工作台插件（E:\\Eworkspace\\dsh-zentao-workbench）（跟随当前工作区）'),
  findByClass(tree, 'dzw-target-text') === undefined ? '(缺 dzw-target-text)' : textOf(findByClass(tree, 'dzw-target-text')),
);

// 下拉 onChange → 第 15 个 state（下标 14）
hookState.setters = [];
try {
  picker.props.onChange({ target: { value: 'ws-9' } });
  caught = undefined;
} catch (error) {
  caught = error;
}
ok('改下拉不抛异常', caught === undefined, caught?.stack ?? caught);
ok(
  '选中工作区写回下标 14（pick state）',
  hookState.setters.some((entry) => entry.index === 14 && entry.value === 'ws-9'),
  JSON.stringify(hookState.setters.map((entry) => ({ index: entry.index, value: entry.value }))),
);

// 选中 ws-9 后：文案、发送链路、提示词的工作区段落
uiCalls.length = 0;
sessionApi.length = 0;
sentPrompts.length = 0;
tree = renderPass(P({ pick: 'ws-9' }));
await flush();
const targetText9 = findByClass(tree, 'dzw-target-text');
ok(
  '选中 ws-9 后文案与下拉都指到「另一个项目」',
  textOf(targetText9).includes('另一个项目（E:\\Eworkspace\\other）') &&
    !textOf(targetText9).includes('跟随当前工作区') &&
    String(findByClass(tree, 'dzw-select')?.props?.value) === 'ws-9',
  textOf(targetText9),
);
const handle9 = findByText(tree, '处理');
try {
  handle9.props.onClick();
  await flush();
  caught = undefined;
} catch (error) {
  caught = error;
}
ok('选中 ws-9 后点「处理」不抛异常', caught === undefined, caught?.stack ?? caught);
ok(
  '会话建在选中的 ws-9 上（不是主面板当前的 ws-1）',
  uiCalls.some((entry) => entry.op === 'connectWorkspace' && entry.workspaceId === 'ws-9') &&
    !uiCalls.some((entry) => entry.op === 'connectWorkspace' && entry.workspaceId === 'ws-1'),
  JSON.stringify(uiCalls),
);
ok(
  '提示词里的工作区段落换成 ws-9（标题 + 路径，不再是 ws-1）',
  sentPrompts[0]?.includes('另一个项目') &&
    sentPrompts[0]?.includes('E:\\Eworkspace\\other') &&
    !sentPrompts[0]?.includes('E:\\Eworkspace\\dsh-zentao-workbench'),
  sentPrompts[0]?.slice(-400),
);

// 选中的工作区被移除：订阅回调把选择重置回「跟随当前工作区」
tree = renderPass(P({ pick: 'ws-gone' }));
await flush();
hookState.setters = [];
for (const listener of listSubscribers.slice()) listener();
ok(
  '选中的工作区消失后自动回到「跟随当前工作区」（下标 14 → 空串）',
  hookState.setters.some((entry) => entry.index === 14 && entry.value === ''),
  JSON.stringify(hookState.setters.map((entry) => ({ index: entry.index, value: entry.value }))),
);

// 只有 1 个工作区：不给下拉（省版面）
const ws1Item = workspaceItems[0];
const ws9Item = workspaceItems[1];
workspaceItems.splice(0, workspaceItems.length, ws1Item);
tree = renderPass(P({}));
await flush();
ok('只有一个工作区时不渲染下拉，但目标行仍在', findByClass(tree, 'dzw-select') === undefined && findByClass(tree, 'dzw-target') !== undefined);
ok(
  '只有一个工作区时文案点明「当前只有 1 个工作区」',
  textOf(findByClass(tree, 'dzw-target-text')).includes('（当前只有 1 个工作区）'),
  textOf(findByClass(tree, 'dzw-target-text')),
);
workspaceItems.splice(0, workspaceItems.length, ws1Item, ws9Item);
tree = renderPass(P({}));
await flush();
ok('恢复多工作区后下拉又回来', findByClass(tree, 'dzw-select') !== undefined);

// 直接把不存在的 workspaceId 交给 handlePrompt：必须明确报错，不能静默发到别的项目里
const rawHandlePrompt = slotRegistration.Component({}).props.handlePrompt;
let staleError;
try {
  await rawHandlePrompt('x', 'ws-gone');
} catch (error) {
  staleError = error;
}
ok(
  'handlePrompt 收到已不存在的工作区 ID 时明确报错',
  staleError instanceof Error && staleError.message.includes('已不在'),
  String(staleError),
);

ok(
  'CSS：目标行是 flex 容器，下拉限宽不挤掉文字',
  /\.dzw-target\s*\{[^}]*display:\s*flex/.test(cssText) &&
    /\.dzw-target-text\s*\{[^}]*text-overflow:\s*ellipsis/.test(cssText) &&
    /\.dzw-target\s+\.dzw-select\s*\{[^}]*max-width/.test(cssText),
  (cssText.match(/\.dzw-target\s*\{[^}]*\}/) ?? [''])[0],
);

console.log('\n== 13. 加载、详情失败、防重入与缓存隔离 ==');
tree = renderPass(T({}));
await flush();
hookState.setters = [];
sentPrompts.length = 0;
detailFails = true;
findByText(tree, '处理').props.onClick();
await flush();
ok('详情失败不创建会话或发送残缺提示词', sentPrompts.length === 0);
ok('详情失败显示明确提示', hookState.setters.some((entry) => entry.index === 6 && String(entry.value).includes('未发送不完整')));
findByText(tree, '复制提示词').props.onClick();
await flush();
ok('复制路径详情失败不产生未处理拒绝', unhandled.length === 0);
detailFails = false;
const sameHandle = findByText(tree, '处理');
sameHandle.props.onClick();
sameHandle.props.onClick();
await flush(12);
ok('同一轮连续处理只发送一次', sentPrompts.length === 1);

const isolated = T({ analyses: analysisFor42() });
isolated[2] = { ...loggedInConfig, account: '测试另一账号' };
tree = renderPass(isolated);
await flush();
ok('其他账号不显示同编号旧分析', findByClass(tree, 'dzw-analysis') === undefined);
isolated[2] = { ...loggedInConfig, server: 'https://another.example.invalid' };
tree = renderPass(isolated);
await flush();
ok('其他服务器不显示同编号旧分析', findByClass(tree, 'dzw-analysis') === undefined);
const changedContent = T({ analyses: analysisFor42() });
changedContent[8] = { ...loggedInData, tasks: loggedInData.tasks.map((item) => item.id === '42' ? { ...item, title: '测试新标题' } : item) };
tree = renderPass(changedContent);
await flush();
ok('列表内容变化不显示旧分析', findByClass(tree, 'dzw-analysis') === undefined);

tree = renderPass(T({ analyses: analysisFor42() }));
await flush();
detailFingerprint = '测试新正文指纹';
sentPrompts.length = 0;
findByText(tree, '处理').props.onClick();
await flush(12);
ok('详情正文变化不把旧分析带进提示词', sentPrompts.length === 1 && !sentPrompts[0].includes('## AI 预判'));
detailFingerprint = '测试正文指纹';

tree = renderPass(T({}));
await flush();
hookState.setters = [];
let releaseAnalysis;
analyzeGate = new Promise((resolve) => { releaseAnalysis = resolve; });
const beforePending = calls.filter((entry) => entry.endpoint === 'analyze').length;
const pendingAnalyzeButton = findByText(tree, 'AI 分析');
pendingAnalyzeButton.props.onClick();
pendingAnalyzeButton.props.onClick();
await flush();
ok('同条目并发分析只调用一次宿主', calls.filter((entry) => entry.endpoint === 'analyze').length === beforePending + 1);
findByText(tree, '刷新').props.onClick();
await flush();
hookState.setters = [];
releaseAnalysis();
await flush(12);
analyzeGate = undefined;
ok('刷新后旧分析完成不会回写缓存', !hookState.setters.some((entry) => entry.index === 15 && Object.keys(entry.value).length > 0));

tree = renderPass(T({ analyses: analysisFor42() }));
await flush();
hookState.setters = [];
findByText(tree, '刷新').props.onClick();
await flush(12);
ok('刷新不会清空已完成预判（避免每次刷新都重花模型调用）', !hookState.setters.some((entry) => entry.index === 15));
ok('刷新后预判块仍在列表里', findByClass(tree, 'dzw-analysis') !== undefined);

calls.length = 0;
tree = renderPass(T({ tab: 'bug' }));
await flush();
ok('首次切 Bug 页只聚合 Bug（不再连需求一起扫）', calls.some((entry) => entry.endpoint === 'refresh' && entry.payload.scope === 'bugs'), JSON.stringify(calls.map((entry) => entry.payload)));
calls.length = 0;
tree = renderPass(T({ tab: 'story' }));
await flush();
ok('首次切需求页只聚合需求', calls.some((entry) => entry.endpoint === 'refresh' && entry.payload.scope === 'stories'), JSON.stringify(calls.map((entry) => entry.payload)));
calls.length = 0;
tree = renderPass(T({ tab: 'task' }));
await flush();
ok('任务页仅加载任务且启动不重复拉取', calls.filter((entry) => entry.endpoint === 'refresh').length === 1 && calls.find((entry) => entry.endpoint === 'refresh').payload.scope === 'tasks');

// 性能：任务页点「刷新」不应顺带扫全部产品（旧实现固定打 scope=all，实测 4.5s → 0.2s）。
calls.length = 0;
hookState.setters = [];
findByText(tree, '刷新').props.onClick();
await flush(12);
ok('任务页「刷新」只拉任务（不再顺带扫产品）', calls.find((entry) => entry.endpoint === 'refresh')?.payload.scope === 'tasks', JSON.stringify(calls.map((entry) => entry.payload)));
ok('「刷新」带 force=true（明确要求重拉，不吃宿主缓存）', calls.find((entry) => entry.endpoint === 'refresh')?.payload.force === true, JSON.stringify(calls.map((entry) => entry.payload)));
ok('任务页刷新按钮带「单个请求」的说明', String(findByText(tree, '刷新').props.title ?? '').includes('单个请求'));
const mergedSetter = hookState.setters.findLast((entry) => entry.index === 8);
ok(
  '任务页刷新是合并更新，不清空已加载的 Bug/需求',
  mergedSetter?.value?.bugs?.length === loggedInData.bugs.length &&
    mergedSetter.value.stories.length === loggedInData.stories.length &&
    mergedSetter.value.tasks.length > 0 &&
    mergedSetter.value.fetchedAt !== '',
  JSON.stringify({ bugs: mergedSetter?.value?.bugs?.length, stories: mergedSetter?.value?.stories?.length, tasks: mergedSetter?.value?.tasks?.length }),
);

// Bug 页点「刷新」：已加载过也要强制重拉（force），且只重扫 Bug。
calls.length = 0;
tree = renderPass(T({ tab: 'bug' }));
await flush();
calls.length = 0;
hookState.setters = [];
findByText(tree, '刷新').props.onClick();
await flush(12);
const bugRefresh = calls.find((entry) => entry.endpoint === 'refresh');
ok('Bug 页「刷新」只重扫 Bug 且强制绕过缓存', bugRefresh?.payload.scope === 'bugs' && bugRefresh.payload.force === true, JSON.stringify(calls.map((entry) => entry.payload)));
const bugMerge = hookState.setters.findLast((entry) => entry.index === 8);
ok(
  'Bug 页刷新不清空需求列表',
  bugMerge?.value?.stories?.length === loggedInData.stories.length && bugMerge.value.bugs.length > 0,
  JSON.stringify({ bugs: bugMerge?.value?.bugs?.length, stories: bugMerge?.value?.stories?.length }),
);

// 未加载过的类别显示「…」而不是 0（避免误以为「一条都没有」）。
// 还没有数据、也没加载过 → 显示「…」；从快照恢复了旧数据 → 直接显示条数。
const emptyOthers = T({ tab: 'task' });
emptyOthers[8] = { ...loggedInData, bugs: [], stories: [] };
tree = renderPass(emptyOthers);
await flush();
const beforeLoadText = textOf(tree);
ok('尚未加载过的类别显示省略号而不是 0', beforeLoadText.includes('Bug（…）') && beforeLoadText.includes('需求（…）'), beforeLoadText.match(/任务（[^）]*）|Bug（[^）]*）|需求（[^）]*）/g)?.join(' '));
tree = renderPass(T({ tab: 'task' }));
await flush();
ok('有数据时直接显示条数（不显示省略号）', textOf(tree).includes('Bug（1）') && textOf(tree).includes('需求（1）'), textOf(tree).match(/任务（[^）]*）|Bug（[^）]*）|需求（[^）]*）/g)?.join(' '));

// 数据新鲜度：footer 显示「更新于 HH:MM:SS」（Bug/需求有 2 分钟缓存，用户需要知道手里这份多旧）。
tree = renderPass(T({ tab: 'task' }));
await flush();
ok('footer 显示最近取数时间', /更新于 \d{2}:\d{2}:\d{2}/.test(textOf(tree)), textOf(tree).match(/更新于[^）]*\d{2}:\d{2}:\d{2}/)?.[0]);
ok('CSS：新鲜度那行不会被压缩', /\.dzw-fresh\s*\{[^}]*flex:\s*0 0 auto/.test(cssText), (cssText.match(/\.dzw-fresh\s*\{[^}]*\}/) ?? [''])[0]);

// ---- 渐进扫描：宿主先回首包，客户端轮询增量补齐 ----------------------------
scanJobMode = true;
scanPolls.length = 0;
calls.length = 0;
hookState.setters = [];
tree = renderPass(T({ tab: 'bug' }));
await flush();
ok('渐进模式：切 Bug 页立刻返回（还没等到轮询就先渲染）', calls.some((entry) => entry.endpoint === 'refresh' && entry.payload.scope === 'bugs') && scanPolls.length === 0, JSON.stringify({ calls: calls.map((entry) => entry.endpoint), polls: scanPolls.length }));
ok('渐进模式：首包只给空列表 + jobId（不假装扫完了）', calls.find((entry) => entry.endpoint === 'refresh')?.payload.scope === 'bugs' && !calls.some((entry) => entry.endpoint === 'scanProgress'));
// 进度与首包计数按 state 断言（mock 不重渲染；文本断言用下一趟注入的 preset）。
const progressSetter = hookState.setters.find((entry) => entry.index === 16 && entry.value !== null);
ok('渐进模式：登记扫描进度（第 17 个 state）', progressSetter?.value?.total === 2, JSON.stringify(progressSetter?.value));
tree = renderPass(T({ tab: 'bug', data: { ...loggedInData, bugs: [] }, progress: { done: 0, total: 2, pending: 1 } }));
await flush();
ok('渐进模式：显示「正在扫描 0/2 个产品」', textOf(tree).includes('正在扫描 0/2 个产品'), textOf(tree).match(/正在扫描[^）]*/)?.[0]);
ok('渐进模式：未扫到时计数显示省略号而不是 0', textOf(tree).includes('Bug（…）'), textOf(tree).match(/Bug（[^）]*）/)?.[0]);

// 扫描期间必须**保留**已有列表，不能先闪空再一点点长出来。
scanPolls.length = 0;
calls.length = 0;
hookState.setters = [];
tree = renderPass(T({ tab: 'bug' }));
await flush();
const bugSettersDuringScan = hookState.setters.filter((entry) => entry.index === 8) ?? [];
ok(
  '扫描期间保留已有列表（不闪空）',
  bugSettersDuringScan.every((entry) => (entry.value?.bugs ?? []).length > 0),
  JSON.stringify(bugSettersDuringScan.map((entry) => entry.value?.bugs?.length)),
);

await new Promise((resolve) => setTimeout(resolve, 950));
const pollsAfterFirstWait = scanPolls.length;
ok('客户端轮询了 scanProgress', pollsAfterFirstWait >= 2 && scanPolls.every((id) => id === 'job-1'), JSON.stringify(scanPolls));
await new Promise((resolve) => setTimeout(resolve, 600));
ok('扫完即停：轮询次数不再增长', scanPolls.length === pollsAfterFirstWait, `${pollsAfterFirstWait} → ${scanPolls.length}`);
ok('轮询到的条目写进第 9 个 state（data.bugs）', hookState.setters.some((entry) => entry.index === 8 && JSON.stringify(entry.value).includes('列表页崩溃')), 'setter 未写入 bugs');
ok('扫描完成后进度条消失', hookState.setters.some((entry) => entry.index === 16 && entry.value === null), JSON.stringify(hookState.setters.filter((e) => e.index === 16).map((e) => e.value)));
scanJobMode = false;

// ---- 快照持久化：重启/刷新后先渲染旧数据 -----------------------------------
localStorageData.clear();
calls.length = 0;
tree = renderPass(T({ tab: 'task' }));
await flush();
const storedKeys = [...localStorageData.keys()];
ok('取数成功后写入本地快照', storedKeys.length === 1 && storedKeys[0].startsWith('dsh-zentao-workbench:snapshot:'), JSON.stringify(storedKeys));
const stored = JSON.parse(localStorageData.get(storedKeys[0]));
ok('快照带版本号与数据', stored.v === 1 && stored.data.tasks.length === 3, JSON.stringify(Object.keys(stored)));
// 模拟「重启后首次挂载」：不注入任何 state，靠 getConfig + 快照恢复。
hookState.setters = [];
tree = renderPass([]);
await flush();
const restoredSetter = hookState.setters.find((entry) => entry.index === 8 && entry.value?.tasks?.length === 3);
ok('重启后首屏先用本地快照渲染（秒开）', restoredSetter !== undefined, JSON.stringify(hookState.setters.filter((e) => e.index === 8).map((e) => e.value?.tasks?.length)));
ok('恢复快照后仍然照常刷新（不把旧数据当最终结果）', calls.some((entry) => entry.endpoint === 'refresh'), JSON.stringify(calls.map((entry) => entry.endpoint)));

// 退出登录必须清掉快照，避免换账号后看到上一个人的数据。
tree = renderPass(T({ tab: 'task' }));
await flush();
calls.length = 0;
findByText(tree, '退出登录').props.onClick();
await flush(12);
ok('退出登录清掉本地快照', localStorageData.size === 0, JSON.stringify([...localStorageData.keys()]));

// ---- 任务总量提示：超过 LIST_LIMIT 时必须说清只显示了前 N 条 ----------------
const overLimit = T({ tab: 'task' });
overLimit[8] = { ...loggedInData, taskTotal: 88 };
tree = renderPass(overLimit);
await flush();
ok('任务超出列表上限时提示「仅显示前 N 条」', textOf(tree).includes('共 88 条任务，仅显示前 3 条'), textOf(tree).match(/共 \d+ 条任务[^）]*/)?.[0]);

// ---- 登录状态失效（Token 过期）：可恢复，不糊红字、不留死界面 ------------------
authFails = true;
hookState.setters = [];
calls.length = 0;
tree = renderPass(T({}));
await flush();
ok('Token 过期后标记为「需要重新登录」状态（第 18 个 state）', hookState.setters.some((entry) => entry.index === 17 && entry.value === true), JSON.stringify(hookState.setters.filter((e) => e.index === 17).map((e) => e.value)));
ok('不再把 401 显示成红色错误条', !hookState.setters.some((entry) => entry.index === 5 && String(entry.value).trim() !== ''), JSON.stringify(hookState.setters.filter((e) => e.index === 5).map((e) => e.value)));
ok('登录失效后不再自动重试刷新', calls.filter((entry) => entry.endpoint === 'refresh').length <= 1, JSON.stringify(calls.map((entry) => entry.endpoint)));

// 这个状态下的界面：中性提示 + 登录表单（服务器/账号已带出），列表与「处理」不再出现。
tree = renderPass(T({ authExpired: true }));
await flush();
const expiredText = textOf(tree);
ok('给出一行中性提示而不是报错', expiredText.includes('登录状态已失效') && expiredText.includes('请重新登录'), expiredText.match(/禅道登录状态[^。]*。/)?.[0]);
ok('自动切回登录表单（可直接重新登录）', expiredText.includes('服务器') && expiredText.includes('账号') && findByText(tree, '登录') !== undefined);
ok('失效时不显示列表与「处理」（避免点半截数据）', findByText(tree, '处理') === undefined && !expiredText.includes('发送目标'));
ok('失效时「刷新」按钮禁用', findByText(tree, '刷新')?.props?.disabled === true, JSON.stringify(findByText(tree, '刷新')?.props?.disabled));

// 重新登录后立刻恢复：清掉失效标记并重新拉一次列表。
authFails = false;
calls.length = 0;
hookState.setters = [];
tree = renderPass(T({ authExpired: true }));
await flush();
const reloginButton = findByText(tree, '登录');
reloginButton.props.onClick();
await flush(12);
ok('重新登录会调用 login 端点', calls.some((entry) => entry.endpoint === 'login'), JSON.stringify(calls.map((entry) => entry.endpoint)));
ok('登录成功后清掉「需要重新登录」状态', hookState.setters.some((entry) => entry.index === 17 && entry.value === false), JSON.stringify(hookState.setters.filter((e) => e.index === 17).map((e) => e.value)));
ok('登录成功后自动重新拉列表', calls.some((entry) => entry.endpoint === 'refresh' && entry.payload.scope === 'tasks'), JSON.stringify(calls.map((entry) => entry.payload)));

// ---- 「记住密码」：勾选项、默认勾选、已保存提示与清除 -------------------------
const inputNodes = (t) => {
  const found = [];
  walk(t, (node) => {
    if (typeof node === 'object' && node !== null && node.type === 'input' && node.props?.type === 'checkbox') found.push(node);
  });
  return found;
};
tree = renderPass(T({ authExpired: true }));
await flush();
ok('登录表单有「记住密码」选项', textOf(tree).includes('记住密码') && textOf(tree).includes('加密保存，Token 过期自动重登'), textOf(tree).match(/记住密码[^\n]{0,40}/)?.[0]);
ok(
  'CSS：勾选项不再被 60px 的 label 宽度压成一字一行',
  /\.dzw-row\s*>\s*label\.dzw-check\s*\{[^}]*width:\s*auto/.test(cssText) &&
    /\.dzw-check\s*\{[^}]*align-items:\s*flex-start/.test(cssText) &&
    /\.dzw-check\s*>\s*input\s*\{[^}]*flex:\s*none/.test(cssText),
  (cssText.match(/\.dzw-row\s*>\s*label\.dzw-check\s*\{[^}]*\}/) ?? [''])[0],
);
const loginCheckboxes = inputNodes(tree);
ok('默认勾选「记住密码」（第 1 个复选框）并保留「记住 Token」', loginCheckboxes.length >= 2 && loginCheckboxes[0].props.checked === true, JSON.stringify(loginCheckboxes.map((n) => n.props.checked)));

calls.length = 0;
findByText(tree, '登录').props.onClick();
await flush(12);
ok('登录载荷带上 rememberPassword', calls.find((entry) => entry.endpoint === 'login')?.payload?.rememberPassword === true, JSON.stringify(calls.find((entry) => entry.endpoint === 'login')?.payload));

// 已保存密码时：界面明示「Token 过期会自动重登」，并可一键清除。
tree = renderPass(T({}));
await flush();
ok('已保存密码时给出提示', textOf(tree).includes('已保存密码') && textOf(tree).includes('Token 过期会自动重新登录'), textOf(tree).match(/已保存密码[^）]*/)?.[0]);
calls.length = 0;
hookState.setters = [];
findByText(tree, '清除已保存的密码').props.onClick();
await flush(12);
ok('点「清除已保存的密码」调 forgetPassword 端点', calls.some((entry) => entry.endpoint === 'forgetPassword'), JSON.stringify(calls.map((entry) => entry.endpoint)));
ok('清除后界面按未保存密码刷新', hookState.setters.some((entry) => entry.index === 2 && entry.value?.rememberPassword === false), JSON.stringify(hookState.setters.filter((e) => e.index === 2).map((e) => e.value?.rememberPassword)));
authFails = false;

console.log(`\n== 结果：${checks - failures}/${checks} 通过 ==`);
runCleanups();
process.exit(failures === 0 ? 0 : 1);
