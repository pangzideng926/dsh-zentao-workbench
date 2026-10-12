import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
function fixture() {
  const observers = [];
  const head = {
    children: [],
    appendChild(node) { node.remove(); this.children.push(node); node.parentNode = this; },
  };
  const document = {
    head,
    createElement() {
      return { dataset: {}, textContent: '', parentNode: null,
        remove() { if (this.parentNode) { const rows = this.parentNode.children; rows.splice(rows.indexOf(this), 1); this.parentNode = null; } },
      };
    },
  };
  class MutationObserver {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(target, options) { this.target = target; this.options = options; this.active = true; }
    disconnect() { this.active = false; }
  }
  let plugin;
  const context = { document, MutationObserver, window: { __ModuleLoader__: { load: entry => { plugin = entry.factory(() => ({})); } } } };
  // 只在测试中暴露闭包，不改变生产模块的插件导出契约。
  vm.runInNewContext(source.replace('module.exports = { name, inject, apply };', 'module.exports = { name, inject, apply, maintainStyles: typeof maintainStyles === "function" ? maintainStyles : undefined };'), context);
  const flush = () => observers.filter(observer => observer.active).forEach(observer => observer.callback());
  return { document, head, observers, flush, plugin };
}

test('禅道样式被移除或清空后恢复，GPT 样式及节点保持原样', () => {
  const { document, head, flush, plugin } = fixture();
  const gpt = document.createElement('style'); gpt.textContent = '.gwr-root { position:fixed }'; head.appendChild(gpt);
  assert.equal(typeof plugin.maintainStyles, 'function', '缺少运行时样式恢复');
  const dispose = plugin.maintainStyles();
  const own = head.children.find(node => node !== gpt);
  assert.match(own.textContent, /\.dzw-launcher/);
  const css = own.textContent;
  own.remove(); flush();
  assert.equal(own.parentNode, head);
  own.textContent = ''; flush();
  assert.equal(own.textContent, css);
  assert.equal(gpt.textContent, '.gwr-root { position:fixed }');
  assert.equal(head.children.filter(node => node !== gpt).length, 1);
  dispose(); flush();
  assert.deepEqual(head.children, [gpt]);
});

test('热更新旧实例清理不删除新实例样式，卸载后的排队回调不复活节点', () => {
  const { head, observers, plugin, flush } = fixture();
  assert.equal(typeof plugin.maintainStyles, 'function', '缺少按组件实例隔离的样式生命周期');
  const disposeOld = plugin.maintainStyles();
  const disposeNew = plugin.maintainStyles();
  const latest = head.children.at(-1);
  disposeOld(); flush();
  assert.deepEqual(head.children, [latest]);
  const lateCallback = observers.at(-1).callback;
  disposeNew(); lateCallback();
  assert.equal(head.children.length, 0);
  assert.ok(observers.every(observer => !observer.active));
});
