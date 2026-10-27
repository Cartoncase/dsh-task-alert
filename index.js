/**
 * dsh-task-alert —— 宿主半边（host half）
 *
 * 职责：监听 DSH 宿主事件，把「任务完成 / 生成失败 / 输出截断 / 等待审批」变成一条条
 * 结构化提醒帧，并通过一条 SSE 长连接推给浏览器半边弹窗。
 *
 * 为什么用 SSE 而不是轮询：DSH 的页面一旦被切到后台（最小化、被别的窗口盖住），
 * 浏览器的定时器会被节流到每分钟一次——而"窗口在后台被忽略"正是本插件要解决的场景。
 * SSE 是服务端推流，不受定时器节流，后台也能立刻收到。
 *
 * 路由（挂在 webServer 上，前缀 /task-alert）：
 *   GET  /task-alert/events             → text/event-stream，实时推帧（含心跳）
 *   GET  /task-alert/pending?since=<n>  → 断线重连后的补帧（JSON）
 *   GET  /task-alert/config             → 当前配置 + 配置文件路径
 *   POST /task-alert/config             → 保存配置（部分字段即可，自动校验钳位）
 *   GET  /task-alert/health             → 存活探测
 *   GET  /task-alert/test               → 造一条测试帧（设置里"试一下"用）
 *
 * 配置落在 $DSH_HOME/dsh-task-alert/config.json（默认 ~/.dsh/dsh-task-alert/config.json），
 * 手改这个文件也生效（下次 GET/POST/重启时重读）。
 *
 * 事件源（都是 DSH 宿主事件，纯监听、不调用模型）：
 *   session/event: turn/end（completed / error / max-tokens）、approval/asked、approval/decided
 *   agent/error：没有回合位置的生成失败
 *
 * 过滤：子代理 / 委派会话（origin=subagent 或 delegationDepth>0）不发——你等的是父对话。
 * 判据取不到时放行：宁可多弹一条，也不能因为宿主换字段让提醒整体失效。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ROUTE_PREFIX = '/task-alert';
const BUFFER_LIMIT = 200;
const HEARTBEAT_MS = 15_000;
const MAX_BODY_BYTES = 64 * 1024;

/**
 * 版本号从 package.json 读，不要写死——写死过一次，结果 0.2.1 的包对外自报 0.2.0
 * （打包冒烟测试当场抓到：health.version 与 package.json 不一致）。
 */
const VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
    return typeof pkg?.version === 'string' && pkg.version !== '' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

export const name = 'task-alert';
export const inject = ['webServer'];

const DEFAULT_CONFIG = {
  // 总开关
  enabled: true,
  // 提醒哪几类
  notifyDone: true,
  notifyError: true,
  notifyTruncated: true,
  notifyApproval: true,
  // 怎么提醒
  inPage: true,
  osNotification: true,
  sound: true,
  raiseWindow: true,
  // 页内卡片的节奏
  dismissSeconds: 12, // 0 = 不自动关闭
  maxCards: 5,
};

/** 数值字段的合法区间，越界钳位而不是报错（配置坏掉不该让插件罢工） */
const NUMBER_RANGES = {
  dismissSeconds: [0, 600],
  maxCards: [1, 10],
};

const KIND_TO_CONFIG = {
  done: 'notifyDone',
  error: 'notifyError',
  truncated: 'notifyTruncated',
  approval: 'notifyApproval',
};

const asString = (v) => (typeof v === 'string' && v !== '' ? v : undefined);

// ---------------------------------------------------------------- 配置

function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim();
  return join(homedir(), '.dsh');
}

function configPath() {
  return join(dshHome(), 'dsh-task-alert', 'config.json');
}

/** 把任意来源的对象收敛成一份合法配置：未知字段丢掉，类型不对回默认，数值钳位。 */
function normalizeConfig(raw) {
  const out = { ...DEFAULT_CONFIG };
  if (!raw || typeof raw !== 'object') return out;
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (!(key in raw)) continue;
    const value = raw[key];
    if (typeof DEFAULT_CONFIG[key] === 'boolean') {
      if (typeof value === 'boolean') out[key] = value;
      continue;
    }
    const range = NUMBER_RANGES[key];
    const num = Number(value);
    if (!Number.isFinite(num)) continue;
    const lower = range ? range[0] : 0;
    const upper = range ? range[1] : Number.MAX_SAFE_INTEGER;
    out[key] = Math.min(upper, Math.max(lower, Math.round(num)));
  }
  return out;
}

