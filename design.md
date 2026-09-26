# Event Logger 设计文档

> 本文档描述系统的**设计意图与不变量**，不是 API 手册。改代码前先读 §3（数据模型）、§4（分层）、§11（不变量清单）。
> 最近更新：2026-09-24

---

## 1. 概览

一个**单人自用**的每日时间记录工具：把一天切成 10 分钟一格，用拖拽记录"什么时间做了什么"，再按类别（工作 / 生活 / 学习）做统计与趋势。它可以部署在公网，但**服务器上不存放任何用户数据**——页面是公开的静态文件，数据只活在打开它的那个浏览器里。

### 设计目标

| 目标 | 落地方式 |
|---|---|
| 录入成本接近零 | 时间轴拖拽建事件 + 模板一键回填 |
| 公网可访问，但服务器不知道你是谁 | 纯静态托管 + 全站无写接口；数据在浏览器 IndexedDB（§2、§5） |
| 数据完全自主 | 导出/导入即迁移，可选把每份历史版本镜像到本地文件夹 |
| 一屏之内并存多套"周口径" | EventBook：每本书自带 `weekStartsOn` 与 `language`（§3.3） |
| 改错了能回退 | 追加式快照链 + 只读回放 + 不可逆恢复（恢复前先存当前）（§5） |
| 业务规则可测试 | 业务全部下沉到不依赖 React 的纯函数层，`scripts/check-*.mjs` 在 Node 里直接跑 |

### 明确非目标

多用户 / 鉴权 / 账号体系 / 跨设备实时同步 / 数据库 / 协作 / 移动端适配 / 秒级精度。这些不是遗漏，是取舍——见 §12。

---

## 2. 技术栈与系统架构

| 层 | 选型 | 备注 |
|---|---|---|
| 前端 | React 18 + Vite 6 | 无路由、无状态库、无 UI 组件库、无 CSS-in-JS |
| 图表 | recharts（随 `StatsPanel` 的 `React.lazy` 自动切包） | 饼图 + 堆叠柱状图 |
| 持久化 | **浏览器 IndexedDB**（库 `event-logger`，版本 1，4 个 store） | 唯一真源，见 `src/storage/idb.js` |
| 历史版本 | 同库 `snapshots` store 的追加式快照链 | 分层淘汰 + 保护位，`src/storage/snapshots.js` |
| 跨标签页 | `BroadcastChannel` 单写者锁 | `src/storage/bus.js` |
| 可选镜像 | File System Access API → `EventLogger Backups/` | `src/storage/folderBackup.js`，只写不读 |
| 离线 | `vite-plugin-pwa`（Workbox，`autoUpdate`，`injectRegister: 'script'`） | `injectRegister` 用 `inline` 会塞第二段内联脚本，CSP 不允许；每个构建带 `BUILD_ID`（`<html data-build>` + 设置对话框页脚），用来分清「旧壳」和「新构建」 |
| 托管 | Cloudflare Pages（纯静态 + `public/_headers` 的 CSP） | `npm run deploy` |
| 本地 | Express 4（`server.js`，34 行） | 只发静态文件 + 只读 `GET /api/legacy-data` |

```
浏览器（唯一持有数据的地方）
 ├─ React UI ─► hooks（唯一 I/O 边界）─► src/storage/* ─► IndexedDB event-logger@1
 │                                                               ├─ books / data / snapshots / meta
 ├─ BroadcastChannel("event-logger:bus") ◄─► 同站其它标签页（单写者锁 + rev 失效通知）
 ├─ File System Access API ─► EventLogger Backups/<书名>/…（可选镜像）
 └─ Service Worker ─► 预缓存 shell，断网可开
──────────────────────────────────────────────────────────────────────────────────
Cloudflare Pages：只有 dist/ 里的静态字节。没有数据库、没有会话、没有任何上传口。
```

**核心架构决策：胖前端 + 零持久化后端。**

后端（也就是没有后端）不做任何业务、校验、聚合或合并，连"存一个 JSON"都不做。因此：

- 公网发布不需要鉴权、不需要备份责任、没有数据泄露面——攻击面等于一个静态网站；
- 并发写仲裁从"服务器"搬到了浏览器内部（`rev` + 单写者锁）；
- 代价是数据天然单机：换设备只能靠导出/镜像（§12 第 1 条）。

开发模式下 Vite 跑在 5173，并把 `/api` 代理到 3002——那条链路只为"从旧版 `data.json` 迁移"服务，前端在非 localhost 域名下会直接跳过探测（`src/utils/legacyFetch.js`）。

---

## 3. 数据模型

三个顶层对象，对应 IndexedDB 四个 store 里的三个（第四个是 `meta`，见 §4.4）：

```jsonc
// books —— 一行 = 一本 EventBook（keyPath: id）
{
  "id": "uuid",
  "name": "2026 工作簿",          // ≤40 字符，sanitizeBookName 清洗：去控制符/折叠空白/文件名安全
  "settings": {
    "weekStartsOn": 1,            // 0=周日 … 6=周六 ★ 这本书的周口径
    "language": "zh",             // zh | en | ja    ★ 这本书的界面语言
    "timelineStart": 36,          // 时间轴视口起始槽位
    "timelineEnd": 144,           // 0 ≤ start < end ≤ 144
    "statsScope": "month"         // day | week | month | year
  },
  "createdAt": 1790000000000, "updatedAt": 1790000001000
}

// data —— 一行 = 一本书的当前内容（keyPath: bookId）
{ "bookId": "uuid", "events": [ … ], "templates": [ … ], "rev": 12, "updatedAt": 1790000002000 }

// snapshots —— 一行 = 一个历史版本（keyPath: id = `<bookId>:<createdAt>:<rand>`）
{
  "id": "…", "bookId": "…", "createdAt": 1790000003000, "iso": "2026-09-24T04:23:51.735Z",
  "reason": "interval",           // interval | startup | manual | import | pre-restore | restored-from
  "protected": false,             // 与 PROTECTED_REASONS 严格一致，淘汰永不删它
  "hash": "27e15d2e75ba0efe.179", // canonicalPayload 的指纹 + 字节数，用于去重
  "bytes": 179, "eventCount": 1, "templateCount": 0,
  "note": "被恢复的快照 id",       // 仅 pre-restore / restored-from
  "payload": { "events": [ … ], "templates": [ … ] }   // 完整内容，可独立回放
}
```

`events` / `templates` 的行内结构沿用旧版（`id` / `name` / `category` / `date` / `startSlot` / `endSlot` / `templateId`；模板带可选 `createdAt` / `updatedAt`），**这一层本轮没有动**——旧 `data.json` 因此能整包导入，`rev` 从 1 起步。

导出信封是 `v2`（`src/storage/legacy.js` 的 `toV2Envelope`）：`{ version: '2.0', books: [{ book, data, snapshots }] }`；`detectEnvelope` 同时认旧版单书裸 `{settings,events,templates}` 与 v1 信封，所以历史导出文件仍可导入。

### 3.1 槽位（slot）时间模型 —— 全系统的地基

一天 = **144 槽**，`SLOT_MINUTES = 10`（`src/utils/time.js`）。

```
slotToTime(45) === '07:30'      timeToSlot('07:30') === 45
slotDuration(a, b) === (b - a) * 10   // 分钟
```

**区间一律半开 `[startSlot, endSlot)`**，由此获得四个"不需要 ±1 修正"的表达：

| 语义 | 公式 |
|---|---|
| 时长 | `end - start` |
| 重叠 | `a.start < b.end && a.end > b.start` |
| 相邻不重叠 | `a.end === b.start` |
| 渲染偏移 | `top = (start - baseSlot) * SLOT_HEIGHT` |

跨午夜、零长事件、边界判断都因此退化成整数比较。

最后一行也说明第二个决策：**数据层只存槽位，像素只存在于渲染层**。所以"只看 06:00–24:00"这类视口缩放是纯 UI 行为，永远不动数据。

代价：精度锁死在 10 分钟。这是刻意的——它同时保证了拖拽吸附手感。

### 3.2 实体关系

- **EventBook → (live 数据 + 快照链)**：1:N 强绑定。删除 EventBook 连带删它的全部快照（`removeBook`），镜像文件夹目录一并移除。
- **Template ← Event**：事件软引用 `templateId`。删除模板**不级联**清引用，读取侧容忍悬空 ID。
- 日期键是**字符串**而非时间戳，避免整条链路上的时区换算。

### 3.3 EventBook 的"周口径"不变量

