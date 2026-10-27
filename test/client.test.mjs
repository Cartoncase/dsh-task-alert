// 浏览器半边的离线自测：用最小 DOM 桩把 client.js 当普通脚本跑起来，
// 验证「配置 → SSE 帧 → 页内卡片 / 系统通知 / 设置页注册 / 精简设置 / 清理」。
// 跑法：node _test/client.test.mjs
import assert from 'node:assert/strict';

// ------------------------------------------------------------------ DOM 桩

function matches(node, selector) {
  if (selector.startsWith('.')) {
    return (node.className || '').split(/\s+/).filter(Boolean).includes(selector.slice(1));
  }
  const attr = /^([a-zA-Z]+)?\[([^\]]+)\]$/.exec(selector);
  if (attr) {
    if (attr[1] && node.tagName !== attr[1].toUpperCase()) return false;
    return Object.prototype.hasOwnProperty.call(node.attributes, attr[2]);
  }
  return node.tagName === selector.toUpperCase();
}

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.className = '';
    this.dataset = {};
    this.attributes = {};
    this.childNodes = [];
    this.parentNode = null;
    this.textContent = '';
    this.style = {};
    this.type = '';
    this.checked = false;
    this.min = undefined;
    this.max = undefined;
    this.value = '';
    this._listeners = {};
    const self = this;
    this.classList = {
      add(name) {
        const set = new Set((self.className || '').split(/\s+/).filter(Boolean));
        set.add(name);
        self.className = [...set].join(' ');
      },
      remove(name) {
        const set = new Set((self.className || '').split(/\s+/).filter(Boolean));
        set.delete(name);
        self.className = [...set].join(' ');
      },
      contains(name) {
        return (self.className || '').split(/\s+/).includes(name);
      },
    };
  }
  appendChild(node) {
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }
  insertBefore(node, ref) {
    const index = ref ? this.childNodes.indexOf(ref) : -1;
    node.parentNode = this;
    if (index < 0) this.childNodes.push(node);
    else this.childNodes.splice(index, 0, node);
    return node;
  }
  removeChild(node) {
    const index = this.childNodes.indexOf(node);
    if (index >= 0) this.childNodes.splice(index, 1);
    node.parentNode = null;
    return node;
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  getAttribute(name) {
    return this.attributes[name];
  }
  addEventListener(type, cb) {
    (this._listeners[type] ??= []).push(cb);
  }
  removeEventListener(type, cb) {
    this._listeners[type] = (this._listeners[type] ?? []).filter((fn) => fn !== cb);
  }
  dispatch(type, event = {}) {
    for (const cb of this._listeners[type] ?? []) cb(event);
  }
  get firstChild() {
    return this.childNodes[0] ?? null;
  }
  get lastChild() {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }
  querySelector(selector) {
    for (const child of this.childNodes) {
      if (child && child.tagName && matches(child, selector)) return child;
      const found = child && child.querySelector ? child.querySelector(selector) : null;
      if (found) return found;
    }
    return null;
  }
  get textAll() {
    return this.childNodes.map((child) => (child.textContent || '') + (child.textAll || '')).join(' ');
  }
}

const head = new El('head');
const body = new El('body');
const documentElement = new El('html');

const document = {
  head,
  body,
  documentElement,
  visibilityState: 'visible',
  title: 'DSH',
  createElement: (tag) => new El(tag),
  createTextNode: (text) => ({ nodeType: 3, textContent: String(text), childNodes: [], textAll: '' }),
  querySelector(selector) {
    return head.querySelector(selector) ?? body.querySelector(selector) ?? documentElement.querySelector(selector);
  },
  addEventListener() {},
  removeEventListener() {},
  hasFocus() {
    return document.visibilityState === 'visible';
  },
};

// ------------------------------------------------------------------ 全局桩

let registered = null;
const notifications = [];
let lastEventSource = null;
const posts = [];
let serverConfig = {
  enabled: true,
  notifyDone: true,
  notifyError: true,
  notifyTruncated: true,
  notifyApproval: true,
  inPage: true,
  osNotification: true,
  sound: true,
  raiseWindow: true,
  dismissSeconds: 5,
  maxCards: 5,
};

class FakeNotification {
  static permission = 'granted';
  static requestPermission() {
    return Promise.resolve('granted');
  }
  constructor(title, options) {
    this.title = title;
    this.options = options;
    notifications.push(this);
  }
  close() {}
}

class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    lastEventSource = this;
    this.emit = (frame) => this.onmessage({ data: JSON.stringify(frame) });
  }
  close() {
    this.readyState = 2;
  }
}