function loadConfig() {
  try {
    const text = readFileSync(configPath(), 'utf8');
    return normalizeConfig(JSON.parse(text));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(config) {
  const file = configPath();
  try {
    mkdirSync(join(dshHome(), 'dsh-task-alert'), { recursive: true });
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    return true;
  } catch (error) {
    console.warn(`[task-alert] 写配置文件失败（${file}）：${error}`);
    return false;
  }
}

// ---------------------------------------------------------------- 会话事件 → 提醒帧

function headerOf(session) {
  const h = session?.header;
  return h && typeof h === 'object' ? h : undefined;
}

function sessionIdOf(session) {
  return asString(headerOf(session)?.id) ?? asString(session?.id);
}

/**
 * 会话标题。DSH 里标题**不在 header 上**，它由 `dsh-session-title` 服务维护：
 *   · 权威读法：`ctx.sessionTitle.get(session)`（服务不存在时返回 undefined）；
 *   · 兜底：`session/title` 事件里带的那份（见 apply() 里的 titles 缓存）；
 *   · 再兜底：header.title / header.name / session.title（少数组合里才有）。
 * 全部拿不到才返回 undefined——调用方会退到 id 尾号，但正常情况下不该走到那一步。
 */
function sessionTitleOf(session, ctx, titleCache) {
  const sid = sessionIdOf(session);
  if (sid && titleCache && titleCache.has(sid)) return titleCache.get(sid);
  try {
    const service = typeof ctx?.get === 'function' ? ctx.get('sessionTitle') : undefined;
    const fromService = typeof service?.get === 'function' ? service.get(session) : undefined;
    if (asString(fromService)) return asString(fromService);
  } catch {
    /* 服务形状变了就当取不到，走兜底 */
  }
  const h = headerOf(session);
  return asString(h?.title) ?? asString(h?.name) ?? asString(session?.title) ?? undefined;
}

/** 子代理 / 更深层委派会话：不提醒（判据不可用时放行）。 */
function isSubagent(session) {
  const h = headerOf(session);
  if (!h) return false;
  if (h.origin === 'subagent') return true;
  const depth = h.delegationDepth;
  return typeof depth === 'number' && Number.isFinite(depth) && depth > 0;
}

/** turn/end 的 reason.kind → 提醒类别；不提醒的分支（aborted/interrupted/blocked）返回 null。 */
function turnEndKind(reason) {
  const kind = reason?.kind;
  if (kind === 'completed') return 'done';
  if (kind === 'error') return 'error';
  if (kind === 'max-tokens') return 'truncated';
  return null;
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (size === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

// ---------------------------------------------------------------- 插件

export function apply(ctx) {
  /** 最近的提醒帧（断线补帧用），最多 BUFFER_LIMIT 条 */
  const frames = [];
  /** 打开着的 SSE 连接 */
  const streams = new Set();
  let seq = 0;
  let config = loadConfig();
  // 首次运行把默认配置落盘：让"配置文件在哪"这个问题有个看得见的答案
  try {
    if (!existsSync(configPath())) saveConfig(config);
  } catch {
    /* 写不了就算了，内存里的默认值照样能用 */
  }

  /**
   * 发一条提醒。返回落库后的帧；被配置挡掉时返回 null。
   * force=true 绕过类别开关（"试一下"与 approval-done 用它）。
   */
  function publish(frame, force = false) {
    if (!force) {
      if (!config.enabled) return null;
      const key = KIND_TO_CONFIG[frame.kind];
      if (key && !config[key]) return null;
    }
    const full = { ...frame, seq: ++seq, at: Date.now() };
    frames.push(full);
    if (frames.length > BUFFER_LIMIT) frames.shift();
    const chunk = `data: ${JSON.stringify(full)}\n\n`;
    for (const res of streams) {
      try {
        res.write(chunk);
      } catch {
        // 写失败＝这条连接已经废了，close 事件里会摘掉
      }
    }
    return full;
  }

  function openStream(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    const hello = { kind: 'hello', seq, at: Date.now(), config };
    res.write(`retry: 3000\n\ndata: ${JSON.stringify(hello)}\n\n`);

    streams.add(res);
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* 交给 close 处理 */
      }
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    const cleanup = () => {
      clearInterval(heartbeat);
      streams.delete(res);
    };
    res.on('close', cleanup);
    res.on('error', cleanup);
  }

  async function handler(req, res) {
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      return sendJson(res, 400, { error: 'bad url' });
    }
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const allow = method === 'GET' || method === 'HEAD' || method === 'POST';
    if (!allow) return sendJson(res, 405, { error: 'method not allowed' });

    if (path === `${ROUTE_PREFIX}/events`) {
      if (method === 'HEAD') {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        return res.end();
      }
      return openStream(req, res);
    }

    if (path === `${ROUTE_PREFIX}/pending`) {
      const since = Number(url.searchParams.get('since') ?? 0) || 0;
      return sendJson(res, 200, {
        cursor: seq,
        items: frames.filter((f) => f.seq > since),
      });
    }

    if (path === `${ROUTE_PREFIX}/config`) {
      if (method === 'POST') {
        const body = await readBody(req);
        if (body === null) return sendJson(res, 400, { error: 'body must be a JSON object' });
        config = normalizeConfig({ ...config, ...body });
        const saved = saveConfig(config);
        return sendJson(res, 200, { config, file: configPath(), saved });
      }
      // GET：重读磁盘，手改配置文件也能生效
      config = loadConfig();
      return sendJson(res, 200, { config, file: configPath(), version: VERSION });
    }

    if (path === `${ROUTE_PREFIX}/health`) {
      return sendJson(res, 200, {
        ok: true,
        seq,
        streams: streams.size,
        version: VERSION,
        enabled: config.enabled,
        file: configPath(),
      });
    }

    if (path === `${ROUTE_PREFIX}/test`) {
      const frame = publish(
        {
          kind: 'approval',
          title: '测试提醒',
          body: '这是一条测试弹窗：能看到它，说明插件工作正常。',
          toolName: 'test',
        },
        true,
      );
      return sendJson(res, 200, { ok: true, frame });
    }

    return sendJson(res, 404, { error: 'not found' });
  }

  // 宿主事件 → 提醒帧
  ctx.effect(() => {
    /** sessionId → 标题（来自 session/title 事件；服务取不到时兜底） */
    const titles = new Map();

    const disposeSession = ctx.on('session/event', (session, event) => {
      const type = event?.type;

      // 标题事件：DSH 生成/重命名标题时追加这条，顺手记下来给后面的提醒用
      if (type === 'session/title') {
        const sid = sessionIdOf(session);
        const title = asString(event?.data?.title);
        if (sid && title) {
          titles.set(sid, title);
          if (titles.size > 500) titles.delete(titles.keys().next().value); // 只留最近 500 条，别无限涨
        }
        return;
      }

      const title = () => sessionTitleOf(session, ctx, titles);
      const sid = sessionIdOf(session);

      if (type === 'turn/end') {
        if (isSubagent(session)) return;
        const kind = turnEndKind(event?.data?.reason);
        if (!kind) return;
        const reason = event?.data?.reason;
        publish({
          kind,
          ...(sid ? { sessionId: sid } : {}),
          ...(title() ? { sessionTitle: title() } : {}),
          ...(kind === 'error' ? { message: asString(reason?.error?.message) } : {}),
        });
        return;
      }
      if (type === 'approval/asked') {
        if (isSubagent(session)) return;
        const data = event?.data ?? {};
        publish({
          kind: 'approval',
          ...(sid ? { sessionId: sid } : {}),
          ...(title() ? { sessionTitle: title() } : {}),
          ...(asString(data.toolName) ? { toolName: asString(data.toolName) } : {}),
          ...(asString(data.reason) ? { reason: asString(data.reason) } : {}),
          ...(asString(data.callId) ? { callId: asString(data.callId) } : {}),
        });
        return;
      }
      if (type === 'approval/decided') {
        if (isSubagent(session)) return;
        const data = event?.data ?? {};
        // 收卡不受类别开关影响：关掉审批提醒后，已经弹出来的卡片照样要能收掉
        publish(
          {
            kind: 'approval-done',
            ...(sid ? { sessionId: sid } : {}),
            ...(asString(data.toolName) ? { toolName: asString(data.toolName) } : {}),
            ...(asString(data.callId) ? { callId: asString(data.callId) } : {}),
          },
          true,
        );
      }
    });

    const disposeError = ctx.on('agent/error', (payload) => {
      const error = payload?.error ?? payload;
      const message =
        typeof error === 'string' ? error : error instanceof Error ? error.message : asString(error?.message);
      publish({ kind: 'error', ...(message ? { message } : {}) });
    });

    return () => {
      disposeSession?.();
      disposeError?.();
    };
  }, 'task-alert: dsh session events');

  // 路由
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }), 'task-alert: http route');

  // 卸载时收掉所有长连接，别留半开的 socket
  ctx.effect(
    () => () => {
      for (const res of streams) {
        try {
          res.end();
        } catch {
          /* 已经断了 */
        }
      }
      streams.clear();
    },
    'task-alert: close streams',
  );
}
