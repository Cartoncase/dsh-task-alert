# dsh-task-alert

[![npm](https://img.shields.io/npm/v/dsh-task-alert?color=blue)](https://www.npmjs.com/package/dsh-task-alert)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-6b5bd2)](https://github.com/deepseek-ai/deepseek-harness)

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）做的**任务提醒插件**：
一轮任务跑完、生成失败、输出被截断、**或者有操作等你批准**的时候，在页面右上角弹一张卡片；
当 DSH 窗口在后台（被别的窗口盖住 / 最小化）时，同时发一条 **Windows 系统通知**。

解决的问题很具体：DSH 被丢在后台的时候，你不知道它已经跑完了，也不知道它正卡在审批上等你点。

## 装

包发布到 npm 之后（一行）：

```sh
dsh plugin --profile web add dsh-task-alert
```

本地开发/自用（本仓库自带脚本，装进桌面版的 profile，幂等、会先备份清单）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

装完重启 DSH。验证宿主半边起来了：

```powershell
Invoke-WebRequest http://127.0.0.1:61948/task-alert/health -UseBasicParsing | % Content
# {"ok":true,"seq":0,"streams":1,"version":"0.2.0",...}
```

## 在哪里设置

有四个入口，改的是同一份配置：

| 入口 | 适合 |
|---|---|
| **DSH 设置 → 任务提醒** | 全部选项（推荐）。注册在 `settings.section` 插槽里 |
| **弹窗卡片上的「设置」** | 弹窗正好在眼前时的快捷开关 + 保留秒数 |
| **配置文件** `$DSH_HOME/dsh-task-alert/config.json` | 手改，下次读取/重启生效 |
| **控制台** `__dshTaskAlert.config()` / `.settings()` | 调试 |

> 修改后**立即生效**：页内卡片按新值渲染，宿主的类别过滤也在保存那一刻开始生效（不必重连、不必刷新）。

## 配置项

`$DSH_HOME/dsh-task-alert/config.json`（默认 `~/.dsh/dsh-task-alert/config.json`）：

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `notifyApproval` | `true` | 有操作等我批准时提醒 |
| `notifyDone` | `true` | 一轮对话跑完时提醒 |
| `notifyError` | `true` | 生成失败时提醒 |
| `notifyTruncated` | `true` | 输出触到上限被截断时提醒 |
| `inPage` | `true` | 页面右上角弹卡片 |
| `osNotification` | `true` | 窗口在后台时发系统通知（Windows 原生 toast） |
| `sound` | `true` | 播放提示音（审批两声、其余一声） |
| `raiseWindow` | `true` | 点系统通知后把 DSH 窗口叫到前台 |
| `dismissSeconds` | `12` | 卡片保留几秒后自动关闭；`0` = 不自动关闭（审批卡永远常驻） |
| `maxCards` | `5` | 最多同时显示几张卡片（1–10，超出丢最旧的） |

数值字段越界会被**钳位**而不是报错（`dismissSeconds` 0–600、`maxCards` 1–10），
配置文件写坏（坏 JSON）会回落到默认值——配置问题不该让插件罢工。

## 提醒什么

| 场景 | 页内卡片 | 系统通知 | 说明 |
|---|---|---|---|
| 一轮对话正常结束 | ✅ | ✅ 仅后台时 | `turn/end` + `completed` |
| 生成失败 | ✅ | ✅ 仅后台时 | `turn/end` + `error`、`agent/error` |
| 输出被截断 | ✅ | ✅ 仅后台时 | `turn/end` + `max-tokens` |
| **等待审批** | ✅ 常驻 | ✅ 仅后台时 | `approval/asked`；`approval/decided` 后自动收卡 |
| 用户主动取消 / 崩溃恢复 | ❌ | ❌ | `aborted` / `interrupted` 是你的操作，不打扰 |

子代理、委派会话（`origin=subagent` 或 `delegationDepth>0`）**不提醒**——你等的是主对话。
判据取不到时放行：宁可多弹一条，也不因为宿主换字段让提醒整体失效。

## 为什么在后台也能收到

页面用 **SSE**（`/task-alert/events`，服务端推流）接收提醒，不是定时器轮询：
浏览器会把后台标签页的 `setInterval` 节流到大约一分钟一次，而那正是"窗口在后台"这个场景本身。
SSE 是长连接，不受定时器节流影响。断线（页面被冻结、DSH 重启）后切回来会走
`/task-alert/pending?since=<seq>` 补最近 3 条，不刷屏。

## 交互

- 卡片：右上角堆叠，`maxCards` 上限，超出丢最旧的；鼠标悬停时暂停倒计时。
- **查看会话**：切到发出这条提醒的会话（走 DSH 的 `uiWorkspace.openSession`）。
- **×**：立刻关掉。
- 系统通知点一下：切会话 + 把窗口叫到前台（Electron 里发一次 `dsh://open`）。

## HTTP 路由（宿主半边）

| 路径 | 用途 |
|---|---|
| `GET /task-alert/events` | `text/event-stream` 实时推帧，15 秒心跳，首帧带当前配置 |
| `GET /task-alert/pending?since=<seq>` | 断线重连补帧 |
| `GET /task-alert/config` | 当前配置 + 配置文件路径（会重读磁盘） |
| `POST /task-alert/config` | 保存配置（部分字段即可，自动校验钳位） |
| `GET /task-alert/health` | 存活探测（重启后用它确认插件起来了） |
| `GET /task-alert/test` | 造一条测试提醒（设置里的「试一下」，绕过类别开关） |

## 结构

```
package.json          # 包清单：main=index.js（宿主半边）、exports["./client"]（浏览器半边）、dsh.client.platform=web
cordis.patch.yml      # bundle patch：把 id=name=dsh-task-alert 这一行插进配置树
index.js              # 宿主半边：宿主事件 → 提醒帧 → SSE / JSON 路由；配置落盘与过滤
client.js             # 浏览器半边：__ModuleLoader__.load 注册 cordis 插件 → 卡片 / 系统通知 / 设置页那一节
icon.svg              # 插件图标（插件管理页显示）
scripts/install.ps1   # 装进本机 DSH profile（复制 + 登记 bundle）
test/*.test.mjs       # 离线自测
```

宿主半边只依赖 `webServer` 服务，不 import 任何 `@deepseek-ai/dsh-*` 模块，
因此不声明 `peerDependencies`、也不写 `engines.dsh`——不会被 DSH 版本兼容性检查挡住。

## 自测

```powershell
node .\test\host.test.mjs      # 假 cordis ctx：事件 → 配置过滤 → 帧 → HTTP/SSE
node .\test\client.test.mjs    # 最小 DOM 桩：配置 → 帧 → 卡片 / 通知 / 设置页注册 / 清理
```

两个都是纯离线测试，不需要 DSH、不联网；host 那份用临时目录当 `DSH_HOME`，不碰真实配置。

`npm test` 跑的就是这两个，`npm publish` 前会经 `prepublishOnly` 自动跑一遍——测试不过发不出去。

发布前还建议验一次「**打包产物**能不能加载」（不是仓库目录，而是 npm 真正发出去的那份）：

```powershell
npm pack --pack-destination $env:TEMP
tar -xzf $env:TEMP\dsh-task-alert-0.2.2.tgz -C $env:TEMP
node .\test\pack-smoke.mjs $env:TEMP\package   # 清单字段 / entry id / 客户端可编译 / 宿主能起 / 配置落盘 / 版本自报
```

## 已知限制

- 同一台机器开多个 DSH 页面时，每个页面各弹一次（每页一条 SSE）。桌面版只有一个页面，不受影响。
- 系统通知依赖 Windows 通知权限；权限没给时只有页内卡片（卡片上的「开启」按钮可以补授权）。
- 卡片显示的是 DSH 给会话起的名字（`session/title` 事件 / `sessionTitle` 服务）。极少见地取不到时显示「本轮对话」，不会把会话 id 甩给用户。

## 发布

见 [PUBLISHING.md](PUBLISHING.md)：GitHub 仓库怎么建、npm 怎么发、社区插件市场怎么收录。

## 许可证

[MIT](LICENSE)
