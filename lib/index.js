/**
 * 禅道工作台 · 宿主（Host）半侧。
 *
 * 职责：
 *   1. 注册自有 webServer 路由 `POST /zentao-workbench/<endpoint>`（ctx.inject(['webServer'])），
 *      供浏览器半侧浮层登录禅道、拉取「指派给我」的任务/Bug/需求、读取条目详情；
 *   2. 注册一个面向模型的 `zentao` 工具，复用同一份登录态与取数逻辑；
 *   3. 把禅道 token 与服务器/账号配置落到用户主目录下的配置文件（token 默认不落盘）。
 *
 * 设计约束（刻意为之）：
 *   - 只使用 node: 内建模块与全局 fetch，**不 import 任何 @deepseek-ai/* 包**。
 *     原因是本地 link 安装时 pnpm 不会为被链接包安装依赖，宿主半侧一旦 import 官方包就会
 *     在 profile 的 node_modules 之外解析失败。工具定义因此直接写原始 JSON Schema
 *     （dsh-tools 支持的子集：type/oneOf/properties/required/additionalProperties/items/enum/const）。
 *   - 禅道实例按 REST API v1 对接（`api.php/v1`），与工作区《禅道接口.md》记录一致；
 *     该实例的 v2 入口不可用。
 *
 * @module dsh-zentao-workbench
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';

/** Cordis 插件名（唯一即可，与包名解耦）。 */
export const name = 'zentao-workbench';

/**
 * 依赖的宿主服务：只有 `tools`（注册 zentao 工具）。
 *
 * `webServer` **不写在这里**，而是用下方的 `ctx.inject(['webServer'], …)` 拿嵌套上下文。
 * 原因：`connection.rpc.handle()` 会以「调用方自己的 Context」去执行
 * `owner.effect(() => owner.webServer.register({ kind:'prefix', path:channel, handler }))`
 * （见 dsh-client-connection/lib/index.js 的 `get rpc()` 与 `register()`），而这个 tracker
 * （`an(this, ne.tracker, { property:'ctx', noShadow:true })`）**会跳过 ctx.inject 派生的
 * 影子上下文**，解析回本插件行自己的 fiber —— 那里没有 webServer。实测：模块级 inject、
 * row 级 inject（cordis.patch.yml 的 `inject: [webServer]`）**都**仍然抛
 * `cannot get property "webServer" without inject` → apply 抛错 → 插件被跳过 →
 * 浏览器 POST 掉到 SPA 兜底处理器 → 界面报 `HTTP 405`。
 *
 * 结论：**第三方插件行不要用 `ctx.connection.rpc`**，直接注册自有 webServer 路由。
 */
export const inject = ['tools'];

/** 浏览器半侧调用的 RPC 路由前缀（`POST /zentao-workbench/<endpoint>`）。 */
const RPC_METHOD = '/zentao-workbench';

/**
 * 配置落盘位置；只存服务器/账号/职位，token 仅在用户勾选「记住 Token」时写入。
 * 允许用 DSH_ZENTAO_WORKBENCH_CONFIG 覆盖，便于离线冒烟测试不碰真实用户配置。
 */
const CONFIG_PATH = asString(process.env.DSH_ZENTAO_WORKBENCH_CONFIG) || join(homedir(), '.dsh-zentao-workbench.json');

/** 单次禅道 HTTP 请求超时。 */
const REQUEST_TIMEOUT_MS = 20000;

/** 「指派给我」聚合时最多扫描多少个产品（Bug/需求只能按产品维度取）。 */
const MAX_PRODUCTS = 30;

/** 按产品聚合时的并发度。 */
const CONCURRENCY = 4;

/** 列表类结果最多保留多少条，避免提示词与浮层被刷屏。 */
const LIST_LIMIT = 50;

/** 工具文本结果的大小上限（字符），超出截断并提示。 */
const TOOL_TEXT_LIMIT = 20000;

// ---------------------------------------------------------------------------
// 纯函数工具
// ---------------------------------------------------------------------------

/** 把未知值安全收窄成普通对象。 */
function asObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
}

/** 把未知值安全收窄成字符串。 */
function asString(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * 取「人」的账号。禅道对同一语义有两种形状：列表/详情里的 `assignedTo`、`openedBy`、`finishedBy`
 * 可能是**字符串账号**，也可能是 `{id, account, avatar, realname}` **对象**（实测任务详情就是对象），
 * 早期直接 `asString(item.assignedTo)` 会把对象收窄成空串，导致「指派给我的」过滤形同虚设。
 * @param {unknown} value - 原始字段值。
 * @returns {string} 账号；识别不出时为空串。
 */
function accountOf(value) {
  return asString(value) || asString(asObject(value)?.account);
}

/** 取「人」的显示名（禅道的 `realname`）；没有就退回账号。 */
function personName(value) {
  return asString(asObject(value)?.realname) || accountOf(value);
}

/**
 * 把「数字 id 或字符串」统一转成字符串。
 * `asString` 只认字符串，而禅道的 id 字段（`storyID`、`task`、`parent`…）经常是数字，
 * 直接用 `asString` 会得到空串 —— 早期 `story` 字段就是这样被吞掉的。
 */
function scalarString(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return asString(value);
}

/**
 * 归一化用户输入的禅道地址。
 * 允许省略协议、允许带 `/api.php/v1` 后缀、允许尾斜杠。
 * @param {unknown} input - 原始输入。
 * @returns {string} 形如 `http://host:port/zentao` 的根地址；无法识别时为空串。
 */
function normalizeServer(input) {
  let url = asString(input).trim();
  if (url === '') return '';
  url = url.replace(/\/+$/, '');
  url = url.replace(/\/api\.php(\/v[0-9]+)?$/i, '');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `http://${url}`;
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`;
  } catch {
    return '';
  }
}

/** 拼出 v1 REST 基础路径。 */
function apiBase(server) {
  return `${server}/api.php/v1`;
}

/**
 * 拼出禅道网页原始链接（浮层与提示词里给人工点开用）。
 * `server` 由 normalizeServer 归一化，已经带着部署路径（例如 `http://host:11180/zentao`），
 * 所以这里不能再补一段 `/zentao`，否则会拼成 `/zentao/zentao/...`。
 */
export function webLink(server, kind, id) {
  return `${server}/${kind}-view-${encodeURIComponent(id)}.html`;
}

/** 判断是不是禅道附件链接（正文里内嵌的图片 / 文件都走 `file-read-*`）。 */
function isAttachmentUrl(url) {
  return /file-read|file-download|\/file\/|download/i.test(String(url));
}

/** 把正文里的相对地址补成绝对地址（禅道会写 `/zentao/file-read-1.png` 这种根相对路径）。 */
function absoluteUrl(url, baseUrl) {
  const text = asString(url);
  if (text === '') return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || text.startsWith('//')) return text;
  const base = asString(baseUrl).replace(/\/+$/, '');
  if (base === '') return text;
  if (text.startsWith('/')) {
    const origin = /^(https?:\/\/[^/]+)/i.exec(base);
    return origin === null ? `${base}${text}` : `${origin[1]}${text}`;
  }
  return `${base}/${text.replace(/^\.\//, '')}`;
}

/** 附件的展示名：优先链接文字，其次文件名。 */
function attachmentName(label, url) {
  const text = htmlToText(label, '').replace(/\s+/g, ' ').trim();
  if (text !== '' && !text.startsWith('[附件]')) return text;
  const path = String(url).split(/[?#]/)[0];
  const name = path.slice(path.lastIndexOf('/') + 1);
  return name === '' ? '附件' : name;
}

/**
 * 把禅道常见的富文本字段（steps/desc/spec/bugSteps）降级成可读纯文本。
 *
 * 注意：禅道的**附件就是正文里的 `<img src="…/file-read-*.png">` 与 `<a href="…/file-*">`**，
 * 早期版本把 `<img>` 直接删掉，导致「步骤里的截图附件」在界面上永远看不见。
 * 这里改为把附件链接保留成 `[附件] <绝对地址>`。
 *
 * @param {unknown} input - HTML 片段。
 * @param {string} [baseUrl] - 禅道服务器地址，用于把相对附件路径补全。
 */
export function htmlToText(input, baseUrl = '') {
  if (typeof input !== 'string' || input.trim() === '') return '';
  const withImages = input.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag);
    if (src === null) return '';
    const url = absoluteUrl(src[1], baseUrl);
    return isAttachmentUrl(url) ? `\n[附件] ${url}\n` : '';
  });
  const withLinks = withImages.replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (tag, href, label) => {
    const url = absoluteUrl(href, baseUrl);
    if (isAttachmentUrl(url)) return `\n[附件] ${attachmentName(label, url)} ${url}\n`;
    if (/^https?:\/\//i.test(url)) {
      const text = String(label).replace(/<[^>]+>/g, '').trim();
      return text === '' || text === url ? url : `${text}（${url}）`;
    }
    return label;
  });
  return withLinks
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 从正文 HTML 与 `files` 数组里抽出附件清单（去重、顺序稳定）。
 *
 * @param {unknown} input - 正文 HTML（steps / desc / spec / bugSteps 拼起来的那份）。
 * @param {string} [baseUrl] - 禅道服务器地址。
 * @param {unknown} [files] - 详情响应里的 `files` 字段（通常为空数组，但有些版本会有）。
 * @returns {{ name: string, url: string }[]} 附件清单。
 */
export function extractAttachments(input, baseUrl = '', files = []) {
  const out = [];
  const seen = new Set();
  const push = (name, url) => {
    if (url === '' || seen.has(url)) return;
    seen.add(url);
    out.push({ name, url });
  };
  if (typeof input === 'string') {
    for (const match of input.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
      const url = absoluteUrl(match[1], baseUrl);
      if (isAttachmentUrl(url)) push(attachmentName('', url), url);
    }
    for (const match of input.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      const url = absoluteUrl(match[1], baseUrl);
      if (isAttachmentUrl(url)) push(attachmentName(match[2], url), url);
    }
  }
  for (const entry of Array.isArray(files) ? files : []) {
    const file = asObject(entry);
    if (file === undefined) continue;
    const direct = asString(file.url) || asString(file.webUrl) || asString(file.downloadUrl);
    const id = file.id === undefined || file.id === null ? '' : String(file.id);
    const extension = asString(file.extension);
    const url = direct !== '' ? absoluteUrl(direct, baseUrl) : id === '' ? '' : absoluteUrl(`file-read-${id}${extension === '' ? '' : `.${extension}`}`, baseUrl);
    push(attachmentName(asString(file.title) || asString(file.name) || asString(file.originalName), url), url);
  }
  return out;
}

