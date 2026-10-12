/** 记住密码的离线回归：真实 Windows DPAPI，模拟禅道，不读取用户配置。 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

if (process.platform !== 'win32') {
  console.log('SKIP：DPAPI 回归需要 Windows 和 PowerShell 7');
  process.exit(0);
}
const dir = mkdtempSync(join(tmpdir(), 'dzw-remember-'));
const configPath = join(dir, 'config.json');
process.env.DSH_ZENTAO_WORKBENCH_CONFIG = configPath;
const { apply } = await import('../lib/index.js');
const server = 'http://zentao.example/zentao';
const tokens = new Map([['other-token', 'other']]);
let expectedPassword = 'test-password';
let attempts = 0;
let rejectLogin = false;
let loginGate;
let failures = 0;
let checks = 0;
globalThis.fetch = async (url, init = {}) => {
  const path = new URL(url).pathname.split('/api.php/v1/')[1];
  if (path === 'tokens') {
    attempts += 1;
    const body = JSON.parse(init.body);
    // 不在断言失败输出中打印凭据。
    assert.ok(body.password === expectedPassword, '密码必须原样发送');
    if (loginGate) await loginGate;
    if (rejectLogin) return Response.json({ error: '模拟登录失败' }, { status: 400 });
    const token = `test-token-${attempts}`;
    tokens.set(token, body.account);
    return Response.json({ token });
  }
  if (path === 'user') {
    const account = tokens.get(init.headers.Token);
    return Response.json({ account, realname: '测试用户' });
  }
  if (path === 'tasks') return Response.json({ tasks: [], total: 0 });
  throw new Error(`未预期的接口：${path}`);
};

function makeHost() {
  let route;
  let tool;
  apply({
    inject(_deps, callback) {
      callback({ effect: (effect) => effect(), webServer: { register: (value) => { route = value; } } });
    },
    tools: { register: (value) => { tool = value; } },
  });
  return {
    tool,
    async call(endpoint, payload = {}) {
      const req = Readable.from([Buffer.from(JSON.stringify(payload))]);
      Object.assign(req, { method: 'POST', url: `/zentao-workbench/${endpoint}`, headers: { host: 'localhost', 'content-type': 'application/json' } });
      let result;
      const res = { writeHead(status) { assert.equal(status, 200); }, end(body) { result = JSON.parse(body); } };
      await route.handler(req, res);
      return result;
    },
  };
}
function check(label, condition) {
  checks += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}`);
  if (!condition) failures += 1;
}
const readConfig = () => JSON.parse(readFileSync(configPath, 'utf8'));
const saveConfig = (value) => writeFileSync(configPath, JSON.stringify(value), 'utf8');
try {
  const initial = makeHost();
  const login = await initial.call('login', { server, account: 'tester', password: expectedPassword, rememberPassword: true });
  check('勾选后保存 DPAPI 密文，不保存 Token', login.value?.rememberPassword === true && readConfig().passwordEnc !== '' && readConfig().token === '');
  const saved = readConfig();
  const fresh = () => { saveConfig(saved); return makeHost(); };

  let host = fresh();
  const before = attempts;
  const configs = await Promise.all([host.call('getConfig'), host.call('getConfig')]);
  check('重启后仅保存密码也能恢复登录', configs.every((result) => result.value?.hasToken === true));
  check('并发恢复只登录一次', attempts === before + 1);
  check('响应不含密码、密文或 Token', configs.every(({ value }) => value && !['password', 'passwordEnc', 'token'].some((key) => key in value)));

  await host.call('logout');
  check('主动退出后查询配置不会重新登录', (await host.call('getConfig')).value?.hasToken === false);
  host = makeHost();
  check('主动退出后重启仍保持退出', (await host.call('getConfig')).value?.hasToken === false);
  const manual = await host.call('login', { server: `${server}/`, account: ' tester ', password: '', token: '', rememberPassword: true });
  check('同账号留空密码点击登录可复用密文', manual.value?.hasToken === true && manual.value?.rememberPassword === true);

  host = fresh();
  const beforeChange = attempts;
  const changed = await host.call('login', { server, account: 'other', rememberPassword: true });
  const changedServer = await host.call('login', { server: 'http://other.example', account: 'tester', rememberPassword: true });
  check('换账号或服务器不使用旧密码', changed.ok === false && changedServer.ok === false && attempts === beforeChange);
  const switched = await host.call('login', { server, account: 'other', token: 'other-token', rememberPassword: true });
  check('Token 换账号清除旧账号密文', switched.value?.rememberPassword === false && readConfig().passwordEnc === '');

  host = fresh();
  await host.call('forgetPassword');
  check('清除密码后重启不会恢复登录', (await makeHost().call('getConfig')).value?.hasToken === false);

  host = fresh();
  rejectLogin = true;
  const beforeFailure = attempts;
  const failed = await host.call('getConfig');
  await host.call('getConfig');
  check('恢复失败返回可登录表单并抑制连续重试', failed.ok === true && failed.value?.hasToken === false && attempts === beforeFailure + 1);
  rejectLogin = false;
  check('恢复失败后仍可主动使用保存密码登录', (await host.call('login', { server, account: 'tester', rememberPassword: true })).value?.hasToken === true);

  host = fresh();
  let release;
  loginGate = new Promise((resolve) => { release = resolve; });
  const pending = host.call('getConfig');
  await new Promise((resolve) => setImmediate(resolve));
  await host.call('logout');
  release();
  await pending;
  loginGate = undefined;
  check('恢复登录过程中退出不被晚到结果覆盖', (await host.call('getConfig')).value?.hasToken === false);

  host = fresh();
  const toolResult = await host.tool.execute({ action: 'tasks' }, {});
  check('模型工具首次访问也能恢复登录', !toolResult.content.includes('未登录') && (await host.call('getConfig')).value?.hasToken === true);

  const legacy = { ...saved };
  delete legacy.autoLogin;
  saveConfig(legacy);
  check('旧配置没有自动登录字段也能恢复', (await makeHost().call('getConfig')).value?.hasToken === true);

  host = fresh();
  const noRemember = await host.call('login', { server, account: 'tester', rememberPassword: false });
  check('取消记住密码可完成本次登录且清除已保存密码', noRemember.value?.hasToken === true && readConfig().passwordEnc === '');
  check('未保存密码或 Token 时重启仍需手动登录', (await makeHost().call('getConfig')).value?.hasToken === false);

  expectedPassword = '  测试-password  ';
  await initial.call('login', { server, account: 'tester', password: expectedPassword, rememberPassword: true });
  check('密码中的中文与首尾空格重启后保持原样', (await makeHost().call('getConfig')).value?.hasToken === true);
} finally {
  try { unlinkSync(configPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  rmdirSync(dir);
}
console.log(`${checks - failures}/${checks} 项通过`);
process.exitCode = failures ? 1 : 0;