- `settings.weekStartsOn` 是这本书**唯一**的周口径来源。周视图列序、日历表头、统计区间与分桶、周号标签、相对时间"本周"全部由它派生。
- 归一化入口只有一个：`normalizeWeekStart`（`src/utils/time.js`）/ `normalizeSettings`（`src/storage/books.js`）。任何组件**不得**自己 `getDay()` 推周起始。
- `LANG_WEEK_START = { zh: 1, en: 0, ja: 1 }` 只用于**新建一本书时给个符合语言的默认值**，写完即与语言脱钩：之后改语言不会改周口径，反之亦然。
- `week:check`（`scripts/check-week-start.mjs`）用 15372 组周窗口 + 2196 组 ISO 周号把这条钉死。

---

## 4. 前端架构

### 4.1 分层

```
src/
├─ components/   展示 + 交互（Timeline 最大，766 行；Workspace 是唯一的"页面"）
├─ hooks/        状态所有权 + 持久化边界（useBooks / useBookData / useBackupFolder / useBookTransfer …）
├─ storage/      持久化适配层：idb（唯一碰 indexedDB 的模块）· books · snapshots · bus · folderBackup · legacy
├─ utils/        纯函数：时间/槽位、缩放夹紧、跨日期落点、统计、类别、排序引擎、时间戳、体积格式、legacy 探测
├─ i18n/         core（纯函数）+ index.jsx（Provider）+ format.js（Intl）+ locales/{zh,en,ja}.js
└─ styles/       global.css：CSS 变量 + reset + 拖动态光标类
```

### 4.2 依赖方向是硬约束

```
components ──► hooks ──► storage（纯函数 + IDB 读写） ──► idb.js
     │           └────► utils ──► i18n/core
     └──────────────► utils / i18n/index（仅 useI18n）
```

两条新规矩：

1. **组件只能 import storage 层的纯函数**（`REASONS`、`formatBytes` 一类常量/谓词），任何 IDB 读写必须经过 hooks。这条决定了 `scripts/check-book-store.mjs`、`check-snapshot-policy.mjs` 能在 Node 里直接 import 被测代码。
2. `i18n/core.js` **刻意不 import React**，`utils/templateSort.js` 反向 import 它。纯函数层可以脱离组件树被 Node 直接执行——所有 `check-*.mjs` 依赖这一点。**新增纯函数时请保持此约束。**

还有一条由工具守着的：**用了 React 具名 API 就必须显式 import**。Vite/esbuild 不解析模块作用域，漏 import 在 dev 里可能照常跑，线上一挂载就 `ReferenceError` 白屏，且 CSP 与构建都不报警（真实事故：`useBookTransfer.js` 忘了 import `useCallback`）。`npm run imports:check` 就是防这个。

### 4.3 状态所有权与单向数据流

```
组件操作 → 本地 state 立即变（UI 零延迟）
         → useEvents / useTemplates 通过回调上报
         → useBookData 写进 eventsRef / templatesRef
         → 500ms 防抖 → writeLiveData(bookId) → rev+1 → BroadcastChannel 通知
         → 同时：够条件才 maybeSnapshot（≥15min）/ 镜像文件夹 latest.json（≥60s）
```

| Hook | 独占的东西 | 写入节流 |
|---|---|---|
| `useBooks` | 书列表、`activeBookId`、派生 `activeBook`、`settingsOpenFor`（该给哪本书开设置弹窗） | 设置 400ms 合并写 |
| `useBookData` | 当前书的 live 数据、快照链、单写者锁、预览(回放)态、配额、`loadedRef` 守门 | 数据 500ms |
| `useBackupFolder` | File System Access 句柄与权限状态 | 镜像 latest 60s 节流 |
| `useBookTransfer` | 导出/导入编排（v2 信封、防撞名） | 导出前强制 flush |
| `useEvents` / `useTemplates` | 各自一块数组 + CRUD | 变更即上报 |
| `Workspace` | 跨组件共享的 UI 状态：选中日期、弹窗开关、剪贴板、统计档位 | 不落盘 |

`useBookData` 是全站唯一允许触碰持久化的 hook（沿用旧 `usePersistentData` 的所有权边界，`usePersistentData.js` 已删除）。

两个易被忽略的门：

- `loadedRef`（§5 第 1 道兜底）：LOAD 未 apply 前一律不许写。
- `Workspace` 的 `key = book.id` + `App` 用 `bookData.loading` 挡住渲染 —— 换书必然整棵重挂载，所以 `useEvents` 里那个"只允许第一次从 props 同步"的 `initialized` 才没成为 bug。这两个门必须成对存在，拆掉任一个都会让旧书内容留在新书界面上。

### 4.4 "跨设备的数据" vs "本机偏好"的分界线

| 存哪里 | 内容 | 理由 |
|---|---|---|
| IndexedDB `books` | 书名、每本书的周开始日/语言/视口/统计档位 | 属于"这本书"，导出即带走 |
| IndexedDB `data` / `snapshots` | 事件、模板、历史版本 | 用户数据本体 |
| IndexedDB `meta` | 只有备份文件夹句柄（`backupDirectory`） | 本机但要跨会话；不是用户内容 |
| `localStorage` | 模板排序偏好 `event-logger:template-sort`、上次看的书 `event-logger:active-book`、语言缓存 `event-logger:lang` | 纯本机 UI。丢了不伤数据：换浏览器最多"回到第一本书、用浏览器语言" |

排序 store 的实现方式值得注意：模块级 `state` + `listeners` Set + `useSyncExternalStore`，于是两个弹窗天然共享同一份偏好，**不需要把 props 从 `App` 一路穿下去**；同时监听 `storage` 事件，其它标签页改动时丢弃缓存重读。`localStorage` 读写全部 try/catch，隐私模式下退化为"仅内存生效"。

---

## 5. 持久化与备份链路

```
编辑 ─500ms─► writeLiveData(bookId) ─► rev+1 ─► BroadcastChannel(MSG.data)
                                          ├─► 镜像文件夹 latest.json（60s 节流）
                                          └─► maybeSnapshot ─► createSnapshot(hash 去重)
                                                                  └─► pruneSnapshots ─► 镜像删同名文件
```

快照链（`src/storage/snapshots.js`，全部策略是纯函数，`snapshot:check` 覆盖）：

| 项 | 值 | 说明 |
|---|---|---|
| 节奏 | `SNAPSHOT_INTERVAL_MS = 15min` | 只在真的写盘之后才判 `shouldSnapshot`，纯浏览不产生快照 |
| 启动补 | `STARTUP_SNAPSHOT_MS = 24h` | 关掉标签页期间也可能改过，补一份避免历史空洞 |
| 淘汰复查 | `RETENTION_SWEEP_MS = 6h` | 常驻标签页也要按分层收敛 |
| 分层保留 | 7 天全留 / 30 天每日最早 / 365 天每月最早 | `selectSnapshotsToDelete` 是唯一决策入口 |
| 总量 | `MAX_SNAPSHOTS = 500` | 超限时从最老的非保护快照开始删 |
| 保护位 | `manual` / `import` / `pre-restore` | `protected` 与 reason 严格一致，淘汰永不碰 |
| 去重 | `hashPayload(canonicalPayload(payload))` | 内容没变 → 不产生新快照，返回 `created: false` |

**四道防丢写兜底**（每一条都对应一次真实事故或一次可预见的丢数据路径）：

1. **`loadedRef` 守门**：LOAD 尚未 apply 之前 `scheduleSave` / `flushSave` 直接 return。否则"组件挂载时的那一次空写"会把内存里的空数组盖到 IndexedDB 上，真数据被一个 `rev+1` 的空版本顶掉——而 `rev` 单调递增会掩盖这次丢写，光看 `rev` 变化根本发现不了。
2. **切书 / 卸载前冲水**：load effect 的 cleanup 里 `clearTimeout` + 若 `pendingRef` 未清则立即 `flushSave()`，最后 500ms 的编辑不会因为换书而蒸发。
3. **导出前强制落盘**：`beforeExport` 先 `books.flushSettings()` + `bookData.flushSave()`，导出的信封一定含最新内容。
4. **单写者锁**：每个标签页 `claimWrite()` 接管（后开始编辑者胜出），败者 `canWrite=false` 转只读并显示"接管编辑"。写盘前再校验一次 `bus.isWriter()`，不是写者就**丢弃**待发内容并改用对端数据——两个标签页互相覆盖的旧风险因此从"概率低不修"升级为"结构上不存在"。

**回放与恢复语义（需求 ③ 的 UX 表达）**：