globalThis.window = {
  document,
  addEventListener() {},
  removeEventListener() {},
  focus() {},
  setTimeout,
  Notification: FakeNotification,
  EventSource: FakeEventSource,
  __ModuleLoader__: {
    load(info) {
      registered = info;
    },
  },
};
globalThis.document = document;
Object.defineProperty(globalThis, 'navigator', {
  value: { userAgent: 'node-test' },
  configurable: true,
  writable: true,
});
globalThis.Notification = FakeNotification;
globalThis.EventSource = FakeEventSource;
globalThis.fetch = async (url, init) => {
  const method = (init && init.method) || 'GET';
  if (url.startsWith('/task-alert/config')) {
    if (method === 'POST') {
      const patch = JSON.parse(init.body);
      posts.push(patch);
      serverConfig = { ...serverConfig, ...patch };
      return { ok: true, json: async () => ({ config: serverConfig, saved: true }) };
    }
    return { ok: true, json: async () => ({ config: serverConfig }) };
  }
  if (url.startsWith('/task-alert/pending')) return { ok: true, json: async () => ({ cursor: 0, items: [] }) };
  if (url === '/task-alert/test') return { ok: true, json: async () => ({ ok: true }) };
  return { ok: false, status: 404, json: async () => ({}) };
};

// ------------------------------------------------------------------ 加载插件

await import('../client.js');

assert.ok(registered, 'client.js 应调用 __ModuleLoader__.load 注册 factory');
assert.equal(registered.id, 'dsh-task-alert');

const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
};

const mod = registered.factory((name) => {
  if (name === 'react') return ReactStub;
  throw new Error('unexpected require: ' + name);
});
assert.equal(typeof mod.apply, 'function');
assert.deepEqual(mod.inject, ['slots'], '要静态依赖 slots，才能注册设置页那一节');

// ------------------------------------------------------------------ ctx 桩

const registeredSections = [];
const disposers = [];
const slots = {
  inject(name, gen) {
    assert.equal(name, 'settings.section');
    const iterator = gen();
    iterator.next();
    return () => {};
  },
  register(spec, Component) {
    registeredSections.push({ spec, Component });
    return () => {};
  },
};
const ctx = {
  slots, // 正常路径：静态依赖满足后 ctx.slots 直接可用
  effect(fn, label) {
    const dispose = fn();
    if (typeof dispose === 'function') disposers.push(dispose);
    return dispose;
  },
  inject(services, cb) {
    cb({ slots }); // 退路，正常不该走到这里
  },
  get() {
    return null;
  },
};

mod.apply(ctx);
await new Promise((resolve) => setImmediate(resolve));

// 1) 设置页那一节注册上了
assert.equal(registeredSections.length, 1, '应向 DSH 设置页注册「任务提醒」一节');
assert.equal(registeredSections[0].spec.name, 'settings.section');
assert.equal(registeredSections[0].spec.id, 'task-alert');
assert.equal(registeredSections[0].spec.label(), '任务提醒');
assert.equal(typeof registeredSections[0].Component, 'function');
const diag = globalThis.window.__dshTaskAlert.state();
assert.equal(diag.registered, true, '注册成功应记进 diag');
assert.equal(diag.via, 'ctx.slots', '首选路径应是 ctx.slots');
assert.equal(diag.hasSlots, true);

// 2) 已连上提醒流，且从宿主读到了配置
assert.ok(lastEventSource, '应连上 /task-alert/events');
assert.equal(lastEventSource.url, '/task-alert/events');
assert.equal(globalThis.window.__dshTaskAlert.config().dismissSeconds, 5, '启动时应读到宿主配置');

// 3) 没有提醒时不该往页面上插容器
assert.equal(document.querySelector('.dta-root'), null);

// 4) 聚焦时：只弹页内卡片，不发系统通知
lastEventSource.onopen();
lastEventSource.emit({ kind: 'hello', seq: 0, config: serverConfig });
lastEventSource.emit({ kind: 'done', seq: 1, sessionId: 's1', sessionTitle: '写插件' });
const root = document.querySelector('.dta-root');
assert.ok(root, '收到提醒后应建立弹窗容器');
assert.equal(root.childNodes.length, 1);
assert.equal(root.firstChild.dataset.kind, 'done');
assert.match(root.firstChild.textAll, /任务完成/);
assert.match(root.firstChild.textAll, /写插件/);
assert.equal(notifications.length, 0, '窗口在前台不发系统通知');

