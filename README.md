# dsh-session-deleter — 会话彻底删除

> 仓库：<https://github.com/zhaokejin/dsh-session-deleter>
>
> 从源码安装：`git clone https://github.com/zhaokejin/dsh-session-deleter.git && cd dsh-session-deleter && npm pack && dsh plugin --profile desktop add ./dsh-session-deleter-*.tgz`

给 DeepSeek Harness（桌面端 / Web 端）加一个**手动删除会话**的功能：**直接从磁盘物理删除**，
不像 dsh 自带的那样只是「归档」（记录永远留在磁盘上）。

* 不改 `dsh` 本体源码，用官方插件机制（bundle + 设置卡片）
* 删除是**真的删文件**：会话记录目录 + 标题/用量投影缓存
* 删父会话时**级联删除它的子智能体会话**
* 桌面端与 Web 端通用

---

## 三个入口

**① 侧栏会话行**：鼠标悬停在会话上，行尾出现红色 **🗑**（在「归档」「置顶」图标旁边）
**② 会话顶部标题栏**：打开会话后，标题右边有 **🗑 删除** 按钮
**③ 设置 → 插件 → 插件配置 → 「会话彻底删除」**：批量列表，逐条删

## 效果

**设置 → 插件 → 插件配置 → 「会话彻底删除」**（在你自己的「启动动画」卡片下面，**默认收起，点一下卡片标题展开**）：

```
会话彻底删除
从磁盘物理删除会话记录

dsh 自带只能「归档」会话，记录会一直留在磁盘上。这里可以真正删掉。

只回复两个字：OK                    11/4/2026, 10:11:51 AM   🗑 删除
你在审查一个本地开源工具，· 子智能体    10/29/2026, 5:07:39 PM   🗑 删除
```

点「删除」会先弹确认框，删完自动刷新页面，侧栏里那条会话就没了。

---

## 安装

### Windows（tarball）

把 `dsh-session-deleter-0.5.0.tgz` 放到任意目录，在 **PowerShell / cmd** 里：

```powershell
dsh plugin --profile desktop remove dsh-session-deleter
dsh plugin --profile desktop add .\dsh-session-deleter-0.5.0.tgz
```

然后**重启 DeepSeek Harness**。

> tarball 安装会把依赖一起装进 profile 的 `node_modules`。
> 不要用本地目录软链安装（`link:`）——那会让 `@deepseek-ai/schemastery` 解析不到，
> bundle 被**静默跳过**（不报错，就是插件不生效）。

### macOS / Linux（npm 或 tarball）

```bash
dsh plugin --profile desktop add dsh-session-deleter      # 已在 npm 上
dsh plugin --profile desktop add ./dsh-session-deleter-0.5.0.tgz   # 或用 tarball
```

### 通用

```bash
# 桌面端 profile（Electron 用的那个）
dsh plugin --profile desktop add dsh-session-deleter

# Web profile（可选）
dsh plugin --profile web add dsh-session-deleter

# 卸载
dsh plugin --profile desktop remove dsh-session-deleter
```

装完**重启 App**。`dsh plugin add` 会自动把包名写进
`~/.dsh/profiles/<profile>/package.json` 的 `dsh.profile.bundles`。

### 没发到 npm 之前：直接用 tarball

```bash
npm pack                    # 在 pkg/ 里，产出 dsh-session-deleter-0.5.0.tgz
dsh plugin --profile desktop add ./dsh-session-deleter-0.5.0.tgz
```

tarball 安装会把依赖一起装进 profile 的 `node_modules`，**不会**出现软链导致的
「找不到 @deepseek-ai/schemastery → bundle 被静默跳过」。

### 发到 npm（公开，任何人可装）

```bash
npm login                                   # 需要你的 npm 账号
npm publish --access public                 # 包名 dsh-session-deleter 目前没人占用
```

发完之后任何机器（macOS / Windows / Linux）都能：

```bash
dsh plugin --profile desktop add dsh-session-deleter
```

## 跨平台（Windows / macOS / Linux）

Host 半侧按跨平台写的：