- **查看某版本 = 只读回放**：`openPreview(snapshot)` → `Workspace` 用 `preview.payload` 渲染整站，`readOnly` 让拖拽新建、编辑、模板增删、改设置、导入导出写路径统一被 `guardWrite()` 拦下并 toast；红横幅常驻，关掉历史面板仍在回放，退出预览才恢复可写。回放期间**不产生任何写入**（`smoke` 第 11 步逐条断言）。
- **恢复某版本 = 不可逆**，因此恢复本身也是"追加两份"：`restoreToSnapshot` 先 `force` 写一份 `pre-restore`（`note` = 目标 id，受保护）→ UI 应用旧 payload → `finishRestore` 再 `force` 写一份 `restored-from`。用户点恢复前必须看到 `history.restoreSafety` 那句"不可逆，但当前内容会先存成一份新版本"。
- 结论：链上任何时刻都留有"恢复前的你"，所以"不可逆"不会变成"回不去"。

**可选的文件夹镜像**（`folderBackup.js` + `useBackupFolder`）：`EventLogger Backups/manifest.json` 记书名↔目录与每份快照指纹，`<书名>/latest.json` 与 `<书名>/snapshots/<ISO>.json` 是可直接阅读的副本。刻意**只写不读**——它不参与应用状态，删了不影响运行，但足以在"浏览器被清"之后手动搬回来。

**恢复入口一共三条**：① 历史面板选版本恢复；② EventBook 菜单「数据与备份」段的导出 / 导入文件；③ 镜像文件夹里的 JSON 再导进来。

---

## 6. 功能模块设计

### 6.1 时间轴 `components/Timeline.jsx`

- **日 / 周双视图**。周视图 7 列，`min-width: 120px` 允许横向滚动；时间列 `position: sticky; left: 0`；表头是第二个同步滚动容器，用 `transform: translateX(-scrollLeft)` 手动对齐（避免双滚动条）。
- **一个手势承载两种意图**：按住已有事件拖动 → 松手是"移动"；没移动（`hasMoved === false`）→ 松手是"打开编辑"。用一个布尔量区分，不给用户两套控件。
- 拖空白格按下→拖动→松开，直接把选中的 `[min, max+1)` 喂给创建弹窗（不是立刻创建）。
- 拖动中的事件：原块降到 `opacity 0.25`，另渲染一个 `pointerEvents: none` 的半透明**幽灵块**跟手；**时长锁死**，起点先按 `Math.max(0, Math.min(TOTAL_SLOTS - duration, newStart))` 平移夹紧，再落进目标日的空档（见下两条）。
- **跨日期拖动**（`utils/dayDrop.js` 三个纯函数）：横向落点由 `columnIndexOfX` 决定——`Timeline` 用 `registerColumn` 收集 7 列 DOM，每帧读 `getBoundingClientRect()` 命中列；指针拖出网格外**不取消**手势，而是吸附最近的一列，因此**落点恒在当前可见列内**（周视图 7 列，绝不跨周翻页；日视图只剩 1 列，同一套代码自动退化成"只能同日移动"）。纵向沿用按下时的 `offset`（按住哪里就从哪里算），手感与同日拖动一致。目标日还剩哪些地方可放由 `freeWindowsForDay` 给出（半开、互不相交、**排除被拖的那条自己**，否则"原地微调"永远撞自己），`clampMoveToFreeWindow` 再把候选起点挪到**位移最小的空档**（并列取更早的那个）；整天都放不下则**整次作废**，绝不为了塞进去而改变时长；提示只在真正跨日期时给（同日手滑静默取消，免得一晃眼就弹错误）。
- 落点预览与真正提交走**同一个** `clampMoveToFreeWindow`，所以"看到哪就是搬到哪"：装得下就显示夹紧后的真实落点，装不下就停在候选位并整块转红（实线 `--color-danger` 左边框，与粘贴预览的**虚线**冲突态刻意区分——"会自动避让"和"会被拒绝"是两种语义）。指针进入滚动区左右 24px 边缘时 `requestAnimationFrame` 一帧 6px **自动横向滚动**，滚完立刻用同一函数重算落点，故"滚到哪、落到哪"永远同步；手势结束、切日期、切视图一律 `endDrop()` 停 rAF，组件卸载另有清理 effect，不留僵尸循环。落点状态住在 `Timeline`（`dropPreview`）而非列内，配合 `React.memo` + 稳定的 `NO_EVENTS` 空数组，每帧只有源列和目标列重渲染。
- **拖动避让、粘贴拒绝是刻意的不一致**，不是遗漏：拖动的意图是"就这么多时长，找个地方放"，自动挪一格比弹错误有用；粘贴是"就贴在这儿"的显式动作，静默搬走反而危险，因此维持 §6.2「冲突即阻止」口径。两条路径的共同底线只有一个：**落进 IndexedDB 的结果永不含重叠**。
- **上下边缘 = 时间端点**（时间轴纵向，1 槽 = 20px）：事件条里叠两个 5px 隐形热区（`edgeHandleStyle`），光标 `ns-resize`；上边缘拖 `startSlot`、下边缘拖 `endSlot`。像素按"槽位分界线"四舍五入，所以吸附粒度天然是 10 分钟。拖动中**被拖条体本体直接跟手**（不套幽灵块），松手才走 `onMoveEvent` 一次性提交，避免逐格写盘。热区 `stopPropagation`，因此不与条体的移动/编辑手势抢事件；边缘单击（区间没真的变）仍打开编辑弹窗。
- 缩放的夹紧策略全在 `utils/slotRange.js`（纯函数）：不越过同日邻居（`neighbourBounds` 取 `prevEnd` / `nextStart`）、最短 1 槽、端点只在当前视口范围内移动；**已经越出视口的端点不会被强行拉回视口**（否则轻点一下就会跳变）。邻居墙与视口在按下时快照一次，拖动中不重算，避免墙跟着端点漂移。
- `slotEventMap`（每槽位归属哪个事件，`useMemo` 派生）用于"落在已有事件上的槽位不可开始新建"。
- 视口外的区间用 `visibleEvents = e.startSlot < end && e.endSlot > start` 过滤，绝对定位的 `top` 因此可能为负——依赖外层 `overflow: auto` 裁剪。
- **右键菜单**（`components/ContextMenu.jsx`）：事件条上右键 → `复制` / `剪切`；空白槽位上右键 → `粘贴`（剪贴板为空时**置灰但菜单照样出现**，让"这里能贴"这件事始终可见）+ `取消`（仅在有剪贴板时出现）。菜单 `position: fixed` + `zIndex 1200`，用 `useLayoutEffect` 实测自身宽高后把坐标夹回视口（贴右下缘就翻转）；document 级 `mousedown`/`contextmenu`/`wheel`/`resize`/`blur` 与 `Escape` 全挂关闭；条目在 **mousedown** 就动作——document 上的关闭监听比 `click` 先到，等 click 时本体已经卸载了。配套硬约束：`Timeline` 的三个 `onMouseDown`（拖空白新建 / 移动 / 边缘缩放）一律 `if (e.button !== 0) return`，否则右键会一边弹菜单一边启动拖拽、甚至同时弹出编辑弹窗。
- **剪贴板语义**（`utils/eventClipboard.js` 纯函数 + `Workspace` 持有的一份内存态快照）：`copy` 只留快照，可反复粘贴，每次 `addEvent` 生成新 id；`cut` 是**延迟删除**——原事件留在原地但降到 `opacity .45` + 虚线左边框，真正的位移发生在 `paste` 那一刻，走 `updateEvent(sourceId, …)` 复用原 id（统计与 `updatedAt` 链不断），成功才清空剪贴板；空白菜单里的「取消」就是撤掉这份待粘贴状态。落点与同日其它事件重叠时**拒绝写入 + 自研 `Toast` 报错**（不自动避让、不弹对话框），与 §6.2「冲突即阻止」同口径。快照是纯内存态：不写 IndexedDB、不写 `localStorage`，刷新即空。
- **落点预览**：菜单打开期间在目标列画一个半透明幽灵块（`getPastePreviewStyle`），用的正是 `Workspace` 真实写入时同一对 `pasteRange` / `hasOverlap`，所以"看到哪就是贴到哪"；预计会冲突时整块转红（`--color-danger`）。周视图只把预览下发给被右键的那一列，不串台。滚动时间轴、切日期、切日/周视图、改视口范围都会立刻收起菜单——落点已经失效了。

### 6.2 事件弹窗 `components/EventDialog.jsx`