/** 从禅道响应里宽容地取出列表：兼容裸数组、`{key:[...]}`、`{data:{key:[...]}}`。 */
function pickList(data, key) {
  if (Array.isArray(data)) return data;
  const direct = asObject(data)?.[key];
  if (Array.isArray(direct)) return direct;
  const inner = asObject(asObject(data)?.data)?.[key];
  if (Array.isArray(inner)) return inner;
  const nested = asObject(data)?.data;
  if (Array.isArray(nested)) return nested;
  return [];
}

/** 从禅道响应里宽容地取出单条：兼容 `{key:{...}}`、`{data:{...}}`、裸对象。 */
function pickOne(data, key) {
  const row = asObject(data);
  if (row === undefined) return {};
  return asObject(row[key]) ?? asObject(row.data) ?? row;
}

/**
 * 取出单条实体。禅道 v1 的详情响应键名不稳定：`{task:{...}}`、`{tasks:{...}}`、
 * `{data:{task:{...}}}`、`{data:{...}}` 与裸对象都出现过，这里全部兼容。
 * @param {unknown} data - 响应体。
 * @param {string} singular - 单数键名，例如 `task`。
 * @param {string} plural - 复数键名，例如 `tasks`。
 */
function pickEntity(data, singular, plural) {
  const row = asObject(data);
  if (row === undefined) return {};
  for (const key of [singular, plural, 'data']) {
    const candidate = asObject(row[key]);
    if (candidate === undefined) continue;
    return asObject(candidate[singular]) ?? asObject(candidate[plural]) ?? candidate;
  }
  return row;
}

/** 禅道业务失败（HTTP 200 但 status 表示失败）时的消息。 */
function businessFailure(data) {
  const row = asObject(data);
  if (row === undefined) return '';
  const status = asString(row.status);
  if (status !== 'fail' && status !== 'failed' && status !== 'error') return '';
  const message = row.message ?? row.reason ?? row.error;
  return typeof message === 'string' && message !== '' ? message : '禅道返回了失败状态';
}

/** 列表条目统一视图：字段名在不同对象上不一致（title/name）。 */
/**
 * 禅道状态值的中文名。界面与工具输出都用它，避免出现裸的 `wait` / `active` 这类英文。
 * 表里没有的值原样透出，不会显示成空白。
 */
const STATUS_LABEL = {
  task: {
    wait: '未开始',
    doing: '进行中',
    done: '已完成',
    closed: '已关闭',
    cancel: '已取消',
    pause: '已暂停',
    stop: '已停止',
  },
  bug: {
    active: '激活',
    resolved: '已解决',
    closed: '已关闭',
  },
  story: {
    draft: '草稿',
    reviewing: '评审中',
    active: '激活',
    changed: '已变更',
    closed: '已关闭',
  },
};

/** 历史动作动词的中文名（禅道 `actions[].action`）。未收录的原样显示。 */
const ACTION_LABEL = {
  opened: '创建',
  created: '创建',
  edited: '编辑',
  commented: '备注',
  assigned: '指派',
  started: '开始',
  finished: '完成',
  closed: '关闭',
  activated: '激活',
  resolved: '解决',
  canceled: '取消',
  paused: '暂停',
  restarted: '继续',
  deleted: '删除',
  undeleted: '还原',
  archived: '归档',
  confirmed: '确认',
  reviewed: '评审',
  changed: '变更',
  linked: '关联',
  unlinked: '取消关联',
  fileadded: '上传附件',
  filedeleted: '删除附件',
  mentioned: '提及',
  frombug: '由 Bug 转入',
  tostory: '转入需求',
  totask: '转入任务',
  subtask: '创建子任务',
  estimated: '预计工时',
  consumed: '登记工时',
  recordwork: '登记工时',
};

/** 取中文状态名；表里没有就退回原值。 */
function statusLabel(kind, status) {
  const raw = asString(status);
  if (raw === '') return '';
  return STATUS_LABEL[kind]?.[raw] ?? raw;
}

/** 取中文动作名；表里没有就退回原值。 */
function actionLabel(action) {
  const raw = asString(action);
  if (raw === '') return '';
  return ACTION_LABEL[raw.toLowerCase()] ?? raw;
}

/**
 * 任务类型 / Bug 类型 / 需求分类的中文名（禅道叫 `type` / `category`）。
 * 表里没有的值原样透出，不丢信息。
 */
const TYPE_LABEL = {
  task: {
    devel: '开发',
    design: '设计',
    test: '测试',
    study: '研究',
    discuss: '讨论',
    ui: '界面',
    affair: '事务',
    misc: '其他',
  },
  bug: {
    codeerror: '代码错误',
    config: '配置相关',
    install: '安装部署',
    security: '安全相关',
    performance: '性能问题',
    standard: '标准规范',
    automation: '自动化测试',
    designdefect: '设计缺陷',
    others: '其他',
  },
  story: {
    feature: '功能',
    interface: '接口',
    performance: '性能',
    safe: '安全',
    experience: '体验',
    improve: '改进',
    other: '其他',
  },
};

/** Bug 严重程度（禅道固定 1-4 档）。 */
const SEVERITY_LABEL = { 1: '严重', 2: '一般', 3: '轻微', 4: '建议' };

/** Bug 解决方案。 */
const RESOLUTION_LABEL = {
  fixed: '已修复',
  duplicate: '重复',
  bydesign: '设计如此',
  wontfix: '不予修复',
  notrepro: '无法重现',
  defer: '延期处理',
  external: '外部原因',
};

/** 需求阶段（`stage`）。 */
const STAGE_LABEL = {
  wait: '未开始',
  projected: '已立项',
  developing: '研发中',
  testing: '测试中',
  verified: '已验收',
  released: '已发布',
  closed: '已关闭',
};

/**
 * 详情里除正文之外的散字段：`[字段名, 中文标签, 取值方式]`。
 *
 * 只挑真实实例里出现过非空值、且对处理问题有用的字段（2026-10 用真实 Token 对
 * `GET tasks/{id}` / `bugs/{id}` / `stories/{id}` 逐个核对过字段名）。
 * `取值方式` 省略表示直接转字符串；`task`/`bug`/`story` 表示套 TYPE_LABEL，
 * `severity`/`resolution`/`stage` 各自套表，`person` 取 `realname`。
 */
const DETAIL_META_FIELDS = {
  task: [
    ['executionName', '所属执行'],
    ['moduleTitle', '模块'],
    ['type', '类型', 'task'],
    ['pri', '优先级'],
    ['estimate', '预计工时'],
    ['consumed', '已耗工时'],
    ['left', '剩余工时'],
    ['estStarted', '计划开始'],
    ['realStarted', '实际开始'],
    ['finishedDate', '实际完成'],
    ['closedReason', '关闭原因'],
    ['delay', '延期（天）'],
  ],
  bug: [
    ['productName', '所属产品'],
    ['moduleTitle', '模块'],
    ['type', '类型', 'bug'],
    ['severity', '严重程度', 'severity'],
    ['keywords', '关键词'],
    ['openedBuild', '影响版本'],
    ['resolution', '解决方案', 'resolution'],
    ['resolvedBy', '解决者', 'person'],
    ['toTaskTitle', '转入任务'],
    ['pri', '优先级'],
  ],
  story: [
    ['productName', '所属产品'],
    ['moduleTitle', '模块'],
    ['category', '分类', 'story'],
    ['stage', '阶段', 'stage'],
    ['estimate', '预计工时'],
    ['reviewedBy', '评审人', 'person'],
    ['pri', '优先级'],
  ],
};

/** 按 `DETAIL_META_FIELDS` 把散字段整理成「标签 → 值」，界面与工具输出共用。 */
function detailMeta(kind, item) {
  const specs = DETAIL_META_FIELDS[kind] ?? [];
  const rows = [];
  for (const [field, label, mode] of specs) {
    const raw = item[field];
    let value = '';
    if (Array.isArray(raw)) {
      value = raw
        .map((entry) => asString(asObject(entry)?.title) || asString(asObject(entry)?.name) || asString(entry))
        .filter((entry) => entry !== '')
        .join('、');
    } else if (mode === 'person') {
      value = personName(raw);
    } else if (raw !== undefined && raw !== null && raw !== '') {
      value = String(raw).trim();
    }
    if (value === '') continue;
    let text = value;
    if (mode === 'task' || mode === 'bug' || mode === 'story') text = TYPE_LABEL[mode]?.[value] ?? value;
    else if (mode === 'severity') text = `${value}${SEVERITY_LABEL[value] === undefined ? '' : ` ${SEVERITY_LABEL[value]}`}`;
    else if (mode === 'resolution') text = RESOLUTION_LABEL[value] ?? value;
    else if (mode === 'stage') text = STAGE_LABEL[value] ?? value;
    rows.push({ label, value: text });
  }
  return rows;
}

function normalizeItem(kind, raw) {
  const item = asObject(raw) ?? {};
  return {
    kind,
    id: item.id === undefined || item.id === null ? '' : String(item.id),
    title: asString(item.title) || asString(item.name) || '（无标题）',
    status: asString(item.status),
    statusLabel: statusLabel(kind, item.status),
    assignedTo: accountOf(item.assignedTo),
    assignedToName: asString(item.assignedToRealName) || personName(item.assignedTo),
    openedBy: accountOf(item.openedBy),
    openedByName: asString(item.openedByRealName) || personName(item.openedBy),
    product: item.product === undefined ? '' : String(item.product),
    project: item.project === undefined ? '' : String(item.project),
    execution: item.execution === undefined ? '' : String(item.execution),
    deadline: asString(item.deadline),
    severity: item.severity === undefined ? '' : String(item.severity),
    pri: item.pri === undefined ? '' : String(item.pri),
    openedDate: asString(item.openedDate),
  };
}