* Harness home 取自 Host 自己的 `profileContext.home`（Windows 上是 `C:\Users\<你>\.dsh`），
  不用硬编码路径
* 所有路径用 `path.join` / `path.basename` 拼，**不按 "/" 切字符串**（Windows 是反斜杠）
* **Windows 上文件被占用就不能删**：正在写入的会话日志是打开的，删除会 EBUSY。
  这时删除请求会写进 `~/.dsh/.session-deleter-pending.json` 队列，
  之后重试，**最迟下次启动 Host 时一定删掉**（那时没有文件被占用）。
  这条路径实测有效：

  ```
  写入 pending 队列 → 重启 App → 会话目录消失、队列文件清空
  ```
* 浏览器半侧是纯前端，三个平台完全一样

> 本地链接安装（`link:`）时，插件目录里需要有自己的 `node_modules`
> （在插件目录里 `pnpm install`），否则 pnpm 的软链会让 `@deepseek-ai/schemastery`
> 解析不到，bundle 会被静默跳过。

---

## 0.5.0：彻底消失（不只是归档）

「删除」之后会话必须**从所有地方消失**，而不是变成一条「已归档」。
一处漏掉都会留下一行、点开还会报 ENOENT。现在对**三个列表**都做了释放：

| 列表 | 症状（漏掉时） | 释放方式 |
|---|---|---|
| `session.list` 的 **live** 会话 | 文件没了、行还在；发消息报 `ENOENT: open .../session.v4.jsonl.zstd` | 停掉 agent（`cancel` + `whenIdle` + `scope.dispose`）→ 关掉写句柄 → 从 `ctx.sessions` / `ctx.agents` 摘除 → 触发 `session/disposed` → 客户端收到 `api-session/removed` |
| `session.list` 的**冷**会话 | 浏览器列表没刷新，行还在 | 删文件后**主动推送** `api-session/removed`，客户端立刻丢掉这一行 |
| 工作区注册表的 `sessionIds` | 归档会保留这个槽位（为了能取消归档）→ 行还在、挂着「已归档」 | `workspaceRegistry.detachSession()` 摘掉槽位 |

另外：

* **写句柄先关再删** —— Windows 上打开中的文件删不掉（EBUSY），先 `handle.close()`
* **归档只用来停工作**（`stopActivity:true` + 归档闸门挡住后续回合），删完再 `unarchiveSession` 把归档集清干净
* **自愈**：启动时发现「Host 还持有、但磁盘上已没有记录」的会话，整套释放跑一遍

实测（冷会话 + live 会话各一次）：

```
[cold-final-0001] 列表残留=false 文件残留=false workspace残留=false 归档残留=false
[live-final-0001] live: true
[live-final-0001] 列表残留=false 文件残留=false workspace残留=false 归档残留=false
```

## 0.3.0：Windows 可直接部署

只删文件是不够的。dsh 的 Host 会把会话**留在内存里**（live session），
于是会出现你遇到的现象：文件没了、列表还在、点发消息就报
`ENOENT: no such file or directory, open '.../session.v4.jsonl.zstd'`。

现在的删除流程是：

1. **先调官方的 `workspace.archiveSession({sessionId, stopActivity:true})`**
   → 停掉正在跑的工作、从所有分组视图隐藏、Host 的归档闸门拒绝再跑模型回合
   （所以不会再出现 ENOENT，只会说「已归档对话暂时无法查看」）
2. **再物理删文件**（会话记录目录 + 投影缓存，子智能体级联）
3. **把命令从设置文档里清掉**（`pendingDeletes` 写回 `[]`，
   否则每删一次就在 profile 里留一条垃圾记录，Host 重启还会重放）

另外 Host 侧还有一个**自愈**：启动时如果发现「Host 还持有、但磁盘上已经没有记录」的
会话（例如用旧版本删过），会自动把它归档，让它从列表里消失、不再报错。

## 它到底删了什么

```
~/.dsh/sessions/<工作区slug>/<session-id>/
    session.v4.jsonl.zstd      ← 完整对话记录（zstd 压缩的 jsonl）
    session.lock
~/.dsh/storages/session_projcache/sessions/<session-id>.json   ← 标题/用量投影缓存
```

