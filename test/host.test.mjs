// 宿主半边的离线自测：用假的 cordis ctx 驱动，验证「事件 → 配置过滤 → 提醒帧 → HTTP/SSE」。
// 跑法：node _test/host.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 配置要写到某个 DSH_HOME 里——测试用临时目录，绝不碰真实的 ~/.dsh
const home = mkdtempSync(join(tmpdir(), 'dsh-task-alert-test-'));
process.env.DSH_HOME = home;

const { apply, inject, name } = await import('../index.js');

function makeCtx() {
  const listeners = new Map();
  let route = null;
  const ctx = {
    disposers: [],
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === 'function') ctx.disposers.push(dispose);
      return dispose;
    },
    on(event, cb) {
      const list = listeners.get(event) ?? [];
      list.push(cb);
      listeners.set(event, list);
      return () => {
        listeners.set(event, (listeners.get(event) ?? []).filter((fn) => fn !== cb));
      };
    },
    webServer: {
      register(r) {
        route = r;
        return () => {
          route = null;
        };
      },
    },
  };
  return {
    ctx,
    emit(event, ...args) {
      for (const cb of listeners.get(event) ?? []) cb(...args);
    },
    get route() {
      return route;
    },
  };
}

function fakeRes() {
  const res = {
    status: 0,
    headers: null,
    chunks: [],
    ended: false,
    flushed: false,
    listeners: {},
    writeHead(status, headers) {
      res.status = status;
      res.headers = headers;
    },
    flushHeaders() {
      res.flushed = true;
    },
    write(chunk) {
      res.chunks.push(chunk);
      return true;
    },
    end(chunk) {
      if (chunk !== undefined) res.chunks.push(chunk);
      res.ended = true;
    },
    on(event, cb) {
      (res.listeners[event] ??= []).push(cb);
    },
  };
  return res;
}

function fakeReq(url, method = 'GET', body) {
  const listeners = { data: [], end: [], error: [] };
  const req = {
    url,
    method,
    on(event, cb) {
      (listeners[event] ??= []).push(cb);
    },
  };
  setImmediate(() => {
    if (body !== undefined) {
      const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
      for (const cb of listeners.data) cb(buf);
    }
    for (const cb of listeners.end) cb();
  });
  return req;
}

async function callRoute(route, url, method = 'GET', body) {
  const res = fakeRes();
  await route.handler(fakeReq(url, method, body), res);
  const text = res.chunks.join('');
  return { res, text, json: () => JSON.parse(text) };
}

const session = (id, extra = {}) => ({ id, header: { id, ...extra } });

// ------------------------------------------------------------------ 准备配置文件
const configFile = join(home, 'dsh-task-alert', 'config.json');
mkdirSync(join(home, 'dsh-task-alert'), { recursive: true });
writeFileSync(configFile, JSON.stringify({ dismissSeconds: 7, notifyDone: false }), 'utf8');

const h = makeCtx();
apply(h.ctx);

assert.equal(name, 'task-alert');
assert.deepEqual(inject, ['webServer']);
assert.ok(h.route, '应注册了 HTTP 路由');
assert.equal(h.route.kind, 'prefix');
assert.equal(h.route.path, '/task-alert');

// 1) 配置：GET 读的是磁盘那份，缺的字段回默认
let r = await callRoute(h.route, '/task-alert/config');
let cfg = r.json();
assert.equal(cfg.config.dismissSeconds, 7, '磁盘配置应生效');
assert.equal(cfg.config.notifyDone, false, '磁盘配置应生效');
assert.equal(cfg.config.maxCards, 5, '缺的字段回默认');
assert.equal(cfg.file, configFile);

// 2) notifyDone=false：完成的回合不产帧；跳过的帧也不占 seq
h.emit('session/event', session('s1', { title: '写插件' }), {
  type: 'turn/end',
  data: { reason: { kind: 'completed' } },
});
r = await callRoute(h.route, '/task-alert/pending?since=0');
assert.equal(r.json().items.length, 0, '关掉"任务完成"后不该产帧');
assert.equal(r.json().cursor, 0);

