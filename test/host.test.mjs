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
  const services = new Map();
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
    get(name) {
      return services.get(name);
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
    setService(name, value) {
      services.set(name, value);
    },
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
assert.equal(r.json().frame.kind, 'done', '演示提醒默认是一条完成提醒（像真的那样带上下文）');
assert.equal(r.json().frame.project, '自制插件');
assert.equal(r.json().frame.sessionTitle, '演示会话：这条提醒长这样');
assert.equal(r.json().frame.titleSource, 'demo');

// 查询参数可改种类与文案，方便截图不同场景
r = await callRoute(h.route, '/task-alert/test?kind=approval&project=某项目&title=某会话');
assert.equal(r.json().frame.kind, 'approval');
assert.equal(r.json().frame.project, '某项目');
assert.equal(r.json().frame.sessionTitle, '某会话');
assert.equal(r.json().frame.toolName, 'bash', '审批演示要带工具名，否则卡片没有信息量');

r = await callRoute(h.route, '/task-alert/nope');
assert.equal(r.res.status, 404);

r = await callRoute(h.route, '/task-alert/pending', 'PUT');
assert.equal(r.res.status, 405);

r = await callRoute(h.route, '/task-alert/config', 'POST', '不是对象');
assert.equal(r.res.status, 400, '坏 body 应 400');

// 11b) health 自报的版本必须和 package.json 一致（曾经写死过，抓过一次）
const pkgVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const healthNow = await callRoute(h.route, '/task-alert/health');
assert.equal(healthNow.json().version, pkgVersion, 'health.version 不能和 package.json 脱节');

// 12) 卸载：连接被收掉
const live2 = fakeRes();
await h.route.handler(fakeReq('/task-alert/events'), live2);
for (const dispose of h.ctx.disposers) dispose();
assert.equal(live2.ended, true, '卸载时应结束长连接');

// 13) 配置文件目录确实是 DSH_HOME 下（不会写到别处）
assert.ok(existsSync(configFile));

// 13b) 标题来自 session/title 事件 —— DSH 真正的标题来源（不是 header.title）
const h3 = makeCtx();
apply(h3.ctx);
h3.emit('session/event', session('t1'), { type: 'session/title', data: { title: '写插件的小助手' } });
h3.emit('session/event', session('t1'), { type: 'turn/end', data: { reason: { kind: 'completed' } } });
const titleFrame = (await callRoute(h3.route, '/task-alert/pending?since=0')).json().items[0];
assert.equal(titleFrame.sessionTitle, '写插件的小助手', '卡片要显示会话名，不是 id 尾号');
assert.equal(titleFrame.sessionId, 't1');

// 13c) 没有事件缓存时，退到 ctx.sessionTitle 服务
const h4 = makeCtx();
h4.setService('sessionTitle', { get: () => '服务给的标题' });
apply(h4.ctx);
h4.emit('session/event', session('t2'), { type: 'turn/end', data: { reason: { kind: 'completed' } } });
const serviceFrame = (await callRoute(h4.route, '/task-alert/pending?since=0')).json().items[0];
assert.equal(serviceFrame.sessionTitle, '服务给的标题', '服务兜底也要生效');

// 13d) 真·活的 Session：标题从日志折叠，项目从 header.cwd 取末级目录
//      （dsh-session 的 commit() 用 [session, event] 通知观察者，snapshotEvents() 拿得到完整日志）
const h5 = makeCtx();
apply(h5.ctx);
const liveSession = {
  id: 'p1',
  header: { id: 'p1', cwd: 'C:\\Users\\someone\\Desktop\\自制插件' },
  snapshotEvents: () => [
    { type: 'user/message', data: {} },
    { type: 'session/title', data: { title: 'DSH 任务完成与审批弹窗插件' } },
  ],
};
h5.emit('session/event', liveSession, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
const liveFrame = (await callRoute(h5.route, '/task-alert/pending?since=0')).json().items[0];
assert.equal(liveFrame.sessionTitle, 'DSH 任务完成与审批弹窗插件', '日志里的标题要折叠出来');
assert.equal(liveFrame.project, '自制插件', '项目名＝工作目录末级目录');
assert.equal(liveFrame.titleSource, 'log', '能看出标题是从日志取的');

// 审批帧也要带项目和会话（"有操作要审批"必须说清在哪）
h5.emit('session/event', liveSession, {
  type: 'approval/asked',
  data: { toolName: 'bash', reason: '要写工作区外文件' },
});
const approvalFrame = (await callRoute(h5.route, '/task-alert/pending?since=1')).json().items[0];
assert.equal(approvalFrame.kind, 'approval');
assert.equal(approvalFrame.project, '自制插件');
assert.equal(approvalFrame.sessionTitle, 'DSH 任务完成与审批弹窗插件');
assert.equal(approvalFrame.toolName, 'bash');

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
assert.equal(health2.json().version, pkgVersion, '新实例的 health 版本也要跟 package.json 一致');
rmSync(home2, { recursive: true, force: true });

console.log('host.test OK');