- **冲突 = 阻止创建**：与同日其它事件重叠（`e.date === dateStr && e.id !== 当前 && e.startSlot < endSlot && e.endSlot > startSlot`）时给出红条提示（含对方名称与区间）并禁用创建按钮。结束时间下拉框过滤掉 `≤ startSlot` 的选项，从源头减少非法输入。
- **模板走"双通道"**：一个下拉（创建模式叫"从历史事件选择"，编辑模式叫"关联模板"），选中后只回填 `name` + `category`，时间保持拖拽结果，并记下 `templateId`；不选则手填。同一个动作在编辑模式语义弱化为"重新关联"——因为共用成本高、歧义低。
- 编辑态"存为模板"：以当前 name + category 建模板并绑定。`addTemplate` 对同名同类别是**幂等的**（命中则返回已存在项），因此可复用其返回值。
- 模板排序为"双通道"：偏好为 `default` 时走**热度打分**（近 7 天 +3 / 21 天 +2 / 30 天 +1，只影响显示顺序），用户显式选了字段则与模板管理弹窗共用同一排序引擎（§8）。
- 局部 state 用 `initialData` 派生 + `useEffect` 同步，卸载重建，避免跨事件脏状态。

### 6.3 统计面板 `components/StatsPanel.jsx`

- 四档 scope（day/week/month/year）住在**当前这本书**的 `settings.statsScope` 里：`Workspace` 持本地态保证零延迟，再 `patchSettings` 合并写进 `books`（§3、§4.4）。换一本书就是它自己的档位。
- 聚合规则：day → 按事件名；week → 按天堆叠；month → 按周堆叠（分桶起点用**这本书的** `weekStartsOn`，编号用 `weekNumber`，`weekStartsOn=1` 时等于 ISO 周号）；year → 按 12 个月堆叠。
- 柱图按类别堆叠（`stackId="a"` + 每类别一个 `<Bar>`），最后一类给 `[4,4,0,0]` 圆角。
- **饼图标签做了拥挤规避**：占比 ≥7% 时扇区内白字百分比、扇区外类别名；<7% 时类别名 + 百分比一起挪到外侧；用 `cos` 分档决定 `textAnchor`。整组 `<text>` 设 `pointerEvents: none`，否则会挡 `:hover` tooltip。
- 时长展示统一走 `formatMinutesCompact`（15 分钟显示 `0.3h`），刻意**牺牲精确换可读**。
- `filteredEvents.length === 0` 时整卡隐藏。
- 所有派生统计走 `useMemo`。

### 6.4 日历 `components/Calendar.jsx`

固定 6 行 42 格（补齐上/下月）消除切月高度跳动；首列由**当前 book 的** `weekStartsOn` 决定（`leadDaysBeforeMonth(firstDay, weekStartsOn)`，§3.3），表头文字取 `weekdays(lang, weekStartsOn)`（三份字典的 `calendar.weekdays` 恒为周一开头，轮转前先把它换成 `getDay()` 口径的下标 `(weekStartsOn + 6) % 7`；少了这一步，表头会跟着格子一起错一列，每月的 1 号永远停在同一格里，改「Week starts on」看上去就毫无反应）；有事件的日期在圆内加一个小圆点，圆点只依据 `dateSet`（`Workspace` 里 `useEvents.getDateSet()` 派生的 `Set<date>`；回放态下换成从 `preview.payload` 现算），不做按天聚合，成本 O(n)。

### 6.5 EventBook 与页面壳

- `src/App.jsx` 只做三件事：装配 `useBooks` / `useBackupFolder` / `useBookData` / `useBookTransfer`、用 `activeBook.settings.language` 包住 `I18nProvider`、决定"现在该画哪一个屏"。渲染门顺序是硬性的：**不支持 IDB → 书目加载中 → 没有 book（首启引导）→ 本书数据加载中 → `Workspace`**。后两道门缺一不可，它们就是 §11 I24 那条"换书必然重挂载"的实现。
- `src/components/Workspace.jsx` 是**唯一的页面级组件**，也是 UI 态的所有者（选中日期、日/周视图、视口槽位、弹窗开关、右键剪贴板、回放 `preview`）。它对下压一个 `guardWrite(fn)`：所有写动作先过这道闸，`readOnly`（回放中）**或**已失去单写者身份时统一 toast 拒绝——因此"只读"不需要在每个组件里各写一遍。
- 顶栏 `Header.jsx` 一共六个元素：EventBook 下拉、标题、"数据在本机"徽章、历史、模板、语言。凡是以"这本簿"为主语的动作都收进那个下拉——切换 / 新建 / 簿设置 / 导出此簿 / 删除此簿，外加「数据与备份」段的**导出全部簿**与**导入为新的 EventBook**（这两项原先是挂在顶栏右侧的按钮）。语言按钮写的是**当前这本书**的设置（§7.2），不是全局偏好。
- 下拉里的"导入"不自己持有 `<input type="file">`：`Dropdown` 一关就连 children 一起卸载，input 若写在面板里，菜单关掉之后 change 事件无处落地，症状正是"点了导入没反应"。所以 input 常驻 header 根节点（`display: none`），菜单项只调 `ref.click()`。这条不变量记在 §11 I29，`smoke` 第 15 步同时断言"关菜单后 input 仍在"与"input 不在菜单面板内"。

### 6.6 单本设置、历史面板与首启引导

- `BookSettingsDialog.jsx` 编辑当前这本书的书名 / 周开始日 / 语言 / 时间轴视口 / 统计档位。删除入口不在这个弹窗里，而在顶栏书籍菜单（§12 倒数第 5 行是它）。**开场时机由 `books.settingsOpenFor` 派生**（见 §4.3），弹窗本身不知道自己是"新建后自动弹"还是"用户点的"。
- `WeekStartPicker.jsx` 把抽象的 `weekStartsOn` 变成**预览**：选中任一日起点，立刻显示这本书的周范围与周号（`getWeekRange` / `weekNumber`），让 §3.3 的口径在改之前就被看见。
- `HistoryPanel.jsx` 是需求 ③ 的界面：一行一个历史版本（时间取 `snapshots` 索引，不含 payload），带 reason 中文标签、体积合计（`snapshotStats`）、配额占比（`estimateUsage`）、「立即存档」、镜像文件夹的连接/授权/遗忘，以及"查看此版本 / 恢复到此版本"。点击某行 = 进出回放；恢复是**行内两段式确认**（`restoreId` 命中才出现"确认恢复"），避免整页 `confirm` 打断。
- `FirstRunGuide.jsx` 只在"一本 book 都没有"时出现：起个书名 / 挑周开始日与语言 / 迁移本机旧 `data.json`（仅 localhost 探测到才显示）/ 从备份文件恢复。做完即 `createBook`，此后它不再出现。
- 三个组件上的 `data-*`（`data-action` / `data-snap`）是 `npm run smoke` 的定位锚点，**改 UI 时不要顺手删**。

---

## 7. 国际化设计（zh / en / ja）

### 7.1 三层能力，边界清晰

| 能力 | 位置 | 约定 |
|---|---|---|
| 静态 UI 文案 | `i18n/locales/*.js` + `tr(key, params)` | 点分路径查找；`{n}` 占位符；未知 key → **回退 zh** → 回退 key 本身 |
| 日期/时长/星期 | `i18n/format.js`（`Intl.*` + formatter 缓存） | **零新增依赖** |
| 槽位时间 | `utils/time.js` 的 `slotToTime` | **无 lang**，HH:mm 视为跨语言通用，保持字符串格式稳定（用于存储与内部比较） |

`zh` 是**源语言**，`en`/`ja` 翻译自它，所以兜底字典写死 `zh`（默认显示语言 `DEFAULT_LANG` 是 `en`，二者不矛盾）。

### 7.2 语言决策优先级

界面语言的真源是**当前 EventBook 的 `settings.language`**：`App` 把 `activeBook.settings.language` 灌给 `I18nProvider`，所以换书即换语言，改语言只影响这一本书。

```
activeBook.settings.language  >  localStorage(event-logger:lang)  >  浏览器语言  >  'en'
```

后三级只在两个场景生效：**还没有任何 book**（首启引导页，`resolveInitialLang(null)`）与**新建一本书时的默认值**（`makeBook({ deviceLang })`）。`Provider` 每次确定语言都 `writeStoredLang(current)`，于是下次冷启动在读到 book 之前就能用对的语言渲染首帧，不闪一下中文变英文。

用户在顶栏切语言 → `onLanguageChange` → `patchBook({ settings: { language } })` → 400ms 合并写进 `books`。**绝不写回别的书**，也不再有"服务器语言采纳"那一类回灌（`adoptServerLanguage` 已随旧架构删除）。

`LANG_WEEK_START` 是同样的形状：语言决定**默认**周开始日，写完即与语言脱钩（§3.3）。

### 7.3 内联 bootstrap 与三处重复

`index.html` 里有一段在 React 挂载前执行的内联脚本，提前设置 `document.title` 与 `html lang`——首帧文案由 React 设置，不内联就会闪一下默认标题。