// 3) 失败 / 截断 / 审批仍然产帧（默认开）
h.emit('session/event', session('s2'), {
  type: 'turn/end',
  data: { reason: { kind: 'error', error: { message: '上游 500' } } },
});
h.emit('agent/error', { error: new Error('dispatch 炸了') });
h.emit('session/event', session('s3'), { type: 'turn/end', data: { reason: { kind: 'max-tokens' } } });
h.emit('session/event', session('s4', { title: '长任务' }), {
  type: 'approval/asked',
  data: { toolName: 'bash', reason: '要写工作区外文件', callId: 'c1' },
});
r = await callRoute(h.route, '/task-alert/pending?since=0');
let items = r.json().items;
assert.deepEqual(
  items.map((f) => f.kind),
  ['error', 'error', 'truncated', 'approval'],
);
assert.equal(items[0].message, '上游 500');
assert.equal(items[1].message, 'dispatch 炸了');
assert.equal(items[3].toolName, 'bash');
assert.equal(items[3].sessionTitle, '长任务');

// 4) 子代理 / 委派会话 / aborted 一律不产帧
const before = r.json().cursor;
h.emit('session/event', session('sub1', { origin: 'subagent' }), {
  type: 'turn/end',
  data: { reason: { kind: 'error' } },
});
h.emit('session/event', session('sub2', { delegationDepth: 2 }), {
  type: 'turn/end',
  data: { reason: { kind: 'error' } },
});
h.emit('session/event', session('s2'), { type: 'turn/end', data: { reason: { kind: 'aborted' } } });
r = await callRoute(h.route, `/task-alert/pending?since=${before}`);
assert.deepEqual(r.json().items, [], '子代理 / 委派 / aborted 都不该产帧');

// 5) approval-done 不受开关影响（关掉审批提醒也要能收卡）
await callRoute(h.route, '/task-alert/config', 'POST', { notifyApproval: false });
h.emit('session/event', session('s4'), { type: 'approval/decided', data: { toolName: 'bash' } });
r = await callRoute(h.route, '/task-alert/pending?since=' + before);
assert.deepEqual(
  r.json().items.map((f) => f.kind),
  ['approval-done'],
  'approval-done 必须放行',
);

// 6) 新的 POST 立即生效，并且真的落盘
r = await callRoute(h.route, '/task-alert/config', 'POST', {
  notifyDone: true,
  notifyApproval: true,
  dismissSeconds: 9999,
  maxCards: 0,
  hacker: 'ignored',
});
cfg = r.json();
assert.equal(cfg.saved, true);
assert.equal(cfg.config.notifyDone, true);
assert.equal(cfg.config.dismissSeconds, 600, '超上界钳到 600');
assert.equal(cfg.config.maxCards, 1, '低于下界钳到 1');
assert.equal(cfg.config.hacker, undefined, '未知字段丢掉');
const onDisk = JSON.parse(readFileSync(configFile, 'utf8'));
assert.equal(onDisk.dismissSeconds, 600, '配置应落盘');
assert.equal(onDisk.notifyDone, true);

// 7) 总开关关掉后什么都不发（但 approval-done 例外，见上）
await callRoute(h.route, '/task-alert/config', 'POST', { enabled: false });
const cursorBefore = (await callRoute(h.route, '/task-alert/pending?since=0')).json().cursor;
h.emit('session/event', session('s5'), { type: 'turn/end', data: { reason: { kind: 'completed' } } });
h.emit('session/event', session('s5'), { type: 'approval/asked', data: { toolName: 'pwsh' } });
r = await callRoute(h.route, `/task-alert/pending?since=${cursorBefore}`);
assert.deepEqual(r.json().items, [], '总开关关掉后不该发提醒');
await callRoute(h.route, '/task-alert/config', 'POST', { enabled: true });