/**
 * 详情的正文可能分散在多个字段里：任务用 `desc`，Bug 关联任务用 `bugSteps`，
 * Bug 用 `steps`，需求用 `spec`；任务还会带上所属研发需求的 `storySpec` / `storyVerify`。
 */
const DETAIL_BODY_FIELDS = {
  task: [
    ['desc', '描述'],
    ['storySpec', '研发需求描述'],
    ['storyVerify', '研发需求验收标准'],
    ['bugSteps', '重现步骤'],
    ['steps', '步骤'],
  ],
  bug: [['steps', '重现步骤'], ['desc', '描述']],
  story: [['spec', '需求描述'], ['verify', '验收标准'], ['steps', '验收步骤'], ['desc', '描述']],
};

/**
 * 条目详情视图：在列表视图上补「描述 / 步骤 / 附件」与历史动作。
 *
 * 说明：早期实现用 `item.desc ?? item.bugSteps` 取正文，而禅道对空 `desc` 返回的是**空字符串**
 * （不是 null/undefined），`??` 于是选中空串，`bugSteps` 里的重现步骤与截图附件永远不会出现。
 * 现在按字段逐个收集非空正文。
 *
 * @param {string} kind - task / bug / story。
 * @param {unknown} raw - 详情响应里的实体。
 * @param {string} [baseUrl] - 禅道服务器地址，用于补全附件地址。
 */
function normalizeDetail(kind, raw, baseUrl = '') {
  const item = asObject(raw) ?? {};
  const base = normalizeItem(kind, item);
  const fields = DETAIL_BODY_FIELDS[kind] ?? DETAIL_BODY_FIELDS.task;
  const sections = [];
  const seen = new Set();
  for (const [field, label] of fields) {
    const text = htmlToText(item[field], baseUrl);
    if (text === '' || seen.has(text)) continue;
    seen.add(text);
    sections.push({ label, text });
  }
  const rawBody = fields
    .map(([field]) => (typeof item[field] === 'string' ? item[field] : ''))
    .filter((value) => value !== '')
    .join('\n');
  const actions = Array.isArray(item.actions) ? item.actions : [];
  // 附件直链在浏览器里打不开（无 Token 头时禅道返回登录页），所以额外给出宿主代理地址。
  const attachments = extractAttachments(rawBody, baseUrl, item.files).map((file) => ({
    ...file,
    proxyUrl: `${RPC_METHOD}/attachment?url=${encodeURIComponent(file.url)}`,
  }));
  // 任务会带上所属研发需求（`storyID` + `storyTitle` + `storyStatus` + `storySpec`），
  // 早期实现完全没取这几个字段，于是「研发需求描述」在弹窗里永远看不到。
  const storyId = scalarString(item.storyID) || scalarString(item.story);
  const storyStatus = asString(item.storyStatus);
  const fromBug = item.fromBug === undefined || item.fromBug === null ? '' : String(item.fromBug);
  return {
    ...base,
    sections,
    description: sections.map((section) => section.text).join('\n\n'),
    attachments,
    verify: htmlToText(item.verify, baseUrl),
    story: {
      id: storyId,
      title: asString(item.storyTitle),
      status: storyStatus,
      statusLabel: statusLabel('story', storyStatus),
      link: storyId === '' ? '' : webLink(baseUrl, 'story', storyId),
    },
    fromBug,
    fromBugLink: fromBug === '' ? '' : webLink(baseUrl, 'bug', fromBug),
    meta: detailMeta(kind, item),
    actions: actions.slice(-10).map((entry) => {
      const action = asObject(entry) ?? {};
      return {
        actor: asString(action.actor),
        date: asString(action.date),
        action: asString(action.action),
        actionLabel: actionLabel(action.action),
        comment: htmlToText(action.comment, baseUrl),
      };
    }),
  };
}

/** 按条目 ID 倒序排列（非数字 ID 退化为字符串降序），界面与工具输出共用同一口径。 */
function sortByIdDesc(items) {
  return [...items].sort((left, right) => {
    const a = Number(left.id);
    const b = Number(right.id);
    if (Number.isFinite(a) && Number.isFinite(b) && a !== b) return b - a;
    return String(right.id).localeCompare(String(left.id));
  });
}

/** 把每条列表项渲染成模型可读的一行。 */
function itemLine(item) {
  const parts = [`- #${item.id}`];
  if (item.status !== '') parts.push(`[${item.statusLabel || item.status}]`);
  parts.push(item.title);
  if (item.assignedTo !== '' || item.assignedToName !== '') parts.push(`@${item.assignedToName || item.assignedTo}`);
  if (item.deadline !== '') parts.push(`截止 ${item.deadline}`);
  return parts.join(' ');
}

/** 渲染「指派给我」快照为模型可读 Markdown。 */
function formatSnapshot(snapshot) {
  const section = (title, items) => {
    if (items.length === 0) return `\n## ${title}（0）\n（无）\n`;
    const shown = items.slice(0, LIST_LIMIT).map(itemLine).join('\n');
    const more = items.length > LIST_LIMIT ? `\n… 共 ${items.length} 条，仅显示 ${LIST_LIMIT} 条` : '';
    return `\n## ${title}（${items.length}）\n${shown}${more}\n`;
  };
  const header = `禅道「指派给我」@ ${snapshot.fetchedAt}\n服务器：${snapshot.profile.server}　账号：${snapshot.profile.account}\n`;
  return `${header}${section('任务', snapshot.tasks)}${section('Bug', snapshot.bugs)}${section('需求', snapshot.stories)}`;
}

/** 渲染单条详情为模型可读 Markdown。 */
function formatDetail(kind, detail) {
  const label = { task: '任务', bug: 'Bug', story: '需求' }[kind] ?? kind;
  const lines = [
    `禅道${label} #${detail.id}`,
    `标题：${detail.title}`,
    `状态：${detail.statusLabel || detail.status}${detail.status !== '' && detail.statusLabel !== detail.status ? `（${detail.status}）` : ''}`,
  ];
  if (detail.assignedTo !== '' || detail.assignedToName !== '') lines.push(`指派给：${detail.assignedToName || detail.assignedTo}`);
  if (detail.openedBy !== '' || detail.openedByName !== '') lines.push(`创建人：${detail.openedByName || detail.openedBy}`);
  const story = detail.story ?? {};
  if (asString(story.id) !== '') {
    const storyStatus = asString(story.statusLabel) === '' ? '' : `（${story.statusLabel}）`;
    lines.push(`研发需求：#${story.id} ${asString(story.title)}${storyStatus}`);
  }
  if (detail.deadline !== '') lines.push(`截止：${detail.deadline}`);
  if (detail.fromBug !== '') lines.push(`来源 Bug：#${detail.fromBug}`);
  for (const row of Array.isArray(detail.meta) ? detail.meta : []) lines.push(`${row.label}：${row.value}`);
  const sections = Array.isArray(detail.sections) ? detail.sections : [];
  if (sections.length > 0) {
    for (const section of sections) lines.push(`\n${section.label}：\n${section.text}`);
  } else if (detail.description !== '') {
    lines.push(`\n描述/重现步骤：\n${detail.description}`);
  }
  const attachments = Array.isArray(detail.attachments) ? detail.attachments : [];
  if (attachments.length > 0) {
    lines.push('\n附件：');
    for (const file of attachments) lines.push(`- ${file.name}：${file.url}`);
  }
  if (detail.verify !== '' && !sections.some((section) => section.label === '验收标准')) {
    lines.push(`\n验收标准：\n${detail.verify}`);
  }
  if (detail.actions.length > 0) {
    lines.push('\n历史动作：');
    for (const action of detail.actions) {
      const comment = action.comment === '' ? '' : ` — ${action.comment}`;
      const name = action.actionLabel === undefined || action.actionLabel === '' ? action.action : action.actionLabel;
      lines.push(`- ${action.date} ${action.actor} ${name}${comment}`);
    }
  }
  lines.push(`\n原始链接：${detail.link}`);
  return lines.join('\n');
}

/** 截断过长的工具输出。 */
function clampText(text) {
  if (text.length <= TOOL_TEXT_LIMIT) return text;
  return `${text.slice(0, TOOL_TEXT_LIMIT)}\n…（已截断，共 ${text.length} 字符）`;
}

/** 以固定并发度跑完整批任务并保持顺序。 */
async function mapWithLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runOne = async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  };
  const runners = [];
  const count = Math.min(Math.max(limit, 1), items.length);
  for (let i = 0; i < count; i += 1) runners.push(runOne());
  await Promise.all(runners);
  return results;
}

/** 合并外部信号与本地超时信号。 */
function withTimeout(signal) {
  if (typeof AbortSignal.timeout !== 'function') return signal;
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout].filter(Boolean)) : timeout;
}

// ---------------------------------------------------------------------------
// 禅道客户端
// ---------------------------------------------------------------------------

/**
 * 把禅道的错误响应体提炼成一句人话。
 * 实测本实例的形态：`{"error":"登录失败，请检查您的用户名或密码是否填写正确。"}`、
 * 缺 Token 时 HTTP 401 `{"error":"Unauthorized"}`；也兼容 `{error:{message}}`、
 * `{message}` 与 `{status:"fail", message}`。
 * @param {unknown} data - 响应体。
 * @param {number} status - HTTP 状态码。
 * @param {string} path - 请求路径，用于兜底文案。
 */
function describeFailure(data, status, path) {
  const row = asObject(data);
  const raw = row?.error;
  const nested = asObject(raw)?.message;
  const message =
    (typeof raw === 'string' ? raw.trim() : '') ||
    asString(nested) ||
    businessFailure(data) ||
    asString(row?.message) ||
    '';
  if (status === 401 || status === 403) {
    return message === '' || message === 'Unauthorized'
      ? '登录状态已失效或无权访问（HTTP 401/403），请重新登录。'
      : `登录状态已失效或无权访问（HTTP ${status}）：${message}`;
  }
  return message === '' ? `HTTP ${status}` : message;
}

