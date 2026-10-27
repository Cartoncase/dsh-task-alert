# 发布指南：GitHub + npm + DSH 插件市场

这份文档对应本仓库的现状（仓库根就是插件包）。按顺序做即可。

---

## 0. 先确认仓库已经是市场要的样子

DSH 社区插件市场（[dsh-plugin.org](https://dsh-plugin.org/zh/submit)）的自动扫描要求，逐条对照：

| 要求 | 本仓库 |
|---|---|
| 公开仓库 | 待你建 |
| 根目录有 `package.json`（写明包名和版本） | ✅ `dsh-task-alert@0.2.0` |
| 导出 `apply(ctx)` 模块 | ✅ `index.js` 的 `export function apply` |
| README 里有安装命令 `dsh plugin --profile web add <包名>` | ✅ README「装」一节 |
| 声明开源许可证 | ✅ `LICENSE`（MIT） |
| 仓库加 GitHub topic `dsh-plugin` | 待你在仓库设置里加 |

另外，`.gitignore` 已经排除 `node_modules/`；`package.json` 的 `files` 白名单只发
`index.js / client.js / cordis.patch.yml / icon.svg / README.md`，`test/`、`scripts/` 不会进 npm 包。

---

## 1. 发到 GitHub

> **一条命令做完「填清单链接 + 提交 + 配 remote」**（可选，省得手抄）：
>
> ```powershell
> powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\publish.ps1 -Owner <你的GitHub用户名>
> ```
>
> 加 `-Push` 会顺手 `git push -u origin main` 并推 tag；加 `-Publish` 会在已 `npm login` 的前提下顺手 `npm publish`。
> 脚本用 Node 改 `package.json`（避免 PowerShell 5.1 把中文描述写坏），只补
> `repository` / `homepage` / `bugs` 三个字段。

手做也可以（仓库已经 `git init` 并提交过一次，这段是给「从零再来一遍」看的）：

```powershell
cd <克隆下来的仓库目录>
git init
git add .
git commit -m "feat: 任务完成 / 待审批提醒插件 v0.2.0"
git branch -M main
git remote add origin https://github.com/<你的用户名>/dsh-task-alert.git
git push -u origin main
```

然后去仓库页面：

1. **About → Topics** 加 `dsh-plugin`（也建议加 `deepseek-harness`、`cordis-plugin`、`notification`）。
2. About 的 Description 写一句话价值，例如：`DSH 任务完成 / 等待审批时弹窗 + 系统通知，后台也不漏`。
3. 打一个 release（`v0.2.0`），方便别人按 tag 引用。

> 截图很重要：市场页和 README 都靠它证明插件真能用。建议截两张——前台弹卡片、后台系统通知——
> 放到 `assets/` 下，在 README 里引用。

---

## 2. 发到 npm

**想在 DSH 应用内的「插件中心」显示，必须有 npm 包**（市场只展示能用
`dsh plugin --profile web add <包名>` 一键装上的插件）。

```powershell
cd <克隆下来的仓库目录>
npm login                      # 没有账号先去 npmjs.com 注册
npm pack --dry-run             # 先看会打包哪些文件（应该只有 6～7 个）
npm publish --access public
```

发布前确认：

- `package.json` 的 `name` 没被占用（`dsh-task-alert` 若被占，改成 `@你的名字/dsh-task-alert`，安装命令随之变化）；
- `version` 已递增（npm 不允许覆盖同版本）；
- `files` 白名单里没有 `test/`、`scripts/`。

发完之后别人就能装：

```sh
dsh plugin --profile web add dsh-task-alert
```

---

## 3. 上架 dsh-plugin.org（社区市场）

规则（来自其[提交页](https://dsh-plugin.org/zh/submit)）：免费、需人工/自动审核一轮，收录后定期刷新 Star / 更新时间 / README。

三步：

1. 公开仓库 + README（上面第 1 步已完成）；
2. 加 topic `dsh-plugin`；
3. 去 [dshplugin/dsh-plugin-hub](https://github.com/dshplugin/dsh-plugin-hub/issues/new) 按模板提一个 Issue：

```
### 仓库地址
https://github.com/<你的用户名>/dsh-task-alert

### 一句话价值
DSH 任务跑完 / 卡在审批时提醒你：前台弹卡片，窗口在后台发 Windows 系统通知，再也不会漏。

### 能力分类
界面与体验

### 安装命令
dsh plugin --profile web add dsh-task-alert

### 兼容与运行要求
DSH 0.2.x（desktop / web profile），Windows / macOS / Linux 浏览器端

### 许可证
MIT

### 截图 / 演示
<两张截图链接>
```

收录之后，把徽章贴到 README 顶部（把 `your-owner` / `your-plugin-slug` 换成详情页里的值）：

```markdown
[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/your-owner/your-plugin-slug)
```

---

## 4. 其它社区市场

DSH 生态里不止一家，规则大同小异（公开仓库 + topic + README + npm），可以都提交一遍：

| 市场 | 备注 |
|---|---|
| [DSH-Store](https://github.com/ysr666/DSH-Store) | 第三方插件市场 + 受控生命周期管理器。它的预检比较严格，会按包名核对 `cordis.patch.yml` 里的 entry id（这也是本仓库把 `id` 写成 `dsh-task-alert`、和包名一致的原因） |
| [WhaleHub](https://raw.githubusercontent.com/lak321/dsh-filetree/039700268865a86c1455820831e55892f8d7775c/docs/whalehub-submission.md) | 有独立的提交规范文档 |
| [awesome-dsh-plugin.com](https://awesome-dsh-plugin.com) | 清单式收录，兼容 [awesome](https://github.com/sindresorhus/awesome) 风格 |
| [dshbase.com](https://dshbase.com/zh/) | 插件目录站 |

通用原则：**entry id 与包名保持一致**（`package.json.name` === `cordis.patch.yml` 的 `id`），
并且 `cordis.patch.yml` 里 `id:` 那一行不要写行尾注释——预检脚本用正则抓那一行。

---

## 5. 兼容性声明怎么选（重要）

DSH 启动前会检查插件声明的目标版本（`dsh-app-boot` 的规则）：

- 写了 `engines.dsh` → **只**看这个范围，`peerDependencies` 被忽略；
- 没写 `engines.dsh` → `peerDependencies` 里每个 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 范围都要匹配；
- **两者都没有 → 不施加任何约束**。

本插件宿主半边不 import 任何 `@deepseek-ai/dsh-*`（只用 cordis 的 `ctx`），所以两个都没写——
好处是 DSH 升级不会被兼容性检查挡掉；代价是别人看不到你测过哪些版本。

想显式声明（更专业，但需要你逐版本维护）：

```json
"engines": { "dsh": ">=0.2.1 <0.3.0" }
```

或者像 dsh-pet 那样按版本记录：

```json
"dsh": { "compatibility": { "dshReleases": { "0.2.1-rc.3": "compatible" } } }
```

> 注意：声明了就必须维护。范围写错、写成空字符串、或 `engines.dsh` 用了 `workspace:` 值，
> 都会被判为 incompatible 而**跳过加载**。

浏览器半边另有一条硬要求：`package.json` 里 `dsh.client.platform` 必须是 `"web"`，
且 `exports` 必须有 `./client`——否则插件包会被模块系统拒绝。

---

## 6. 被打回的常见原因

来自市场的 FAQ，和本仓库的对应关系：

| 原因 | 本仓库 |
|---|---|
| 仓库不公开 / 没加 `dsh-plugin` topic | 你来做 |
| 根目录缺 `package.json` | ✅ 已在根目录 |
| README 缺安装命令 | ✅ 已写 |
| 没导出 `apply(ctx)` | ✅ |
| 收录了但「插件中心」搜不到 | 因为没发 npm —— 见第 2 步 |
| 被标 `unconfirmed` | 所有新插件的初始状态，完善 README 后等人工复核 |

---

## 7. 发布后自己验一遍

```powershell
# 1) 用 npm 上那份装（换一台机器或先卸载本地这份）
dsh plugin --profile web add dsh-task-alert

# 2) 宿主半边起来了没
Invoke-WebRequest http://127.0.0.1:61948/task-alert/health -UseBasicParsing | % Content

# 3) 浏览器半边起来了没：health 里 streams 应 ≥ 1（页面连上了 SSE）
# 4) 打开 设置 → 任务提醒 → 试一下，前台应该弹卡片；把 DSH 切到后台再点一次，应该出系统通知
```

---

## 参考

- [dsh-plugin.org 提交页](https://dsh-plugin.org/zh/submit)（收录要求与模板）
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- [dsh-plugin-authoring](https://github.com/lishuo4096/dsh-plugin-authoring)（第三方整理的 DSH 插件写作/发布资料）
- [DSH-Store](https://github.com/ysr666/DSH-Store)