代价是 `STORAGE_KEY` 与三个标题在 **内联脚本 / `i18n/core.js` / 各 locale** 三处重复，目前靠注释与 `i18n:check` 维系。**改标题或 key 时必须三处同改。**

### 7.4 字形修正

`html[lang='ja']` 时切换字体栈（`global.css` 末尾），避免日文汉字落到中文字形上。星期标签从字典数组取（`calendar.weekdays`，带长度校验的默认值）而非 `Intl`，以便强制周一首位、单字形。

---

## 8. 模板排序引擎

文件：`utils/templateSort.js`（引擎）+ `hooks/useTemplateSort.js`（偏好）+ `components/TemplateSortControl.jsx`（控件）+ `scripts/check-template-sort.mjs`（~70 条断言）。

### 8.1 四条不变量

1. **纯函数，不碰存储**：`sortTemplates(templates, opts) -> 新数组`，payload（live 行与每一份快照）里的模板数组顺序**永不因排序改变**。排序只影响显示顺序。
2. **稳定不抖动**：`items = templates.map((t, i) => ({ t, i }))` 把插入序号烧进比较项；最后一级比较永远是 `a.index - b.index` 升序且**不随方向反转**。于是同一字段值相同的项永不动，而升序/降序互为严格逆序（可用"reverse 相等"作为测试断言）。
3. **未知时间垫底**：`updatedAt` 缺失或非法 → `null` → 排序时**不参与 sign 反转**。语义是"宁可排最后，也不冒充最新"。
   > 这是全文件唯一有真实陷阱的地方：写成 `sign * (timeA - timeB)` 会让无时间戳的模板在"新的在前"视图里冒到最前。断言用"升序与降序输出完全相同"把它钉死。
4. **时间戳不可伪造**：`stampUpdatedTemplate` 先 `delete` 掉 `updates.createdAt` / `updates.updatedAt`，只有 `name` / `category` 真变了才刷新 `updatedAt`。`stampNewTemplate(name, cat, timestamps?)` 的入参时间戳**只为"导入合并时沿用原始创建时间"**这一个场景存在，且同样要过 ISO 校验。

### 8.2 语言与数字

比较交给 `new Intl.Collator(localeTag(lang), { sensitivity: 'base', numeric: true })`：中文按拼音、日文按五十音、英文按字母；`sensitivity: 'base'` 忽略大小写（`Alpha` 落在 `Bravo` 前而非 `charlie` 后）；`numeric: true` 让 `task2` 排在 `task10` 前。Collator 按 locale 缓存，避免每元素 new 一次。

类别标签**归一化到当前语言**再比较（`categoryLabel: key => tr('category.' + key)`），调用方必须注入；缺省时退化为 key 本身，因此未知类别与 `work` 同档。

比较是**二级排序**：按名称时同名再比类别，按类别时同类再比名称。

### 8.3 偏好语义

`{ sort, direction }`，字段有"自然方向"（`updated: desc`，其余 `asc`）。点当前字段**不产生任何变化**；切换字段时方向重置为该字段自然方向；`sort === 'default'` 强制 `direction: 'asc'`。读写均经 `sanitize` 白名单，脏 localStorage 退化为 `{default, asc}` 而非 undefined。

---

## 9. 样式与设计 token

无 UI 库、无 Tailwind、无 class 体系。`global.css` 只定义 `:root` 变量、reset、滚动条、拖拽与缩放期间挂在 `document.body` 上的光标类（`.slot-moving` / `.slot-resizing`，避免指针滑出小块时光标闪烁）、日文字体覆盖；组件一律用 **module-level 常量 inline style**（`const rowStyle = {...}`）+ `style={{...}}` 字面量，派生样式写成函数（`tabStyle(active)`、`categoryBtnStyle(active, cat)`）。

```
--color-bg #f5f6fa   --color-surface #fff   --color-border #e2e5ec
--color-work #4a90d9 / -life #27ae60 / -study #f39c12（各带 -light / -hover）
--color-accent #6c5ce7   --color-danger #e74c3c
--sidebar-width 390px   --header-height 56px   --slot-height 20px   --radius 8px
```

类别色板集中在 `utils/categories.js`：一个 key 同时提供 CSS 变量、recharts 用的 hex、图标。**加类别 = 改 `categories.js` + `global.css` 两个文件**，统计口径与色板都派生自 `CATEGORIES`。

inline style 的好处：无 specificity 冲突、派生值（如 `top = (slot - base) * 20`）本来就是数字；代价：hover 等状态只能靠 React state（见 `Header.jsx` 的 `HoverButton`），样式无法跨文件复用。

---

## 10. 工程化与运维

```bash
npm run build             # 前端产物 → dist/（含 sw.js / manifest.webmanifest / icons / _headers）
npm run dev               # Vite 5173，/api 代理到 3002（只有迁移旧 data.json 时才需要后端）
npm start                 # node server.js：只发静态文件 + 只读 legacy 探测，默认 3002（支持 PORT）

npm run check             # 串起下面 9 项，任一失败退出码 1
  i18n:check              #   三语字典一致性（以 zh 为基准：键集合 + 非空 + 占位符匹配）
  sort:check              #   模板排序引擎与时间戳规则（~70 条确定性断言）
  slotrange:check         #   边缘缩放夹紧（邻居墙/视口/最短时长 + 2040 组不变量扫描）
  clipboard:check         #   右键剪贴板（快照合法性/粘贴落点夹紧/重叠谓词 + 62640 组扫描）
  daydrop:check           #   跨日期落点（空闲窗口/位移最小夹紧/横向命中列 + 12960 组扫描）
  week:check              #   周口径（15372 组周窗口 + 2196 组 ISO 周号 + 月历前导格 + 统计档位）
  snapshot:check          #   快照策略（指纹/节奏/分层淘汰/上限，含 845 份留 500 份的模拟）
  book:check              #   EventBook store（设置守门/书名与文件名清洗/v1+v2 信封/导入防撞）
  imports:check           #   React 具名 API 是否都显式 import（46 文件 × 24 API）

npm run csp:check         # index.html 内联脚本的 sha256 是否与 public/_headers 一致
npm run smoke             # 无头 Chrome 端到端 16 步（详见 README）
npm run icons             # 从 favicon.svg 生成 4 档 PWA 图标
npm run deploy            # build → csp:check → wrangler pages deploy dist --project-name=event-logger
```

检查脚本的性质是 **lint 级 CI**：进程退出码 1 即失败，输出中文问题清单。断言刻意做成确定性的（如 `createdAt` 断言写成 `===` 到预计算 ISO 串，不依赖宿主机 locale/时区），否则"检查脚本"会变成新的抖动来源。

`npm run smoke`（`scripts/e2e-smoke.mjs`）与它们互补：它不测纯函数，而是**用真鼠标跑真浏览器**，直接读 IndexedDB 行、抓每一条网络请求，因此能证明三条承诺在集成层成立。要点：

- 界面文案一律从 `src/i18n/locales/en.js` import 后来定位，不硬编码字面量；
- 组件上的 `data-*`（`data-slot` / `data-header-date` / `data-snap` / `data-action`）是**测试锚点**，改 UI 时不能顺手删；
- `--stop-at=N` 只跑前 N 步（单步调试用），`--applog` 失败时打印页面日志，`--slow=MS` 给人眼看，`--url=` 可打已部署的站点，`--no-sandbox` 只在显式传入时给 Chrome 追加 `--no-sandbox --disable-dev-shm-usage`（Linux 容器里起不来才用，不传时本机行为一字不变）；
- 它自带随机端口的静态服务器，不碰本地 3002/3003。

运维脚本（本地常驻才需要）：

- `start-server.bat` / `stop-server.bat` — 按端口探测与反查 PID，两者都跟随 `PORT`（默认 3002），注释保持纯 ASCII（`.bat` 走 OEM 代码页，中文注释会被写成 `?`）；
- `EventLogger-AutoStart.vbs` — 登录自启是个人机器上的便利脚本，内含本机绝对路径，**不进仓库**（已列进 `.gitignore`），需要的人按 README 说明自建。

发布到公网有两条路，两条都要过同一条校验链（`build` → `csp:check`）：

- **本机直发**：`npx wrangler login` 一次，然后 `npm run deploy`。凭证只留在本机（`.wrangler/state`，已 gitignore）。
- **GitHub Actions**：`.github/workflows/ci-and-deploy.yml`。`master` 的 push / `workflow_dispatch` 跑三个 job：`checks`（9 项不变量 + build + csp:check，阻断）→ `browser-smoke`（ubuntu runner 上的真 headless Chrome 跑那 16 步，**目前带 `continue-on-error: true`，红了不拦**）→ `deploy`。`checks` 把 `dist/` 以 artifact 交给后两个 job，所以**上线的就是通过闸门的那一份**，不存在"检查一份、另建一份"。

