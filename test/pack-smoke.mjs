// 冒烟测试：不信任"仓库目录里能跑"，而是验证 **npm pack 出来的那份** 能被 DSH 正常加载。
// 用法：node test/pack-smoke.mjs <解包后的 package 目录>
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = process.argv[2];
assert.ok(dir, '用法: node test/pack-smoke.mjs <package dir>');

// ---------------------------------------------------------------- 1) 清单
const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
assert.equal(pkg.name, 'dsh-task-alert');
assert.equal(pkg.type, 'module', '宿主半边是 ESM');
assert.equal(pkg.dsh?.client?.platform, 'web', 'dsh.client.platform 必须是 web，否则浏览器半边不会被加载');
assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml');
assert.ok(pkg.exports?.['./client'], '必须有 exports["./client"]');
const hostEntry = join(dir, pkg.exports['.'] ?? pkg.main ?? 'index.js');
const clientEntry = join(dir, pkg.exports['./client']);
assert.ok(existsSync(hostEntry), `宿主入口不存在：${hostEntry}`);
assert.ok(existsSync(clientEntry), `客户端入口不存在：${clientEntry}`);
assert.ok(existsSync(join(dir, 'icon.svg')), '图标缺失（插件页显示用）');

// ---------------------------------------------------------------- 2) bundle patch
const patch = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8');
assert.match(patch, /id:\s*dsh-task-alert/, 'patch 必须把 entry id 写成包名');
assert.match(patch, /name:\s*'?"?dsh-task-alert'?"?/, 'patch 的 name 必须是包名，否则解析不到入口');
// 市场预检用正则抓 "id: 值" 那一行，行尾注释会让它抓不到
assert.ok(
  patch.split(/\r?\n/).some((line) => /id:\s*dsh-task-alert\s*$/.test(line)),
  'id 那一行不能带行尾注释',
);

// ---------------------------------------------------------------- 3) 客户端脚本可编译
// 只编译不执行：client.js 顶层就要 window.__ModuleLoader__，这里不该造一个假 DOM 来跑它。
new Function(readFileSync(clientEntry, 'utf8'));

// ---------------------------------------------------------------- 4) 宿主半边真的能跑
const home = mkdtempSync(join(tmpdir(), 'dsh-task-alert-pack-'));
process.env.DSH_HOME = home;

const plugin = await import(pathToFileURL(hostEntry).href);
assert.equal(typeof plugin.apply, 'function', '必须导出 apply(ctx)');
assert.deepEqual(plugin.inject, ['webServer']);

const listeners = new Map();
let route = null;
const ctx = {
  effect(fn) {
    return fn();
  },
  on(event, cb) {
    (listeners.get(event) ?? listeners.set(event, []).get(event)).push(cb);
    return () => {};
  },
  webServer: {
    register(r) {
      route = r;
      return () => {};
    },
  },
};
plugin.apply(ctx);
assert.ok(route, '应注册 HTTP 路由');
assert.equal(route.kind, 'prefix');
assert.equal(route.path, '/task-alert');

const emit = (event, ...args) => {
  for (const cb of listeners.get(event) ?? []) cb(...args);
};

function call(path, method = 'GET', body) {
  const res = {
    status: 0,
    chunks: [],
    writeHead(status) {
      res.status = status;
    },
    end(chunk) {
      if (chunk !== undefined) res.chunks.push(chunk);
    },
    write(chunk) {
      res.chunks.push(chunk);
    },
    on() {},
  };
  const req = {
    url: path,
    method,
    on(event, cb) {
      if (event === 'end') {
        if (body !== undefined) req._data.forEach((fn) => fn(Buffer.from(JSON.stringify(body))));
        cb();
      } else if (event === 'data') {
        (req._data ??= []).push(cb);
      }
    },
  };
  return route.handler(req, res).then(() => {
    const text = res.chunks.join('');
    return { status: res.status, text, json: () => JSON.parse(text) };
  });
}

const session = (id) => ({ id, header: { id, title: '写插件' } });
emit('session/event', session('s1'), { type: 'turn/end', data: { reason: { kind: 'completed' } } });
emit('session/event', session('s1'), { type: 'approval/asked', data: { toolName: 'bash', reason: '要写工作区外文件' } });

const pending = (await call('/task-alert/pending?since=0')).json();
assert.equal(pending.items.length, 2, '事件应变成两条提醒帧');
assert.equal(pending.items[0].kind, 'done');
assert.equal(pending.items[1].kind, 'approval');

const config = (await call('/task-alert/config')).json();
assert.equal(config.config.dismissSeconds, 12, '首次运行应给出默认配置');
assert.ok(existsSync(config.file), '首次运行应把配置文件落盘');

const health = (await call('/task-alert/health')).json();
assert.equal(health.ok, true);
assert.equal(health.version, pkg.version, 'health 里的版本要和 package.json 一致');

rmSync(home, { recursive: true, force: true });
console.log(`pack-smoke OK — ${pkg.name}@${pkg.version}`);
