# Changelog

本项目的版本记录。格式大致遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循语义化版本（`0.x` 阶段：`minor` 可能带破坏性改动）。

## [0.2.4] — 2026-10-27

### Added

- **回到 DSH 自动收起弹窗**：窗口重新获得焦点（`focus`）或页面重新可见（`visibilitychange`）时，
  把还挂着的卡片全部收掉，不用等倒计时。配置项 `dismissOnFocus`（默认 `true`），
  出现在设置页与卡片快捷设置里。

### Fixed

- **超出上限会一次清空所有卡片**：`trimCards` 按 DOM 节点数判断超限，而卡片关闭有 170 ms 出场动画、
  节点不会立刻消失，导致第 6 张卡到达时循环停不下来、把全部卡片一起丢掉。改为只统计"还开着"的卡片。

## [0.2.3] — 2026-10-27

### Added

- **提醒写清"哪个项目、哪次对话"**：帧新增 `project`（会话工作目录末级目录名，与侧栏分组一致）
  与 `titleSource`（标题取自哪条路径，用于排查）；卡片和系统通知都显示
  `项目：… · 会话：… · 工具：…`。

### Fixed

- **会话标题取不到**：标题并不在 `session.header` 上。改为从会话日志折叠 `session/title` 事件的
  `data.title`（`dsh-session` 的 `commit()` 以 `[session, event]` 通知观察者，`snapshotEvents()` 可达），
  事件缓存与 `sessionTitle` 服务降为兜底。取不到时才显示「本轮对话」，不再把会话 id 甩给用户。

## [0.2.2] — 2026-10-27

### Fixed

- **`/health` 自报版本号写死**：0.2.1 的包对外报 `0.2.0`。改为从 `package.json` 读取，
  并把"版本一致"加进打包冒烟测试。

## [0.2.1] — 2026-10-27

（未单独发布的过渡版本，内容并入 0.2.2。）

## [0.2.0] — 2026-10-27

### Added

- **设置页入口**：向 `settings.section` 插槽注册「任务提醒」一节（静态依赖 `slots`，
  与官方 `ui-approval`、`dsh-pet` 同一套写法）。
- **配置文件**：`$DSH_HOME/dsh-task-alert/config.json`，`GET/POST /task-alert/config` 读写；
  首次运行自动落盘默认值。数值越界钳位、坏 JSON 回落默认。
- **四类提醒各自开关**：完成 / 失败 / 截断 / 待审批；总开关 `enabled`。
- **卡片节奏**：`dismissSeconds`（0 = 不自动关）、`maxCards`。
- 开关改动**立即生效**（本地优先生效，不等一次往返）。

### Fixed

- 被配置挡掉的提醒帧不再消耗 `seq`（否则补帧游标会跳号）。

## [0.1.0] — 2026-10-27

首个可用版本。

### Added

- 宿主半边监听 `session/event`（`turn/end` / `approval/asked` / `approval/decided`）与 `agent/error`，
  生成提醒帧并通过 **SSE**（`/task-alert/events`）推给页面——后台标签页的定时器会被节流，长连接不会。
- 浏览器半边：右上角弹卡片；窗口在后台时发 Windows 系统通知；点击通知/卡片可切到对应会话。
- 子代理与委派会话不提醒；`aborted` / `interrupted` 不打扰。
- 断线后经 `/task-alert/pending?since=<seq>` 补最近 3 条，不刷屏。