Actions 需要三个仓库级配置（Settings → Secrets and variables → Actions）：secret 的 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`，加上变量的 `DEPLOY_ENABLED`。`deploy` job 的条件是 `github.event_name != 'pull_request' && github.ref_name == 'master' && vars.DEPLOY_ENABLED == 'true'` —— **变量缺失或值不是字符串 `true` 时，workflow 照样检查和构建，但线上一个字节都不会变**，这就是发布总闸（job 级 `if` 读不到 `env` 上下文，所以分支名在 `if` 里写成字面量，改默认分支要同时改 `env.PRODUCTION_BRANCH` 与那行 `if`）。Pages 项目由 workflow 首次 `wrangler pages project create` 自动创建，已存在则跳过。

> 端口默认值 3002 散在 `server.js`（`PORT` 可覆盖）/ 两个 `.bat`（`PORT` 可覆盖）/ `vite.config.js` 的 dev proxy（写死）/ 本文档几处，无共享配置源。它只影响"本机跑静态服务 + 旧数据迁移"这条路，公网部署与之无关。
>
> 安全头只有一个来源：`public/_headers`（Vite 原样拷进 `dist/`）。它是 Cloudflare Pages 专用格式；换托管商要手动翻译成等价配置，**别以为构建产物里带了它就直接生效**。

---

## 11. 不变量清单（改代码前后自查）

| # | 不变量 | 守护位置 |
|---|---|---|
| I1 | 事件区间半开 `[startSlot, endSlot)`，`start < end` | `EventDialog` 校验 + 下拉过滤 |
| I2 | `0 ≤ timelineStart < timelineEnd ≤ 144` | `storage/books.js` `normalizeSettings`（读与写都过一遍） |
| I3 | live payload 与快照里的模板数组顺序 = 插入顺序，永不因显示排序改变 | `sortTemplates` 返回新数组；`sort:check` §6 |
| I4 | 未知/非法 `updatedAt` 在任何方向下都排最后 | `templateSort.js` 显式分支；`sort:check` §5 |
| I5 | 调用方不能通过 `updates` 伪造时间戳 | `stampUpdatedTemplate` 先 delete |
| I6 | 升序与降序互为严格逆序 | 最后一级 `a.index - b.index` 不反转 |
| I7 | 语言真源 = `book.settings.language`；localStorage / 浏览器语言只是"无 book 或新书默认"的兜底 | `App` → `I18nProvider`；§7.2 |
| I8 | 三语字典键集合与占位符完全一致 | `npm run i18n:check` |
| I9 | 内容未变不产生新快照（指纹相同即 `created: false`） | `canonicalPayload` + `hashPayload`；`snapshot:check` |
| I10 | 纯函数层（`utils/`、`i18n/core.js`、storage 的策略函数）不依赖 React | 人工约束；`check-*.mjs` 能在 Node 直接跑即是证明 |
| I11 | 边缘缩放不产生新重叠：`start >= prevEnd`、`end <= nextStart`，且 `end - start >= 1` | `resizeRange` 夹紧；`slotrange:check` §4/§5/§8 |
| I12 | 缩放端点不越出视口，但已越出视口的端点不被拉回（不跳变）；只动被拖的那个端点 | `resizeRange` 的 `min/max`；`slotrange:check` §6/§8 |
| I13 | 粘贴落点一律经 `pasteRange`：时长尽量保持、恒 `startSlot < endSlot`、装得下留在视口内，装不下才夹到 `[0, 144 - duration]` | `eventClipboard.pasteRange`；`clipboard:check` §2/§4 |
| I14 | 剪贴板是瞬时内存态，绝不进 payload / 快照 / `localStorage`；粘贴不得引入新重叠（`cut` 用 `ignoreId` 排除自己） | `Workspace.clipboard` state + `hasOverlap` 前置判定 |
| I15 | 移动结果必须整条落在目标日某个空档内、时长不变；放不下就**不写盘** | `dayDrop.freeWindowsForDay` + `clampMoveToFreeWindow`；`daydrop:check` §2/§4 |
| I16 | 跨日期目标恒为**当前可见列**之一；`onMoveEvent` 未带非空 `dateStr` 时绝不写 `date` 键 | `columnIndexOfX` + `visibleDateStrs` + `Workspace.handleMoveEvent` |
| I17 | **服务器永不写用户数据**：全站只有 GET，唯一读接口是只读的 `GET /api/legacy-data`（且前端只在 localhost 探测） | 架构上没有任何写接口；`smoke` 第 7/16 步逐条断言方法、请求体、跨域、URL 内容泄露 |
| I18 | 任何 IndexedDB 读写必须经 hooks；组件只允许 import storage 层的**纯函数与常量**。`indexedDB.open` 全站只出现在 `storage/idb.js` | §4.2 人工约束 + `grep -r "indexedDB" src`；`book:check` 只测纯逻辑即成立 |
| I19 | LOAD 未 apply 完成前禁止落盘（挡住"挂载首帧的空写"）。`rev` 单调递增**不能**当作"写成功"的证据 | `useBookData.loadedRef`（`scheduleSave`/`flushSave` 双守）；`smoke` 第 6/10 步断言编辑真的进了 IDB |
| I20 | `weekStartsOn` 只能来自当前 book；归一化入口只有 `normalizeWeekStart` / `normalizeSettings` | `week:check`（15372 组周窗口 + 2196 组 ISO 周号 + 3 种语言 × 7 种起点的月历表头列对齐）；`smoke` 第 4/13/14 步 |
| I21 | 淘汰快照只能经 `selectSnapshotsToDelete`；`protected` 必须与 `PROTECTED_REASONS` 严格一致，淘汰永不删受保护项 | `snapshot:check`（845 份留 500 份模拟）；`smoke` 第 9 步读真行复核 |
| I22 | 快照链**只追加**：恢复不得删除或改写既有快照，且必须留下成对的 `pre-restore`（受保护）+ `restored-from`（可淘汰），`note` 指回被恢复的那一份 | `restoreToSnapshot` / `finishRestore` 均 `force: true`；`smoke` 第 12 步断言旧快照一份不少 |
| I23 | 回放态（`preview`）下所有写路径必须被 `guardWrite()` 拦下，且不留任何 IDB 写入 | `Workspace.readOnly = !!preview \|\| !canWrite`；`smoke` 第 11 步（拖拽 / 编辑 / 改设置三条路 + 落盘复核） |
| I24 | 每个 EventBook 的数据与设置严格隔离；换书必然重挂载（`Workspace key=book.id` 与 `bookData.loading` 门**成对存在**） | `App.RootView`；`smoke` 第 13 步"新书完全空白 / 无快照" |
| I25 | 改了 `index.html` 的内联引导脚本，`public/_headers` 的 sha256 必须同步 | `npm run csp:check`（已串在 `npm run deploy` 里） |
| I26 | 用了 React 具名 API 必须显式 import（漏一个就是线上白屏级 `ReferenceError`） | `npm run imports:check` |
| I27 | `data.json` 是只读遗留物：任何代码路径都不得再写它 | `server.js` 只剩 `readFileSync`；`smoke` 用 size+mtime 指纹断言未变 |
| I28 | 页面必须自报构建号：`<html data-build>` 由 `main.jsx` 写入，格式固定 `(sha8|dev)-yyyymmddHHMMSS[+]`，源码只经 `src/buildInfo.js` 读取 | `smoke` 第 1 步按格式断言；设置对话框页脚 `data-build` 肉眼可查 |
| I29 | 导出 / 导入的**入口**在 EventBook 菜单里，但承载文件的 `<input type="file">` **必须常驻 header 根节点**（下拉一关就卸载 children，跟着卸载的 input 会让"导入"点了没反应）；同一只下拉必须整体键盘可达：触发器 `role=button` + `tabIndex=0` + `aria-expanded`，面板 `role=menu`，项 `role=menuitem` 且可聚焦 | `Header.jsx` 的 `pickImportFile()` 与根节点 input；`smoke` 第 15 步断言 `inputMounted`、`inputInsideMenu === false`、`tabbable === items.length`、`triggers >= 1` |

---

## 12. 已知取舍与风险

| 风险 | 位置 | 说明 / 触发条件 | 现有缓解 |
|---|---|---|---|
| **数据只活在单一浏览器** | 整体 | 清浏览器数据、换设备、换浏览器 = 数据"看不见"，因为服务器上没有副本可比对。这是需求 ① 的直接代价，不是缺陷 | 导出/导入文件；可选镜像文件夹；三条恢复入口（§5） |
| 浏览器存储被驱逐 | `storage/idb.js:130` | 未授予持久化时，浏览器可在磁盘紧张时整库丢弃。**iOS/Safari 没有 `navigator.storage.persist()`**，申请必然返回 false；桌面 Chrome 也要站点达到阈值才批 | `useBookData` 载入后调一次 `requestPersistence()`；镜像文件夹；smoke 第 14 步只断言"申请这一句不炸"，不假装它一定成功 |
| 快照存整包而非增量 | `snapshots.js` `MAX_SNAPSHOTS=500` | 每个版本都是完整 payload。当前数据量下 500 份约几 MB，若事件量再涨十倍会先撞配额 | hash 去重（内容没变不产生版本）+ 分层淘汰（§5）；写失败经 `storageError` → toast（`App.jsx:75`），不静默 |
| `useEvents` / `useTemplates` 只在挂载时接收一次初值 | `hooks/useEvents.js:9`、`useTemplates.js:10` | 第二次换 payload 会被 `initialized` 忽略。**它依赖"换书必然重挂载"**：`Workspace key={book.id}` 与 `bookData.loading` 渲染门必须**成对存在**，拆掉任一门就会把旧书内容留在新书界面上 | I24 + smoke 第 13 步 |
| CSP 哈希与内联脚本必须同步 | `index.html` / `public/_headers` | 忘了改 → 线上首帧白屏。本地 `npm start` 与 `vite dev` **都不发 CSP 头**，"本地能跑"不代表线上放行 | `npm run csp:check` 已串进 `npm run deploy`；I25 |
| 安全头与托管商耦合 | `public/_headers` | Cloudflare Pages 专用格式。换 Netlify / nginx / OSS 要手动翻译等价配置 | README「部署前必读」已标注 |
| PWA 发版有"旧壳"窗口 | `vite.config.js` | 预缓存 shell + `autoUpdate`。产物名带 hash 所以 `immutable` 长缓存安全，但 `injectRegister: 'script'` 会让 vite-plugin-pwa **不再**自动打开 `skipWaiting`/`clientsClaim`（它只在 `injectRegister` 为 `auto`/`null` 时才打开），新 SW 只能等所有标签页关完才激活 —— 于是"重新打开一次"看到的仍可能是旧构建，表现得像修复没生效。这里刻意不开 `skipWaiting`：`StatsPanel` 是懒加载分包，提前激活会触发 `cleanupOutdatedCaches` 删掉旧页面包，正在用的标签页再点统计就会 404 | 每个构建带 `BUILD_ID`（`<html data-build>`、设置对话框页脚、`smoke` 第 1 步），先确认加载到哪一版再判断修复是否生效；急时在控制台执行 `navigator.serviceWorker.getRegistration().then(r => r && r.unregister()).then(() => location.reload())`（只丢 shell 缓存，IndexedDB 数据不动）；改完前端必须 `npm run build` 才算发布 |
| 旧 `data.json` 迁移是一次性且 localhost-only | `utils/legacyFetch.js`、`components/FirstRunGuide.jsx` | 公网部署没有这个接口（404 → 入口自动隐藏）。错过本地这条路的人只能导文件 | 引导页只在"一本 book 都没有"时出现，迁完即消失；导入永远是新增簿、不覆盖已有簿（`planImport` 防撞） |
| 原生 `alert` / `confirm` 残留 | `EventDialog.jsx:146,147,153`、`TemplateManager.jsx:71,83,132`、`Workspace.jsx:197,234` | 与自研 `Toast` / 对话框体系脱节。**`Workspace.jsx:234` 是删除 EventBook 的确认**，语义最重，要改优先改这一处 | 已知未修 |
| 回放是"整站只读"而非差异对比 | `Workspace.readOnly` | 看不到"这一版和当前版差在哪"，只能整站回看。做 diff 要新增一层结构，当前判定不值 | — |
| 多标签页是"后开始编辑者胜出" | `storage/bus.js` | 单写者锁让并发覆盖在结构上不存在，但**不弹"另一页刚改过"的提醒**；只读页收到 `rev` 才刷新。同一个人开两页时可能困惑 | UI 常驻"只读 · 接管编辑"入口 |
| 零日志 ≠ 零遥测 | `public/_headers`、CDN | 应用自身零外呼（无第三方字体/脚本/图片，`connect-src` 与 `font-src` 都锁同源），但 **Cloudflare 边缘仍会留访问日志**（IP、UA、URL、时间戳）——这是唯一无法在代码里消除的遥测面 | 承诺只写"服务器不存用户数据"，README 的隐私边界一节照实说明，不夸大成"完全匿名" |
| 将来若加服务器存储 | 整体 | 鉴权 / 加密 / 按用户分区必须**前置**。现在整套代码的前提是"任何人拿到 URL 也看不到别人的数据"，这个前提一破，I17 与 §2 的攻击面结论同时失效 | — |

---

## 13. 演进历史

```
已提交
  初版 → 端口改 3002 + 备份目录外置 → UI 紧凑化 + 周/月聚合 → 饼图百分比标签
  → i18n 三语 + 模板排序引擎 + 边缘缩放规则 → 设计文档 → 右键复制/剪切/粘贴 + 跨日期拖动