/**
 * 发一次禅道 REST 请求。
 * @param {object} profile - `{ server, token }`。
 * @param {string} path - 相对 `api.php/v1` 的路径（可带查询串）。
 * @param {object} [options] - `{ method, body, signal }`。
 * @returns {Promise<unknown>} 解析后的 JSON。
 */
async function zentaoFetch(profile, path, options = {}) {
  const url = `${apiBase(profile.server)}/${path.replace(/^\/+/, '')}`;
  const headers = { Accept: 'application/json' };
  if (profile.token !== '') headers.Token = profile.token;
  let body;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json; charset=utf-8';
    body = JSON.stringify(options.body);
  }
  let response;
  try {
    response = await fetch(url, {
      method: options.method ?? 'GET',
      headers,
      body,
      signal: withTimeout(options.signal),
      redirect: 'follow',
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`禅道请求失败（${url}）：${reason}`);
  }
  const text = await response.text();
  let data;
  try {
    data = text === '' ? {} : JSON.parse(text);
  } catch {
    throw new Error(`禅道返回了非 JSON 内容（HTTP ${response.status}）：${text.slice(0, 300)}`);
  }
  if (!response.ok) {
    throw new Error(`禅道接口报错（${path}）：${describeFailure(data, response.status, path)}`);
  }
  const failed = businessFailure(data);
  if (failed !== '') throw new Error(`禅道接口报错（${path}）：${failed}`);
  return data;
}

/** 登录换取 token，并校验 token 可用。 */
async function doLogin(payload, signal) {
  const server = normalizeServer(payload.server);
  if (server === '') throw new Error('服务器地址格式不正确');
  const account = asString(payload.account).trim();
  if (account === '') throw new Error('账号不能为空');
  let token = asString(payload.token).trim();
  const password = asString(payload.password);
  if (token === '') {
    if (password === '') throw new Error('需要提供密码或 Token');
    const data = await zentaoFetch({ server, token: '' }, 'tokens', {
      method: 'POST',
      body: { account, password },
      signal,
    });
    token = asString(asObject(data)?.token);
    if (token === '') throw new Error('登录失败：响应里没有 token');
  }
  const user = await zentaoFetch({ server, token }, 'user', { signal });
  const row = pickOne(user, 'user');
  return {
    server,
    account: asString(row.account) || account,
    realname: asString(row.realname),
    token,
    user: row,
  };
}

/**
 * 拉取当前账号的任务列表。
 * 注意：当前实例 `page` 参数表现为「每页数量」，不传只返回 1 条。
 */
async function fetchTasks(profile, signal) {
  const data = await zentaoFetch(profile, `tasks?page=${LIST_LIMIT}`, { signal });
  return pickList(data, 'tasks').map((row) => normalizeItem('task', row));
}

/** 拉取产品列表。 */
async function fetchProducts(profile, signal) {
  const data = await zentaoFetch(profile, 'products?limit=100', { signal });
  return pickList(data, 'products').map((row) => ({
    id: row?.id === undefined ? '' : String(row.id),
    name: asString(row?.name) || '（未命名产品）',
  }));
}

/**
 * 按产品维度聚合「指派给我」的 Bug 或需求。
 * 禅道 v1 没有全局 `/bugs`、`/stories`（按账号）入口，只能逐产品取再按 assignedTo 过滤。
 * @param {object} profile - `{ server, token, account }`。
 * @param {'bug'|'story'} kind - 条目类型。
 */
async function fetchMineByProduct(profile, kind, signal) {
  const products = await fetchProducts(profile, signal);
  const picked = products.slice(0, MAX_PRODUCTS);
  const key = kind === 'bug' ? 'bugs' : 'stories';
  const buckets = await mapWithLimit(picked, CONCURRENCY, async (product) => {
    try {
      const data = await zentaoFetch(profile, `products/${product.id}/${key}?limit=100`, { signal });
      return pickList(data, key).map((row) => normalizeItem(kind, row));
    } catch {
      // 单个产品取不到（权限/字段差异）不应让整次刷新失败。
      return [];
    }
  });
  const seen = new Set();
  const out = [];
  for (const list of buckets) {
    for (const item of list) {
      if (item.assignedTo !== '' && item.assignedTo !== profile.account) continue;
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
    }
  }
  return { items: out, scannedProducts: picked.length, totalProducts: products.length };
}

/** 读取单条详情。 */
async function fetchDetail(profile, kind, id, signal) {
  const singular = kind === 'task' ? 'task' : kind === 'bug' ? 'bug' : 'story';
  const plural = kind === 'task' ? 'tasks' : kind === 'bug' ? 'bugs' : 'stories';
  const data = await zentaoFetch(profile, `${plural}/${encodeURIComponent(id)}`, { signal });
  const detail = normalizeDetail(kind, pickEntity(data, singular, plural), profile.server);
  detail.link = webLink(profile.server, kind, id);
  return detail;
}

// ---------------------------------------------------------------------------
// AI 预判：这条禅道条目是 Bug、优化还是需求
// ---------------------------------------------------------------------------
// 走 DSH 自带的 llm 服务。取服务的写法是 `ctx.reflect.get('llm')`：
// cordis 的 `reflect.get(name)`（见 @deepseek-ai/cordis 的 ReflectService，注释原文
// 「Read a service from the store without the inject requirement」）**不需要写进 inject**，
// 服务缺失时返回 undefined —— 所以模型服务不存在也不会拖累插件加载。
//
// 依然**不 import 任何 @deepseek-ai/* 包**（本地 link 安装解析不到）：
//   - 消息用请求期允许的裸对象形态（`{id, role, source, content}`，与 createUserMessage 同形）；
//   - 分片按 llm 的 StreamChunk 协议自行拼接（`text-delta` 取文本，`finish` 取结束原因）。

const ANALYZE_TIMEOUT_MS = 60000;
const ANALYZE_MAX_TOKENS = 900;
const ANALYZE_INPUT_LIMIT = 6000;

/** 预判类别与中文名（与提示词里的分类口径一致）。 */
const CATEGORY_LABEL = {
  bug: 'Bug 修复',
  optimize: '体验或性能优化',
  feature: '新增需求',
  other: '其它',
};

const KIND_LABEL = { task: '任务', bug: 'Bug', story: '需求' };

const ANALYZE_SYSTEM = [
  '你是资深研发助理。请阅读给出的禅道条目，判断它属于哪一类，并给出可执行的处理建议。',
  '只输出一个 JSON 对象，不要输出任何解释文字，也不要用 Markdown 代码块围栏。字段如下：',
  '{"category":"bug|optimize|feature|other","confidence":0到100的整数,'
    + '"headline":"一句话说清这条要做什么，不超过40字","reason":"分类依据，不超过120字",'
    + '"steps":["建议步骤，2到5条，每条不超过60字"],"questions":["需要向提出人确认的问题，0到3条"]}',
  '分类口径：bug=功能与预期不符、报错、崩溃、数据错误；optimize=功能可用但慢/卡/体验差/结果不准；'
    + 'feature=新增能力或改变现有行为的需求；other=咨询、文档、环境等其它情况。',
  '判断依据优先看标题、正文（描述 / 重现步骤 / 研发需求 / 验收标准）与字段（对象类型、严重程度、优先级）。'
    + '证据不足时选最接近的一类，并把需要确认的信息放进 questions。',
].join('\n');

/**
 * 取 llm 服务；当前实例没有暴露模型服务时返回 null（不抛错）。
 * @param {object} ctx - 插件上下文。
 */
function llmService(ctx) {
  try {
    const service = ctx?.reflect?.get?.('llm');
    return service !== null && typeof service === 'object' && typeof service.stream === 'function' ? service : null;
  } catch {
    return null;
  }
}

/** 解析 `provider/model` 形式的环境变量覆盖，非法时返回 null。 */
function parseRouteOverride(raw) {
  const text = asString(raw);
  const index = text.indexOf('/');
  if (index <= 0 || index === text.length - 1) return null;
  return { provider: text.slice(0, index), model: text.slice(index + 1) };
}

/**
 * 挑一条可用的调用路由：优先名字里带 flash/mini/small/lite 的便宜模型。
 * 可用 `DSH_ZENTAO_WORKBENCH_LLM=provider/model` 显式指定。
 */
async function resolveLlmRoute(llm, signal) {
  const override = parseRouteOverride(process.env.DSH_ZENTAO_WORKBENCH_LLM);
  if (override !== null) return { ...override, source: 'env' };
  let providers = [];
  try {
    providers = await llm.listProviders();
  } catch {
    providers = [];
  }
  const ids = (Array.isArray(providers) ? providers : [])
    .map((entry) => asString(asObject(entry)?.id))
    .filter((entry) => entry !== '');
  for (const provider of ids) {
    let models = [];
    try {
      models = await llm.listModels(provider);
    } catch {
      continue;
    }
    const rows = (Array.isArray(models) ? models : [])
      .map((entry) => ({ id: asString(asObject(entry)?.id) }))
      .filter((row) => row.id !== '');
    if (rows.length === 0) continue;
    const pick = rows.find((row) => /flash|mini|small|lite|fast/i.test(row.id)) ?? rows[0];
    return { provider, model: pick.id, source: 'auto' };
  }
  throw new RequestError(
    '当前 DSH 实例没有可用的模型提供方（llm 服务里没有已注册路由），请先配置模型再试。',
    'llm-unavailable',
  );
}