* 子智能体会话（记录头里 `origin: "subagent"` + `parentSession`）会被**递归一起删掉**
* 投影缓存必须一起删，否则列表里会残留空标题
* **不可恢复**，请确认后再点

---

## 配置

**设置 → 插件 → 「会话彻底删除」卡片顶部有配置区**，勾选即时生效（不用重启）：

| 选项 | 默认 | 作用 |
|---|---|---|
| 删除前询问确认（显示会话名） | 开 | 关掉后点删除直接执行，不弹确认框 |
| 删除父会话时一并删除子智能体 | 开 | 关掉后只删父会话，子智能体会话留下 |
| 侧栏行显示删除按钮 | 开 | 关掉后侧栏会话行不再出现 🗑 |
| 标题栏显示删除按钮 | 开 | 关掉后会话标题旁不再出现 🗑 |
| 文件占用重试次数 | 5 | Windows 上文件被占用时的重试次数（1–20） |

也可以直接编辑 `~/.dsh/profiles/desktop/cordis.patch.yml`：

```yaml
- id: session-deleter
  config:
    deleteSubagents: true        # 删父会话时是否连带删子智能体
    confirmBeforeDelete: true    # 删除前是否弹确认框
    showRowButton: true          # 侧栏行删除按钮
    showHeaderButton: true       # 标题栏删除按钮
    deleteAttempts: 5            # Windows 占用重试次数
```

`pendingDeletes` 是内部用的命令通道，一般不用碰。

---

## 原理（源码依据）

浏览器半侧不能碰文件系统，也没有自己生成的 Remote 命名空间，所以两端通过**这个插件自己的
设置命名空间**通信：

```
浏览器 → Host : 写 pendingDeletes: ["<sessionId>#<nonce>"]
Host          : 删文件，然后把那个 token 记下来，永不重放
```

* 命名空间 = 插件条目 id（`cordis.patch.yml` 里的 `id: session-deleter`），
  由 `dsh-settings` 从条目的 `Config`（schemastery + `.volatile()`）派生
* 浏览器写设置用 `remote.settings.describe()` + `remote.settings.mutate(ns, ops, revision)`，
  Remote 的返回值是 `{ ok, value }`，命名空间列表在 `value.namespaces` 里
* Host 半侧用普通 Node 定时器轮询（不用 `ctx.setInterval`，那需要注入 `timer` 服务，
  会让插件卡在 PENDING），并在 `loader/volatile-update` 时立即处理
* 浏览器半侧注册到 `plugins.item` 槽位（设置页插件卡片），
  服务依赖用 `ctx.inject([...], cb)` 动态形式，缺服务不会拖垮整个 fiber

关键文件：

```
pkg/entry.js        Host 半侧：找会话目录、读记录头、删文件、级联子智能体
pkg/lib/client.js   浏览器半侧：设置卡片、会话列表、删除按钮、调试钩子
pkg/cordis.patch.yml  把插件插进 profile 树的那一行
```

---

## 已验证（0.2.5）

```
before: 文件存在 = true
delete: accepted:session-72730546-...#1793764929060
after 4s: 文件存在 = false
归档集合: ["session-72730546-4ed6-4a31-8466-b6d604f6fc76"]   ← 已归档，列表不再显示
pendingDeletes 已清空: true                                  ← 命令队列自动清理
```

## 调试钩子

页面控制台里可以直接删：

```js
// 删一个会话
await window.__DSH_SESSION_DELETER__.delete('<session-id>')

// 看 Host 提供的命名空间
await window.__DSH_SESSION_DELETER__.describe()
```

---

## 自测（已跑通）

```bash
# 造一个假会话记录 → 让插件删 → 检查文件是否消失
# 桌面端：带 DevTools 端口启动
"/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" --remote-debugging-port=9335
```

实测结果：

```
before: dir exists = true
delete: "accepted:test-session-deleter-electron-01#1793761990714"
after 3s: dir exists = false | projection exists = false

# 级联：删父会话 → 子智能体也跟着没了
before: parent = true child = true
after 3.5s: parent = false child = false
```