未提交（公网化改造，本轮）
  IndexedDB 迁移：单文件 data.json + Express 写接口 → 浏览器 IndexedDB 四 store，服务器零持久化
  EventBook：多本簿 + 每本自带 weekStartsOn / language / 视口 / 统计档位（books store）
  快照链：追加式历史版本 + 指纹去重 + 分层保留（7 天全留 / 30 天取日 / 365 天取月 / 上限 500 / 保护位）
  回放与不可逆恢复：只读预览整站 + pre-restore 与 restored-from 成对留档
  跨标签页单写者锁（BroadcastChannel + rev）：把"整包写无乐观锁"从"已知不修"升级为"结构上不存在"
  可选镜像文件夹（File System Access API，只写不读）
  PWA 离线 + 最紧 CSP（全同源 + 内联脚本 sha256）+ csp:check / imports:check
  week:check / snapshot:check / book:check 三套新断言 + 15 步无头端到端 smoke
  发布路径：Cloudflare Pages（npm run deploy）；server.js 退化为"只发静态 + 只读 legacy 探测"
  首启引导 FirstRunGuide；顶栏 EventBook 切换与设置弹窗；历史面板 HistoryPanel
```

系统并非一次成型，而是围绕**四个早期锚点**长出来的：**slot 时间模型**、**纯函数业务层**、**单一 payload 文档**、**hooks 独占 I/O**。前两个从初版就成立；后两个在初版表现为"一个 `data.json` + 一个 `usePersistentData`"，本轮把它们换成了"IndexedDB 里 `data` store 的一行 + `useBookData`"——**换的只是存放处和搬运工，形状没变**，所以 i18n、排序引擎、缩放、剪贴板、跨日期拖动这些既有功能在迁移中一行业务规则都不用改。这也是"服务器零存储"能在一轮里做完的真正原因：需要重写的只有 I/O 边界那一层。

---

## 14. 文件索引

行数为**当前工作副本的实测值**，只用于"这个文件该不该再变大"的直觉，不作为断言。

### 根目录与后端

| 文件 | 行数 | 职责 |
|---|---|---|
| `server.js` | 34 | 只发 `dist/` 静态文件 + 只读 `GET /api/legacy-data`。**没有任何写接口** |
| `vite.config.js` | 77 | PWA（Workbox）配置、构建号 `BUILD_ID` 注入（`define`）、recharts 分包、dev `/api` 代理到 3002 |
| `index.html` | 42 | 根节点 + React 挂载前的内联语言/标题脚本（哈希必须与 `_headers` 同步，§7.3） |
| `public/_headers` | — | Cloudflare Pages 专用：CSP（含内联脚本 sha256）+ 缓存策略 + 权限策略 |
| `public/robots.txt` | — | 禁止收录（工具站，不是内容站） |
| `.github/workflows/ci-and-deploy.yml` | 162 | checks / browser-smoke / deploy 三个 job；`DEPLOY_ENABLED` 是发布总闸（见 §10） |
| `README.md` | 157 | **默认英文版**；顶部语言条在中 / 英 / 日之间切换 |
| `README.zh-CN.md` · `README.ja-JP.md` | 158 · 157 | 中文版、日语版；三份结构 1:1，改内容必须三份同步 |

### `src/` 入口与页面

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/App.jsx` | 156 | 组装 hooks、按 `activeBook.settings.language` 套 `I18nProvider`、渲染门（不支持 / 载入中 / 首启引导 / `Workspace key=id`） |
| `src/main.jsx` | 16 | 挂载点 + 把 `BUILD_ID` 写进 `<html data-build>` |
| `src/buildInfo.js` | 4 | 构建号的唯一出口（`__BUILD_ID__` 由 vite `define` 替换，缺值时退成 `unknown`） |
| `src/components/Workspace.jsx` | 387 | 唯一的"页面"：布局 + 全部 UI 态 + `guardWrite()`（回放/失去写者时的只读闸门）+ 三个 `data-*` 测试锚点 |
| `src/components/Header.jsx` | 190 | EventBook 下拉（切换 / 新建 / 簿设置 / 导出此簿 / 数据与备份：导出全部簿 + 导入为新簿 / 删除此簿）+ 常驻的隐藏 file input、语言、历史、模板 |
| `src/components/Timeline.jsx` | 766 | 时间轴：拖拽新建/移动/跨日期/边缘缩放、右键菜单与落点预览 |
| `src/components/EventDialog.jsx` | 271 | 事件新建/编辑、冲突提示、模板选择与热度、存为模板 |
| `src/components/StatsPanel.jsx` | 230 | 类别饼图、堆叠柱、排行榜（recharts，懒加载分包） |
| `src/components/HistoryPanel.jsx` | 192 | 历史版本列表：reason 中文标签、预览、恢复（不可逆提示）、手删 |
| `src/components/Calendar.jsx` | 146 | 月历（42 格，前导格按当前 book 的 `weekStartsOn`） |
| `src/components/TemplateManager.jsx` | 144 | 模板增删改 + 排序 |
| `src/components/FirstRunGuide.jsx` | 144 | 零本书时的引导：新建 / 迁移本机 `data.json` / 从备份文件恢复 |
| `src/components/BookSettingsDialog.jsx` | 85 | 单本设置：书名、周开始日、语言、视口、统计档位 |
| `src/components/ContextMenu.jsx` | 83 | 自研右键菜单（fixed 定位 + 视口内翻转 + 置灰项） |
| `src/components/TemplateSortControl.jsx` | 45 | 排序分段控件（两个弹窗共用） |
| `src/components/WeekStartPicker.jsx` | 37 | 周开始日选择器（同时预览"这本书的本周"范围，把设置变成看得见的东西） |
| `src/components/Toast.jsx` | 26 | 轻提示 |