/** 把详情压成给模型看的纯文本。 */
function analysisInput(kind, detail) {
  const lines = [
    `对象类型：${KIND_LABEL[kind] ?? kind}`,
    `编号：${detail.id}`,
    `标题：${detail.title}`,
  ];
  const meta = (Array.isArray(detail.meta) ? detail.meta : [])
    .map((row) => `${asString(asObject(row)?.label)}：${asString(asObject(row)?.value)}`)
    .filter((row) => !row.startsWith('：'));
  if (meta.length > 0) lines.push(`字段：${meta.join('；')}`);
  if (detail.statusLabel !== '') lines.push(`状态：${detail.statusLabel}`);
  if (detail.assignedToName !== '') lines.push(`指派给：${detail.assignedToName}`);
  const story = asObject(detail.story);
  if (asString(story?.title) !== '') lines.push(`所属研发需求：#${asString(story?.id)} ${asString(story?.title)}`);
  if (detail.description !== '') lines.push('', '正文：', clampText(detail.description, ANALYZE_INPUT_LIMIT));
  const files = (Array.isArray(detail.attachments) ? detail.attachments : [])
    .map((file) => asString(asObject(file)?.name))
    .filter((name) => name !== '');
  if (files.length > 0) lines.push('', `附件：${files.join('、')}`);
  return lines.join('\n');
}

/** 从模型输出里抠出第一个完整 JSON 对象（容忍前后废话与 ``` 围栏）。 */
function extractJsonObject(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

/** 校验并规整模型返回的 JSON。 */
function normalizeAnalysis(raw) {
  const row = asObject(raw);
  if (row === undefined) return null;
  const category = asString(row.category).toLowerCase();
  const confidenceRaw = Number(row.confidence);
  const texts = (value, limit, length) =>
    (Array.isArray(value) ? value : [])
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter((entry) => entry !== '')
      .slice(0, limit)
      .map((entry) => clampText(entry, length));
  return {
    category: Object.hasOwn(CATEGORY_LABEL, category) ? category : 'other',
    confidence: Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(100, Math.round(confidenceRaw))) : null,
    headline: clampText(asString(row.headline), 80),
    reason: clampText(asString(row.reason), 300),
    steps: texts(row.steps, 5, 160),
    questions: texts(row.questions, 3, 160),
  };
}

/** 解析模型输出；失败返回 null。 */
function parseAnalysis(text) {
  const json = extractJsonObject(text);
  if (json === null) return null;
  try {
    return normalizeAnalysis(JSON.parse(json));
  } catch {
    return null;
  }
}

/**
 * 让模型先判一次类别，再给出建议。
 * @param {object} ctx - 插件上下文。
 * @param {string} kind - task / bug / story。
 * @param {object} detail - `fetchDetail` 的返回值。
 * @param {AbortSignal} [signal] - 外部取消信号。
 */
async function analyzeItem(ctx, kind, detail, signal) {
  const llm = llmService(ctx);
  if (llm === null) {
    throw new RequestError(
      '当前 DSH 实例没有暴露模型服务（读不到 ctx.llm），没法做 AI 预判；请确认 profile 里加载了模型提供方。',
      'llm-unavailable',
    );
  }
  const route = await resolveLlmRoute(llm, signal);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ANALYZE_TIMEOUT_MS);
  const composite =
    typeof AbortSignal.any === 'function'
      ? AbortSignal.any([signal, controller.signal].filter(Boolean))
      : controller.signal;
  let text = '';
  let finish = null;
  try {
    const userText = `请判断下面这条禅道条目的类型并给出处理建议：\n\n${analysisInput(kind, detail)}`;
    const stream = llm.stream({
      provider: route.provider,
      model: route.model,
      system: ANALYZE_SYSTEM,
      maxTokens: ANALYZE_MAX_TOKENS,
      messages: [
        {
          id: randomUUID(),
          role: 'user',
          source: { kind: 'dsh-zentao-workbench' },
          content: [{ type: 'text', text: userText }],
        },
      ],
      signal: composite,
    });
    for await (const chunk of stream) {
      const row = asObject(chunk);
      if (row === undefined) continue;
      if (row.type === 'text-delta' && typeof row.text === 'string') text += row.text;
      else if (row.type === 'finish') finish = asObject(row.reason) ?? {};
    }
  } catch (error) {
    throw new RequestError(
      `调用模型失败：${error instanceof Error ? error.message : String(error)}`,
      'llm-failed',
    );
  } finally {
    clearTimeout(timer);
  }
  const reason = finish ?? {};
  const kindOfFinish = asString(reason.kind) || 'stop';
  if (kindOfFinish === 'aborted') throw new RequestError('AI 预判被取消或超时。', 'llm-aborted');
  if (kindOfFinish !== 'stop') {
    const failure = asObject(reason.failure);
    const detailText =
      [asString(failure?.code), asString(failure?.message)].filter((part) => part !== '').join('：') || kindOfFinish;
    throw new RequestError(`模型调用未正常结束（${kindOfFinish}）：${detailText}`, 'llm-failed');
  }
  const parsed = parseAnalysis(text);
  if (parsed === null) {
    throw new RequestError(
      `模型没有按要求返回 JSON，原始输出：${clampText(text, 300) || '（空）'}`,
      'llm-parse',
    );
  }
  return {
    kind,
    id: detail.id,
    title: detail.title,
    ...parsed,
    categoryLabel: CATEGORY_LABEL[parsed.category],
    provider: route.provider,
    model: route.model,
    routeSource: route.source,
    analyzedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 插件装配
// ---------------------------------------------------------------------------

/** 今天（YYYY-MM-DD）：禅道日期字段用的格式。 */
function today() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * 把任务置为「开始」（doing）。
 *
 * 实测：禅道 REST v1 里 `POST tasks/{id}/start` 是存在的（对照 `POST tasks/{id}/assignTo`
 * 与 `tasks/{id}/nosuchaction` 都返回 404 `{"error":"not found"}`，start 返回 200），
 * 但它**永远返回 200 + 空响应体**，看不出成败，所以这里改完再回读一次任务确认状态。
 *
 * 只对 `wait` 的任务动手：已经是 `doing` 的跳过，其它状态（done / closed / pause …）
 * 不冒险改，直接返回说明让界面提示。
 */
async function startTask(profile, id, signal) {
  const path = `tasks/${encodeURIComponent(id)}`;
  const before = await zentaoFetch(profile, path, { signal });
  const current = pickEntity(before, 'task', 'tasks');
  const previousStatus = asString(current.status) || 'unknown';
  const label = (status) => statusLabel('task', status);
  if (previousStatus === 'doing') {
    return { changed: false, previousStatus, status: previousStatus, statusLabel: label(previousStatus), note: '任务已经是进行中，无需再开始' };
  }
  if (previousStatus !== 'wait') {
    return {
      changed: false,
      previousStatus,
      status: previousStatus,
      statusLabel: label(previousStatus),
      note: `任务当前是「${label(previousStatus)}」，只有未开始的任务能置为开始`,
    };
  }
  // 带上任务自己的工时数字，避免禅道把已消耗 / 预计剩余按空值当成 0 写回去。
  const payload = { realStarted: today() };
  const consumed = Number(current.consumed);
  if (Number.isFinite(consumed)) payload.consumed = consumed;
  const left = Number(current.left);
  if (Number.isFinite(left)) payload.left = left;
  await zentaoFetch(profile, `${path}/start`, { method: 'POST', body: payload, signal });

  const after = await zentaoFetch(profile, path, { signal });
  const updated = pickEntity(after, 'task', 'tasks');
  const status = asString(updated.status) || previousStatus;
  const changed = status !== previousStatus;
  return {
    changed,
    previousStatus,
    status,
    statusLabel: label(status),
    note: changed ? '' : '禅道没有改变任务状态（可能是权限或状态不允许）',
  };
}

/**
 * 拉取可指派用户列表。
 *
 * 实测：`GET users?limit=100` → `{page,total,limit,users:[{id,dept,account,realname,role,pinyin,email}]}`
 * （当前实例 70 人；注意这里 `limit` 是有效的，与 `tasks` 的 `page` 语义不同）。
 */
async function fetchUsers(profile, signal) {
  const data = await zentaoFetch(profile, 'users?limit=100', { signal });
  const seen = new Set();
  const users = [];
  for (const row of pickList(data, 'users')) {
    const account = accountOf(row?.account);
    if (account === '' || seen.has(account)) continue;
    seen.add(account);
    users.push({ account, realname: asString(row?.realname) || account });
  }
  users.sort((left, right) => left.realname.localeCompare(right.realname, 'zh-Hans-CN'));
  return { users, total: users.length, self: profile.account };
}

/**
 * 完成任务并登记本次耗时。
 *
 * 实测（全部打在不存在的 id 上，零副作用）：`POST tasks/{id}/finish` 的必填字段是
 * `realStarted`（实际开始）与 `finishedDate`（实际完成）——少 `realStarted` 报
 * `400 {"error":"『实际开始』不能为空。"}`，缺 `finishedDate` 报
 * `400 {"error":"『实际完成』不能为空。"}`；字段齐全时返回 **200 + 空响应体**，
 * 同样看不出成败，所以写完必须回读任务状态与工时。`currentConsumed` 是本次耗时，
 * `consumed` 是累计耗时（这里按「原累计 + 本次」提交）。
 *
 * @param {object} profile - `{ server, token, account }`。
 * @param {string} id - 任务 id。
 * @param {number} hours - 本次耗时（小时，≥ 0）。
 * @param {unknown} comment - 可选备注。
 */
async function finishTask(profile, id, hours, comment, signal) {
  const path = `tasks/${encodeURIComponent(id)}`;
  const before = await zentaoFetch(profile, path, { signal });
  const current = pickEntity(before, 'task', 'tasks');
  const previousStatus = asString(current.status) || 'unknown';
  const label = (status) => statusLabel('task', status);
  const previousConsumed = Number(current.consumed);
  const consumedBase = Number.isFinite(previousConsumed) ? previousConsumed : 0;
  const previousLeft = Number(current.left);
  const leftBase = Number.isFinite(previousLeft) ? previousLeft : 0;
  if (previousStatus === 'done' || previousStatus === 'closed') {
    return {
      changed: false,
      previousStatus,
      status: previousStatus,
      statusLabel: label(previousStatus),
      consumed: consumedBase,
      left: leftBase,
      finishedDate: asString(current.finishedDate).slice(0, 10),
      note: `任务已经是「${label(previousStatus)}」，无需再完成`,
    };
  }
  const payload = {
    realStarted: asString(current.realStarted).slice(0, 10) || today(),
    finishedDate: today(),
    currentConsumed: hours,
    consumed: consumedBase + hours,
  };
  if (asString(comment) !== '') payload.comment = asString(comment);
  await zentaoFetch(profile, `${path}/finish`, { method: 'POST', body: payload, signal });

  const after = await zentaoFetch(profile, path, { signal });
  const updated = pickEntity(after, 'task', 'tasks');
  const status = asString(updated.status) || previousStatus;
  const changed = status !== previousStatus;
  const consumedAfter = Number(updated.consumed);
  const leftAfter = Number(updated.left);
  return {
    changed,
    previousStatus,
    status,
    statusLabel: label(status),
    consumed: Number.isFinite(consumedAfter) ? consumedAfter : consumedBase,
    left: Number.isFinite(leftAfter) ? leftAfter : leftBase,
    finishedDate: asString(updated.finishedDate).slice(0, 10),
    note: changed ? '' : '禅道没有改变任务状态（可能是权限、状态不允许或耗时未填对）',
  };
}

/**
 * 把任务指派给别人。
 *
 * 实测（在一条真实旧任务上换成测试账号再立刻换回，零数据损伤）：
 * - 禅道 REST v1 **唯一可用**的指派方式是 `PUT tasks/{id}` body `{"assignedTo":"账号"}`；
 *   `POST tasks/{id}/assign`、`/assignTo`、`/team` 全是 404 `{"error":"not found"}`。
 * - PUT 成功时**返回更新后的完整任务对象**（不是空体），可直接当回读结果；其它字段
 *   （name / estimate / consumed / left / status）保持不变。
 * - 副作用：禅道把「指派给一个未开始的任务」视为开始，`wait` 的任务会变成 `doing`，
 *   所以返回值里带 `statusChanged`，界面必须提示这一点。
 *
 * @param {object} profile - `{ server, token, account }`。
 * @param {string} id - 任务 id。
 * @param {string} account - 目标账号。
 */
async function assignTask(profile, id, account, signal) {
  const target = asString(account);
  const path = `tasks/${encodeURIComponent(id)}`;
  const before = await zentaoFetch(profile, path, { signal });
  const current = pickEntity(before, 'task', 'tasks');
  const previousAccount = accountOf(current.assignedTo);
  const previousName = asString(current.assignedToRealName) || personName(current.assignedTo) || '（未指派）';
  const previousStatus = asString(current.status) || 'unknown';
  const shape = (row) => {
    const rowAccount = accountOf(row.assignedTo);
    const status = asString(row.status) || previousStatus;
    return {
      previousAccount,
      previousName,
      account: rowAccount,
      realname: asString(row.assignedToRealName) || personName(row.assignedTo) || rowAccount,
      status,
      statusLabel: statusLabel('task', status),
      statusChanged: status !== previousStatus,
    };
  };
  if (previousAccount === target) {
    return { ...shape(current), changed: false, note: `任务已经指派给「${previousName}」` };
  }
  const result = await zentaoFetch(profile, path, { method: 'PUT', body: { assignedTo: target }, signal });
  const updated = pickEntity(result, 'task', 'tasks');
  const row =
    Object.keys(asObject(updated) ?? {}).length > 0
      ? updated
      : pickEntity(await zentaoFetch(profile, path, { signal }), 'task', 'tasks');
  const info = shape(row);
  const changed = info.account === target;
  return { ...info, changed, note: changed ? '' : '禅道没有改变指派人（可能是权限不足或账号不存在）' };
}

/** 构造一次 RPC 失败信封。 */
function failure(message, code = 'internal') {
  return { ok: false, error: { code, message, details: {} } };
}

/** 构造一次 RPC 成功信封。 */
function success(value) {
  return { ok: true, value };
}

/**
 * 装载禅道工作台：读配置、挂 RPC 通道、注册 zentao 工具。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 宿主上下文。
 */
/** RPC 请求体上限（字节）。 */
const MAX_REQUEST_BYTES = 64 * 1024;

/**
 * 同源校验：本路由直接挂在 webServer 上，拿不到 connection 的 admission 检查，
 * 所以自己挡一下跨站发起的 POST（带 Origin 时必须与 Host 一致；
 * 带 Sec-Fetch-Site 时只接受 same-origin / none）。
 */
function isSameOriginRequest(req) {
  const origin = asString(req.headers?.origin);
  if (origin !== '') {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      return false;
    }
    const host = asString(req.headers?.host);
    if (host === '' || parsed.host !== host) return false;
  }
  const site = asString(req.headers?.['sec-fetch-site']);
  if (site !== '' && site !== 'same-origin' && site !== 'none') return false;
  return true;
}