// 8) 坏配置不让插件罢工：坏 JSON 回默认
writeFileSync(configFile, '{ 这不是 JSON', 'utf8');
r = await callRoute(h.route, '/task-alert/config');
assert.equal(r.json().config.dismissSeconds, 12, '坏配置文件回默认值');
await callRoute(h.route, '/task-alert/config', 'POST', { dismissSeconds: 12 });

// 9) SSE 推送
const live = fakeRes();
await h.route.handler(fakeReq('/task-alert/events'), live);
assert.equal(live.status, 200);
assert.match(live.headers['content-type'], /text\/event-stream/);
assert.equal(live.flushed, true);
const helloChunk = live.chunks.join('');
assert.match(helloChunk, /"kind":"hello"/);
const parsedHello = JSON.parse(
  helloChunk
    .split('\n')
    .find((line) => line.startsWith('data: '))
    .slice(6),
);
assert.equal(typeof parsedHello.config.dismissSeconds, 'number', 'hello 应带上配置，页面一上来就能用');

const beforePush = live.chunks.length;
h.emit('session/event', session('s6', { title: '长任务' }), {
  type: 'turn/end',
  data: { reason: { kind: 'completed' } },
});
assert.ok(live.chunks.length > beforePush, 'SSE 应实时收到新帧');
const pushed = live.chunks
  .slice(beforePush)
  .join('')
  .trim()
  .split('\n')
  .filter((line) => line.startsWith('data: '));
assert.equal(pushed.length, 1);
const pushedFrame = JSON.parse(pushed[0].slice(6));
assert.equal(pushedFrame.kind, 'done');
assert.equal(pushedFrame.sessionId, 's6');

// 10) 连接关闭后不再写
live.listeners.close[0]();
const afterClose = live.chunks.length;
h.emit('session/event', session('s7'), { type: 'turn/end', data: { reason: { kind: 'completed' } } });
assert.equal(live.chunks.length, afterClose, '连接关闭后不应再写入');

// 11) health / test / 404 / 405 / 坏 body
r = await callRoute(h.route, '/task-alert/health');
assert.equal(r.json().ok, true);
assert.equal(r.json().streams, 0);
assert.equal(r.json().file, configFile);

r = await callRoute(h.route, '/task-alert/test');
assert.equal(r.json().ok, true);
assert.equal(r.json().frame.kind, 'approval', '"试一下"要能绕过类别开关');

r = await callRoute(h.route, '/task-alert/nope');
assert.equal(r.res.status, 404);

r = await callRoute(h.route, '/task-alert/pending', 'PUT');
assert.equal(r.res.status, 405);

r = await callRoute(h.route, '/task-alert/config', 'POST', '不是对象');
assert.equal(r.res.status, 400, '坏 body 应 400');

// 12) 卸载：连接被收掉
const live2 = fakeRes();
await h.route.handler(fakeReq('/task-alert/events'), live2);
for (const dispose of h.ctx.disposers) dispose();
assert.equal(live2.ended, true, '卸载时应结束长连接');

// 13) 配置文件目录确实是 DSH_HOME 下（不会写到别处）
assert.ok(existsSync(configFile));

rmSync(home, { recursive: true, force: true });

// 14) 首次运行（配置文件不存在）应把默认配置落盘，让"配置文件在哪"有个看得见的答案
const home2 = mkdtempSync(join(tmpdir(), 'dsh-task-alert-test2-'));
process.env.DSH_HOME = home2;
const h2 = makeCtx();
apply(h2.ctx);
const firstFile = join(home2, 'dsh-task-alert', 'config.json');
assert.ok(existsSync(firstFile), '首次运行应写出默认配置');
const firstConfig = JSON.parse(readFileSync(firstFile, 'utf8'));
assert.equal(firstConfig.dismissSeconds, 12);
assert.equal(firstConfig.notifyApproval, true);
const health2 = await callRoute(h2.route, '/task-alert/health');
assert.equal(health2.json().version, '0.2.0');
rmSync(home2, { recursive: true, force: true });

console.log('host.test OK');