### `src/hooks/`（唯一 I/O 边界）

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/hooks/useBookData.js` | 338 | 一本书的载入 / 防抖写盘 / 快照链 / 回放与恢复 / 单写者 / 配额提示。`loadedRef` 门见 §5 |
| `src/hooks/useBooks.js` | 157 | EventBook 集合：新建/删除/切换/合并写设置 + `settingsOpenFor` 弹窗意图（App 层持有，见 §4.3） |
| `src/hooks/useBookTransfer.js` | 108 | 导出 v2 信封（含所有书）、导入（永远是新增簿，按书名+事件指纹防撞） |
| `src/hooks/useBackupFolder.js` | 100 | 镜像文件夹的授权/重连（句柄存 `meta`），把 `folderBackup` 变成"能连就同步、连不上就静默" |
| `src/hooks/useTemplateSort.js` | 111 | 排序偏好 store（模块级 state + `useSyncExternalStore` + `storage` 事件） |
| `src/hooks/useEvents.js` | 52 | 事件 CRUD + 变更上报（初值只在挂载时接收一次） |
| `src/hooks/useTemplates.js` | 45 | 模板 CRUD + 变更上报（同上） |
| `src/hooks/useToast.js` | 28 | 单条 toast 的持有者（2.5s 自动消失，卸载清 timer） |

### `src/storage/`（持久化适配层）

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/storage/idb.js` | 137 | **全站唯一**碰 `indexedDB` 的模块：库 `event-logger@1`、4 个 store、Promise 化读写、`isSupported`、`estimateUsage`、`requestPersistence` |
| `src/storage/books.js` | 133 | book 的归一化/新建/改名清洗 + 列表与 CRUD + `readLiveData` / `writeLiveData` |
| `src/storage/snapshots.js` | 223 | 快照链：写前钩子与节奏、指纹去重、分层淘汰、列表（不含 payload）、按 id 取 payload、删除 |
| `src/storage/bus.js` | 148 | `BroadcastChannel('event-logger:bus')`：数据/快照/书目失效通知 + 单写者锁（心跳 2s，接管即赢） |
| `src/storage/folderBackup.js` | 149 | File System Access 镜像：`EventLogger Backups/<书名>/latest.json` 与 `snapshots/*.json` + manifest；**只写不读** |
| `src/storage/legacy.js` | 110 | 备份信封 v1/v2 识别与生成、`planImport` 防撞、旧 `data.json` → 新书的映射（纯函数，可 Node 断言） |

### `src/utils/`（纯函数）

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/utils/time.js` | 108 | slot ↔ 时间、日期格式化、`normalizeWeekStart`、周窗口 / 周号 / 月历前导格 |
| `src/utils/stats.js` | 119 | 事件筛选与日/周/月/年聚合（一律本地日期键，不用 `toISOString`） |
| `src/utils/dayDrop.js` | 101 | 跨日期落点规则（空闲窗口 / 位移最小夹紧 / 横向命中列） |
| `src/utils/slotRange.js` | 82 | 边缘缩放夹紧规则（邻居墙 / 视口 / 最短时长） |
| `src/utils/templateSort.js` | 74 | 排序引擎（§8） |
| `src/utils/eventClipboard.js` | 71 | 右键剪贴板规则（快照 / 粘贴落点夹紧 / 重叠谓词） |
| `src/utils/templates.js` | 50 | ISO 校验与时间戳读写 |
| `src/utils/legacyFetch.js` | 30 | 只在 localhost 探测 `/api/legacy-data`；公网域名直接返回 null |
| `src/utils/size.js` | 23 | 字节数可读化（历史面板显示快照体积） |
| `src/utils/categories.js` | 9 | 类别元数据单一来源（key / CSS 变量 / hex / 图标） |

### `src/i18n/`、`src/styles/`

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/i18n/core.js` | 98 | 翻译内核（**不 import React**）、`LANGS`、`detectLang`、`resolveInitialLang`、读写 localStorage |
| `src/i18n/format.js` | 99 | `Intl` 日期/时长/星期 + 快照 reason 的中文标签；formatter 按 lang 缓存 |
| `src/i18n/index.jsx` | 49 | `I18nProvider` / `useI18n` |
| `src/i18n/locales/{zh,en,ja}.js` | 206 × 3 | 三语文案，`zh` 为源语言 |
| `src/styles/global.css` | 101 | CSS 变量、reset、滚动条、日文字体栈、拖拽期间的 `document.body` 光标类 |

### `scripts/`（lint 级 CI）

| 文件 | 行数 | 断言面 |
|---|---|---|
| `scripts/e2e-smoke.mjs` | 967 | **真浏览器 16 步**：启动+构建号→首启→建簿→设置→录入/拖动/缩放/右键→刷新→快照→回放→不可逆恢复→换书隔离→零第三方请求→CSP/SW/PWA→legacy 未迁移→顶栏瘦身（导出导入已进簿菜单、file input 不被菜单卸载、下拉键盘可达）→收尾零存储复核 |
| `scripts/check-book-store.mjs` | 199 | 设置守门、书名与文件名清洗、v1/v2 信封、导入防撞 |
| `scripts/check-week-start.mjs` | 148 | 15372 组周窗口 + 2196 组周号 + 月历前导格 + 四档统计区间 |
| `scripts/check-snapshot-policy.mjs` | 165 | 指纹、触发、分层淘汰、845 份留 500 份模拟 |
| `scripts/check-react-imports.mjs` | 79 | React 具名 API 是否都显式 import（I26） |
| `scripts/check-csp-hash.mjs` | 50 | `index.html` 内联脚本 sha256 与 `_headers` 是否一致（I25） |
| `scripts/check-day-drop.mjs` | 201 | 跨日期落点 + 12960 组扫描 |
| `scripts/check-slot-range.mjs` | 133 | 边缘缩放 + 2040 组扫描 |
| `scripts/check-event-clipboard.mjs` | 107 | 剪贴板规则 + 62640 组扫描 |
| `scripts/check-template-sort.mjs` | 141 | 排序引擎 ~70 条确定性断言 |
| `scripts/check-i18n.mjs` | 72 | 三语键集合与占位符一致性 |
| `scripts/make-icons.mjs` | 158 | 从 `favicon.svg` 生成 4 档 PWA 图标（无 sharp，自实现 PNG 编码） |