/** 读取请求体（带上限），返回 utf8 字符串。 */
function readRequestBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error(`请求体超过 ${limit} 字节上限`));
        req.destroy?.();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', (error) => reject(error));
  });
}

/** 附件代理允许的路径特征（禅道的文件下载入口 / 上传目录）。 */
const ATTACHMENT_PATH_PATTERN = /(file-read-|file-download-|\/file\/|\/data\/upload\/|filedownload)/i;

/** 代理附件的体积上限（超过就直接放弃，避免把大文件读进内存）。 */
const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;

/** 按扩展名猜 content-type（禅道下载响应不一定带）。 */
const MIME_BY_EXTENSION = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  txt: 'text/plain; charset=utf-8',
  log: 'text/plain; charset=utf-8',
  zip: 'application/zip',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

function mimeForUrl(url) {
  const match = /\.([a-z0-9]+)(?:$|\?)/i.exec(url);
  if (match === null) return '';
  return MIME_BY_EXTENSION[match[1].toLowerCase()] ?? '';
}

/**
 * 「用电脑默认程序打开」允许的扩展名。
 *
 * 这里用**白名单**而不是黑名单：文件是从禅道下载到本机再交给系统打开的，等于让它在本机被执行
 * （Windows 上 `.exe` / `.bat` / `.lnk` 都会被直接运行），所以只放行「打开即查看」的文档、图片、
 * 音视频与压缩包；表里没有的一律拒绝。
 */
const OPENABLE_EXTENSIONS = new Set([
  // 文档 / 表格 / 演示（含 WPS 系）
  'doc', 'docx', 'docm', 'dot', 'dotx', 'rtf', 'odt', 'txt', 'csv', 'md',
  'xls', 'xlsx', 'xlsm', 'xlsb', 'ods', 'et',
  'ppt', 'pptx', 'pps', 'ppsx', 'odp', 'dps', 'wps', 'wpt',
  // 便于「下载下来再看」的二进制资料
  'pdf', 'zip', 'rar', '7z', 'tar', 'gz',
  // 图片 / 音视频（界面上有内置预览，这里只是允许「用默认程序打开」这条路）
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg',
  'mp4', 'm4v', 'mov', 'avi', 'mkv', 'webm', 'mp3', 'wav',
]);

/** 下载来的附件暂存目录（交给系统打开的文件就落在这里）。 */
const OPEN_DIR =
  asString(process.env.DSH_ZENTAO_WORKBENCH_OPEN_DIR) || join(tmpdir(), 'dsh-zentao-workbench');

/**
 * 用系统默认程序打开哪个命令；留空时按平台自动选。
 * 覆盖它主要是为了在 Linux/macOS 或离线测试里换个 opener。
 */
const OPENER = asString(process.env.DSH_ZENTAO_WORKBENCH_OPENER);

/** 带错误码的业务错误：让 RPC 信封能回 `forbidden` / `bad-request`，而不是一律 `internal`。 */
class RequestError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'RequestError';
    this.code = code;
  }
}

/** 从附件名（优先）或地址里取扩展名。 */
function extensionOfTarget(url, name) {
  const pick = (text) => {
    const match = /\.([a-z0-9]{1,8})(?:$|[?#])/i.exec(asString(text));
    return match === null ? '' : match[1].toLowerCase();
  };
  return pick(basename(asString(url).split('?')[0])) || pick(name);
}

/** 把附件名洗成安全的落盘文件名（去掉路径分隔符与控制字符，避免目录穿越/奇怪字符）。 */
function safeFileName(name, extension) {
  const cleaned = asString(name)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  const base = cleaned === '' ? `attachment.${extension}` : cleaned;
  const withExtension = base.toLowerCase().endsWith(`.${extension}`) ? base : `${base}.${extension}`;
  const clipped = withExtension.length > 120 ? `${withExtension.slice(0, 96)}.${extension}` : withExtension;
  // 加时间戳便于区分同名附件，也避开「上一个还开在 Word 里」的文件锁。
  return `${Date.now()}-${clipped}`;
}

/**
 * 用系统默认程序打开一个本机文件（不等待、不接管道，避免拖住宿主进程）。
 * @param {string} filePath - 已落盘的文件绝对路径。
 */
export function openWithDefaultApp(filePath) {
  const options = { detached: true, stdio: 'ignore', windowsHide: true };
  let child;
  if (OPENER !== '') child = spawn(OPENER, [filePath], options);
  else if (process.platform === 'win32') child = spawn('cmd.exe', ['/c', 'start', '', filePath], options);
  else if (process.platform === 'darwin') child = spawn('open', [filePath], options);
  else child = spawn('xdg-open', [filePath], options);
  // 打不开（比如没装对应程序）不该让宿主崩掉；调用方已经拿到「已下载」的结果。
  child.on('error', () => {});
  child.unref();
  return child;
}

/**
 * 下载一个禅道附件到本机临时目录，再交给系统默认程序打开。
 *
 * 与附件代理同一套地址校验（必须与配置的禅道同源、路径像附件），另外多一道扩展名白名单：
 * 只有 `OPENABLE_EXTENSIONS` 里的类型才会落盘并被打开。
 *
 * @param {{server: string, token: string}} profile - 已登录的禅道配置。
 * @param {string} target - 禅道附件地址。
 * @param {string} [name] - 附件显示名（用于猜扩展名与落盘文件名）。
 * @param {AbortSignal} [signal] - 请求信号。
 */
async function openAttachment(profile, target, name, signal) {
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    throw new RequestError('附件地址不是合法地址', 'bad-request');
  }
  let allowedOrigin;
  try {
    allowedOrigin = new URL(profile.server).origin;
  } catch {
    throw new RequestError('已保存的服务器地址不合法', 'internal');
  }
  if (parsed.origin !== allowedOrigin || !ATTACHMENT_PATH_PATTERN.test(parsed.pathname)) {
    throw new RequestError('只允许打开当前禅道服务器提供的附件', 'forbidden');
  }
  const extension = extensionOfTarget(parsed.pathname, name);
  if (extension === '') throw new RequestError('这个附件没有扩展名，无法判断类型（为安全起见不打开）', 'bad-request');
  if (!OPENABLE_EXTENSIONS.has(extension)) {
    throw new RequestError(`出于安全考虑，不支持用默认程序打开 .${extension} 附件`, 'forbidden');
  }
  let response;
  try {
    response = await fetch(parsed.toString(), {
      headers: { Token: profile.token, Accept: '*/*' },
      signal: withTimeout(signal),
      redirect: 'follow',
    });
  } catch (error) {
    throw new RequestError(`附件下载失败：${error instanceof Error ? error.message : String(error)}`, 'internal');
  }
  if (!response.ok) throw new RequestError(`附件下载失败（HTTP ${response.status}）`, 'internal');
  const length = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(length) && length > MAX_ATTACHMENT_BYTES) {
    throw new RequestError(`附件超过 ${MAX_ATTACHMENT_BYTES} 字节上限`, 'payload-too-large');
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_ATTACHMENT_BYTES) {
    throw new RequestError(`附件超过 ${MAX_ATTACHMENT_BYTES} 字节上限`, 'payload-too-large');
  }
  mkdirSync(OPEN_DIR, { recursive: true });
  const savedPath = join(OPEN_DIR, safeFileName(name || basename(parsed.pathname), extension));
  writeFileSync(savedPath, buffer);
  openWithDefaultApp(savedPath);
  return {
    opened: true,
    name: asString(name) || basename(parsed.pathname),
    savedPath,
    size: buffer.length,
    extension,
  };
}