// 5) 后台时：发系统通知
document.visibilityState = 'hidden';
lastEventSource.emit({ kind: 'approval', seq: 2, sessionId: 's2', toolName: 'bash', reason: '要写工作区外文件' });
assert.equal(notifications.length, 1, '后台应发系统通知');
assert.match(notifications[0].title, /批准/);
assert.match(notifications[0].options.body, /bash/);

// 6) 重复 seq 去重
const countBefore = root.childNodes.length;
lastEventSource.emit({ kind: 'done', seq: 2 });
assert.equal(root.childNodes.length, countBefore, '重复 seq 不该重复弹');

// 7) approval-done 收掉对应审批卡
const approvalCard = root.childNodes.find((node) => node.dataset.kind === 'approval');
assert.ok(approvalCard);
lastEventSource.emit({ kind: 'approval-done', seq: 3, sessionId: 's2', toolName: 'bash' });
assert.equal(approvalCard.dataset.gone, '1', '审批完成后卡片应关掉');

// 8) 卡片上的「设置」打开精简面板：4 个开关 + 保留秒数
document.visibilityState = 'visible';
lastEventSource.emit({ kind: 'done', seq: 4, sessionId: 's3' });
const doneCard = root.childNodes.find((node) => node.dataset.kind === 'done' && node.dataset.gone !== '1');
const gear = doneCard.querySelector('.dta-foot').childNodes.find((node) => node.textContent === '设置');
assert.ok(gear, '卡片上应有设置按钮');
gear.dispatch('click');
const quick = root.childNodes.find((node) => node.dataset.kind === 'settings');
assert.ok(quick, '精简设置面板应打开');
assert.match(quick.textAll, /后台时发系统通知/);

const inputs = [];
const collect = (node) => {
  for (const child of node.childNodes) {
    if (child.tagName === 'INPUT') inputs.push(child);
    if (child.childNodes) collect(child);
  }
};
collect(quick);
const checkboxes = inputs.filter((input) => input.type === 'checkbox');
const numbers = inputs.filter((input) => input.type === 'number');
assert.equal(checkboxes.length, 4, '精简面板应有 4 个开关');
assert.equal(numbers.length, 1, '精简面板应有 1 个"保留秒数"输入框');
assert.equal(numbers[0].value, '5', '保留秒数应回填配置值');

// 9) 改开关 → POST 到宿主（真源在宿主，不再写 localStorage）
checkboxes[2].checked = false;
checkboxes[2].dispatch('change');
assert.equal(posts.length, 1, '改开关应向宿主 POST 配置');
assert.equal(posts[0].sound, false, 'POST 的应是 sound=false');
assert.equal(serverConfig.sound, false);

// 10) 改保留秒数 → POST 并回填钳位后的值
numbers[0].value = '30';
numbers[0].dispatch('change');
assert.equal(posts.length, 2);
assert.equal(posts[1].dismissSeconds, 30);

// 11) 关掉系统通知后，后台不再发通知
notifications.length = 0;
await new Promise((resolve) => setImmediate(resolve));
checkboxes[0].checked = false;
checkboxes[0].dispatch('change');
document.visibilityState = 'hidden';
lastEventSource.emit({ kind: 'error', seq: 5, message: '上游 500' });
assert.equal(notifications.length, 0, '关掉开关后不该再发系统通知');
assert.match(root.textAll, /生成失败/);

// 12) 关掉某一类提醒后，那一类不再弹卡
const cursorBefore = root.childNodes.filter((node) => node.dataset.gone !== '1').length;
await globalThis.fetch('/task-alert/config', {
  method: 'POST',
  body: JSON.stringify({ notifyDone: false }),
});
await globalThis.window.__dshTaskAlert.reload();
lastEventSource.emit({ kind: 'done', seq: 6, sessionId: 's9' });
const visibleAfter = root.childNodes.filter((node) => node.dataset.kind === 'done' && node.dataset.gone !== '1').length;
assert.equal(visibleAfter, 2, '关掉"任务完成"后不该再弹 done 卡（原有 2 张还在）');
assert.ok(cursorBefore >= 1);

// 13) 清理：容器、样式、连接都没了
document.visibilityState = 'visible';
for (const dispose of disposers) dispose();
assert.equal(document.querySelector('.dta-root'), null, '卸载后应移除容器');
assert.equal(document.querySelector('style[data-dsh-task-alert]'), null, '卸载后应移除样式');
assert.equal(lastEventSource.readyState, 2, '卸载后应关闭事件流');

console.log('client.test OK');