/**
 * 解析 `Range: bytes=…` 请求头（只支持单段，够 `<video>` 拖进度条用）。
 *
 * 返回 `null` 表示范围不合法 → 调用方回 416；`partial: false` 表示按整份返回 200。
 *
 * @param {unknown} header - 原始 `Range` 头。
 * @param {number} total - 已缓冲的字节数。
 * @returns {{ start: number, end: number, partial: boolean } | null}
 */
export function parseByteRange(header, total) {
  const text = asString(header).trim();
  if (text === '') return { start: 0, end: total - 1, partial: false };
  const unit = /^bytes=(.*)$/i.exec(text);
  if (unit === null) return { start: 0, end: total - 1, partial: false };
  const spec = unit[1].split(',')[0].trim();
  const match = /^(\d*)-(\d*)$/.exec(spec);
  if (match === null || (match[1] === '' && match[2] === '')) return null;
  if (total <= 0) return null;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    return { start: Math.max(total - suffix, 0), end: total - 1, partial: true };
  }
  const start = Number(match[1]);
  const end = match[2] === '' ? total - 1 : Number(match[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) return null;
  return { start, end: Math.min(end, total - 1), partial: true };
}

export function apply(ctx) {
  const state = {
    server: '',
    account: '',
    realname: '',
    token: '',
    role: 'dev',
    /** 用户是否选择把 token 落盘。 */
    rememberToken: false,
  };

  // ---- 配置载入 -----------------------------------------------------------
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    state.server = asString(raw.server);
    state.account = asString(raw.account);
    state.role = asString(raw.role) || 'dev';
    state.rememberToken = raw.rememberToken === true;
    state.token = state.rememberToken ? asString(raw.token) : '';
  } catch {
    // 首次运行没有配置文件：保持空白状态。
  }

  const persist = () => {
    try {
      writeFileSync(
        CONFIG_PATH,
        JSON.stringify(
          {
            server: state.server,
            account: state.account,
            role: state.role,
            rememberToken: state.rememberToken,
            token: state.rememberToken ? state.token : '',
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
    } catch {
      // 落盘失败不影响本次会话。
    }
  };

  /** 当前登录态（绝不外泄 token）。 */
  const profileInfo = () => ({
    server: state.server,
    account: state.account,
    realname: state.realname,
    role: state.role,
    hasToken: state.token !== '',
    rememberToken: state.rememberToken,
  });

  const requireLogin = () => {
    if (state.token === '' || state.server === '') {
      throw new Error('未登录禅道。请先在工作台浮层登录（服务器 / 账号 / 密码或 Token）。');
    }
    return { server: state.server, token: state.token, account: state.account };
  };

  /** 刷新「指派给我」：任务全量，Bug/需求按产品聚合。 */
  const refresh = async (signal, scope) => {
    const profile = requireLogin();
    const wantAll = scope !== 'tasks';
    const tasks = await fetchTasks(profile, signal);
    let bugs = [];
    let stories = [];
    let scan = null;
    if (wantAll) {
      const bugResult = await fetchMineByProduct(profile, 'bug', signal);
      bugs = bugResult.items;
      scan = { scannedProducts: bugResult.scannedProducts, totalProducts: bugResult.totalProducts };
      const storyResult = await fetchMineByProduct(profile, 'story', signal);
      stories = storyResult.items;
    }
    return {
      fetchedAt: new Date().toISOString(),
      profile: { server: profile.server, account: profile.account, realname: state.realname },
      tasks: sortByIdDesc(tasks),
      bugs: sortByIdDesc(bugs),
      stories: sortByIdDesc(stories),
      scan,
    };
  };

  // ---- RPC 通道 -----------------------------------------------------------
  // 这里刻意**不用** `ctx.connection.rpc.handle(...)`：它在内部以 `const owner = this.ctx`
  // 取「当前上下文」，再执行 owner.effect(() => owner.webServer.register({...}))；
  // 而那个 tracker 会跳过 ctx.inject 派生的影子上下文，解析回本插件行自己的 fiber，
  // 实测该 fiber 上读不到 webServer —— 行级 inject 与模块导出的 inject 都试过，
  // 一律抛 cannot get property "webServer" without inject（插件被跳过 → 界面报 HTTP 405）。
  // 改为直接在 ctx.inject(['webServer'], …) 的嵌套上下文里注册自有路由，
  // 与官方 @deepseek-ai/dsh-client-modules（lib/index.js:545-552）取 webServer 的方式一致。
  // 代价：失去 connection 的 admission 检查，所以下面自己做同源校验。
  const serveRpc = async (req, res) => {
    const send = (status, payload) => {
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(payload === undefined ? '' : JSON.stringify(payload));
    };
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const endpoint = decodeURIComponent(url.pathname.slice(RPC_METHOD.length).replace(/^\/+/, ''));

    // ---- 附件代理 ---------------------------------------------------------
    // 禅道的 file-read-* 直链在没有 Token 头时会返回登录页（实测 HTTP 200 + text/html 380B），
    // 所以浏览器里 <img src="禅道地址"> 只会显示坏图。这里用宿主持有的 token 取字节再回吐。
    // 只放行「与配置的禅道同源」且路径像附件的 URL，避免变成任意地址代理。
    if (endpoint === 'attachment') {
      const target = asString(url.searchParams.get('url'));
      if (target === '') {
        send(400, failure('缺少 url 参数', 'bad-request'));
        return;
      }
      if (!isSameOriginRequest(req)) {
        send(403, failure('拒绝非同源请求', 'forbidden'));
        return;
      }
      let parsed;
      try {
        parsed = new URL(target);
      } catch {
        send(400, failure('url 不是合法地址', 'bad-request'));
        return;
      }
      if (state.server === '' || state.token === '') {
        send(401, failure('未登录禅道。请先在工作台浮层登录。', 'unauthorized'));
        return;
      }
      let allowedOrigin;
      try {
        allowedOrigin = new URL(state.server).origin;
      } catch {
        send(500, failure('已保存的服务器地址不合法', 'internal'));
        return;
      }
      if (parsed.origin !== allowedOrigin || !ATTACHMENT_PATH_PATTERN.test(parsed.pathname)) {
        send(403, failure('只允许代理由当前禅道服务器提供的附件', 'forbidden'));
        return;
      }
      let response;
      try {
        response = await fetch(parsed.toString(), {
          headers: { Token: state.token, Accept: '*/*' },
          signal: withTimeout(undefined),
          redirect: 'follow',
        });
      } catch (error) {
        send(502, failure(`附件下载失败：${error instanceof Error ? error.message : String(error)}`, 'internal'));
        return;
      }
      if (!response.ok) {
        send(502, failure(`附件下载失败（HTTP ${response.status}）`, 'internal'));
        return;
      }
      const length = Number(response.headers.get('content-length') ?? '0');
      if (Number.isFinite(length) && length > MAX_ATTACHMENT_BYTES) {
        send(413, failure(`附件超过 ${MAX_ATTACHMENT_BYTES} 字节上限`, 'payload-too-large'));
        return;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > MAX_ATTACHMENT_BYTES) {
        send(413, failure(`附件超过 ${MAX_ATTACHMENT_BYTES} 字节上限`, 'payload-too-large'));
        return;
      }
      // 禅道对 mp4 / webm 之类的附件回的是 `application/octet-stream`（实测 2 MB 的 .mp4 就是，
      // 而且不带 content-length）。浏览器拿到 octet-stream 不会在 <video> / <audio> 里播，
      // 所以上游类型是「大路货」时改用扩展名猜出来的类型。图片本来上游就给 image/png，保持原样。
      const upstreamType = asString(response.headers.get('content-type')).split(';', 1)[0].trim();
      const guessedType = mimeForUrl(parsed.pathname);
      const contentType =
        upstreamType === '' || upstreamType === 'application/octet-stream'
          ? guessedType || upstreamType || 'application/octet-stream'
          : upstreamType;

      // Range：上游禅道**不支持**（实测带 `Range: bytes=0-1023` 仍回 200 全量、无 content-range、
      // 无 accept-ranges），但我们本来就把整个附件读进内存了，直接就地切片即可，
      // 这样 `<video>` 拖进度条时走 206，浏览器不会把已下载的分片丢掉重来。
      const range = parseByteRange(req.headers?.range, buffer.length);
      if (range === null) {
        res.writeHead(416, {
          'content-type': 'text/plain; charset=utf-8',
          'content-range': `bytes */${buffer.length}`,
          'cache-control': 'private, max-age=600',
        });
        res.end('请求的字节范围不合法');
        return;
      }
      if (range.partial) {
        res.writeHead(206, {
          'content-type': contentType,
          'content-length': String(range.end - range.start + 1),
          'content-range': `bytes ${range.start}-${range.end}/${buffer.length}`,
          'accept-ranges': 'bytes',
          'content-disposition': 'inline',
          'cache-control': 'private, max-age=600',
        });
        res.end(buffer.subarray(range.start, range.end + 1));
        return;
      }
      res.writeHead(200, {
        'content-type': contentType,
        'content-length': String(buffer.length),
        'accept-ranges': 'bytes',
        // 显式 inline：PDF 在工作台的预览 iframe 里直接渲染，而不是触发下载。
        'content-disposition': 'inline',
        'cache-control': 'private, max-age=600',
      });
      res.end(buffer);
      return;
    }

    if (req.method !== 'POST') {
      send(405, failure(`只接受 POST，收到 ${req.method}`, 'method-not-allowed'));
      return;
    }
    if (!isSameOriginRequest(req)) {
      send(403, failure('拒绝非同源请求', 'forbidden'));
      return;
    }
    const contentType = String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
    if (contentType !== 'application/json') {
      send(415, failure('content-type 必须是 application/json', 'unsupported-media-type'));
      return;
    }
    if (endpoint === '') {
      send(400, failure('缺少 RPC 端点名', 'bad-request'));
      return;
    }
    let raw;
    try {
      raw = await readRequestBody(req, MAX_REQUEST_BYTES);
    } catch (error) {
      send(413, failure(error instanceof Error ? error.message : String(error), 'payload-too-large'));
      return;
    }
    let payload;
    try {
      payload = raw === '' ? {} : JSON.parse(raw);
    } catch {
      send(400, failure('请求体不是合法 JSON', 'bad-request'));
      return;
    }
    send(200, await rpcHandler(endpoint, payload, undefined));
  };

  const rpcHandler = async (endpoint, payload, signal) => {
    const body = asObject(payload) ?? {};
    try {
      switch (endpoint) {
        case 'getConfig':
          return success(profileInfo());

        case 'login': {
          const result = await doLogin(
            {
              server: body.server ?? state.server,
              account: body.account ?? state.account,
              password: body.password,
              token: body.token,
            },
            signal,
          );
          state.server = result.server;
          state.account = result.account;
          state.realname = result.realname;
          state.token = result.token;
          if (typeof body.role === 'string' && body.role !== '') state.role = body.role;
          state.rememberToken = body.rememberToken === true;
          persist();
          return success(profileInfo());
        }

        case 'setRole': {
          if (typeof body.role === 'string' && body.role !== '') state.role = body.role;
          persist();
          return success(profileInfo());
        }

        case 'logout': {
          state.token = '';
          state.realname = '';
          state.rememberToken = false;
          persist();
          return success(profileInfo());
        }

        case 'refresh':
          return success(await refresh(signal, asString(body.scope) || 'all'));

        case 'fetchDetail': {
          const kind = asString(body.kind);
          const id = asString(body.id);
          if (!['task', 'bug', 'story'].includes(kind)) return failure('kind 必须是 task / bug / story', 'bad-request');
          if (id === '') return failure('缺少 id', 'bad-request');
          const profile = requireLogin();
          return success(await fetchDetail(profile, kind, id, signal));
        }

        case 'analyze': {
          const kind = asString(body.kind) || 'task';
          const id = asString(body.id);
          if (!['task', 'bug', 'story'].includes(kind)) return failure('kind 必须是 task / bug / story', 'bad-request');
          if (id === '') return failure('缺少 id', 'bad-request');
          const profile = requireLogin();
          const detail = await fetchDetail(profile, kind, id, signal);
          return success(await analyzeItem(ctx, kind, detail, signal));
        }

        case 'startTask': {
          const id = asString(body.id) || asString(body.taskId);
          if (id === '') return failure('缺少任务 id', 'bad-request');
          const profile = requireLogin();
          return success(await startTask(profile, id, signal));
        }

        case 'finishTask': {
          const id = asString(body.id) || asString(body.taskId);
          if (id === '') return failure('缺少任务 id', 'bad-request');
          const hours = body.hours === undefined || body.hours === '' ? 0 : Number(body.hours);
          if (!Number.isFinite(hours) || hours < 0) return failure('耗时（小时）必须是不小于 0 的数字', 'bad-request');
          const profile = requireLogin();
          return success(await finishTask(profile, id, hours, body.comment, signal));
        }

        case 'assignTask': {
          const id = asString(body.id) || asString(body.taskId);
          if (id === '') return failure('缺少任务 id', 'bad-request');
          const account = asString(body.account);
          if (account === '') return failure('缺少指派账号', 'bad-request');
          const profile = requireLogin();
          return success(await assignTask(profile, id, account, signal));
        }

        case 'listUsers':
          return success(await fetchUsers(requireLogin(), signal));

        case 'openAttachment': {
          const target = asString(body.url) || asString(body.proxyUrl);
          const fileName = asString(body.name);
          if (target === '') return failure('缺少附件地址', 'bad-request');
          const profile = requireLogin();
          return success(await openAttachment(profile, target, fileName, signal));
        }

        default:
          return failure(`未知操作：${endpoint}`, 'bad-request');
      }
    } catch (error) {
      return failure(
        error instanceof Error ? error.message : String(error),
        error instanceof RequestError ? error.code : undefined,
      );
    }
  };

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'prefix',
          path: RPC_METHOD,
          handler: serveRpc,
        }),
      'dsh-zentao-workbench: rpc route',
    );
  });

  // ---- 面向模型的 zentao 工具 --------------------------------------------
  // 这里刻意不使用 defineTool（那需要 import @deepseek-ai/dsh-tools）：
  // dsh-tools 的注册表只要求 parameters 是可快照的 JSON Schema、output 带 schema+render。
  ctx.tools.register({
    name: 'zentao',
    description:
      '读取禅道里指派给当前登录账号的任务/Bug/需求，或读取某一条的详情，或用当前模型先判一次条目类型。登录态复用 DSH Web 右侧「禅道工作台」浮层；若提示未登录，请先在浮层登录。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          description:
            "'mine'（默认）返回指派给我的任务/Bug/需求快照；'tasks' 只取任务；'detail' 读取单条详情；'analyze' 用当前模型预判该条是 Bug / 优化 / 需求并给出处理建议。",
          enum: ['mine', 'tasks', 'detail', 'analyze'],
        },
        kind: {
          type: 'string',
          description: 'action=detail 或 analyze 时必填：task / bug / story。',
          enum: ['task', 'bug', 'story'],
        },
        id: { type: 'string', description: 'action=detail 或 analyze 时必填：条目 ID。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { content: { type: 'string' } },
        required: ['content'],
      },
      render: (_args, value) => [{ type: 'text', text: value.content }],
    },
    async execute(args, exec) {
      const action = asString(args?.action) || 'mine';
      try {
        if (action === 'mine' || action === 'tasks') {
          if (state.token === '' || state.server === '') {
            return { content: '未登录禅道。请先在 DSH Web 的「禅道工作台」浮层登录，或在本机 ~/.dsh-zentao-workbench.json 写入 server/account/token 后重试。' };
          }
          const snapshot = await refresh(exec.signal, action === 'tasks' ? 'tasks' : 'all');
          return { content: clampText(formatSnapshot(snapshot)) };
        }
        if (action === 'detail') {
          const kind = asString(args?.kind);
          const id = asString(args?.id);
          if (!['task', 'bug', 'story'].includes(kind) || id === '') {
            return { content: 'action=detail 需要同时提供 kind（task|bug|story）与 id。' };
          }
          const profile = requireLogin();
          const detail = await fetchDetail(profile, kind, id, exec.signal);
          return { content: clampText(formatDetail(kind, detail)) };
        }
        if (action === 'analyze') {
          const kind = asString(args?.kind);
          const id = asString(args?.id);
          if (!['task', 'bug', 'story'].includes(kind) || id === '') {
            return { content: 'action=analyze 需要同时提供 kind（task|bug|story）与 id。' };
          }
          const profile = requireLogin();
          const detail = await fetchDetail(profile, kind, id, exec.signal);
          const analysis = await analyzeItem(ctx, kind, detail, exec.signal);
          return {
            content: clampText(
              [
                `#${analysis.id} ${analysis.title}`,
                `类别：${analysis.categoryLabel}（${analysis.category}${analysis.confidence === null ? '' : `，置信度 ${analysis.confidence}`}）`,
                `模型：${analysis.provider}/${analysis.model}`,
                analysis.headline === '' ? '' : `一句话：${analysis.headline}`,
                analysis.reason === '' ? '' : `依据：${analysis.reason}`,
                analysis.steps.length === 0 ? '' : `建议步骤：\n${analysis.steps.map((step, i) => `  ${i + 1}. ${step}`).join('\n')}`,
                analysis.questions.length === 0 ? '' : `待确认：\n${analysis.questions.map((q) => `  - ${q}`).join('\n')}`,
              ]
                .filter((line) => line !== '')
                .join('\n'),
            ),
          };
        }
        return { content: `未知 action：${action}（支持 mine / tasks / detail / analyze）` };
      } catch (error) {
        return { content: `禅道读取失败：${error instanceof Error ? error.message : String(error)}` };
      }
    },
  });
}
