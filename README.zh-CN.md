# 每日事件记录器（Event Logger）

[English](README.md) · **简体中文** · [日本語](README.ja-JP.md)

一个**单人自用**的每日时间记录工具：一天切成 10 分钟一格，拖拽记录"什么时间做了什么"，再按类别（工作 / 生活 / 学习）看统计与趋势。

现在它是一个可以直接发到公网的 PWA —— 而且**服务器上不存放任何用户数据**：网址可以公开访问，页面代码谁都能下载，但你记下的每一个事件只待在你自己的浏览器里。

---

## 三条硬承诺

| # | 承诺 | 落地方式 |
|---|---|---|
| 1 | **数据只存在用户端**，服务器零存储 | 所有读写走浏览器 IndexedDB（库名 `event-logger`）。线上只有静态文件：全站没有任何 POST / PUT / DELETE。`npm run smoke` 会把每一条网络请求抓出来复核"全部 GET、零请求体、零第三方、URL 里没有你的内容" |
| 2 | **每本 EventBook 自带周开始日期与语言** | `books` store 里一条记录 = 一本 EventBook，`settings.weekStartsOn`（0–6）与 `settings.language`（zh / en / ja）是**这本书**的属性。换书即换口径：周视图、日历表头、统计区间、ISO 周号全部跟着走 |
| 3 | **定期备份，历史版本可看可回**（恢复不可逆） | 自动快照（连续编辑期间每 15 分钟一份）+ 启动补快照 + 手动存档。"查看此版本"= 只读回放；"恢复此版本"= 先把当前内容自动存成 `pre-restore` 再落回旧内容。快照链**只追加不删除**，所以恢复之后还能再恢复回来 |

---

## 本地开发与运行

```bash
npm run dev      # Vite 5173（/api 代理到 3002，只有要迁移旧 data.json 时才需要后端）
npm run build    # 前端产物 → dist/（PWA 的 sw.js / manifest 一起生成）
npm start        # node server.js：只发静态文件 + 只读 legacy 探测，默认 http://localhost:3002
```

`start-server.bat` / `stop-server.bat` 仍然可用（按端口探测、反查 PID），但现在它只是一个"本地静态文件服务器"——停掉服务，数据也不会离开这台机器。开机自启那个 `EventLogger-AutoStart.vbs` 是个人机器上的便利脚本，里面写死了本机绝对路径，**不进仓库**（已列进 `.gitignore`）；要自启就在本机自建一个同名 vbs，内容只是 `ws.Run "<本仓库路径>\start-server.bat", 0, False`。

---

## 数据到底存在哪

浏览器 IndexedDB，库 `event-logger`（版本 1），四个 store：

| store | keyPath | 内容 |
|---|---|---|
| `books` | `id` | 每本 EventBook 的名称 + 设置（周开始日、语言、时间轴视口、统计档位）+ 时间戳 |
| `data` | `bookId` | 这本书当前的 `events` / `templates`，外加 `rev`（每次写 +1）与 `updatedAt` |
| `snapshots` | `id` | 历史版本：每份都自带完整 payload，可直接回放 |
| `meta` | `key` | 备份文件夹句柄（`backupDirectory`） |

- 首次启动会走"首启引导"：新建第一本 EventBook，或者（本机有的话）导入旧版 `data.json`。
- 导出 / 导入都在左上角的 EventBook 菜单里（「数据与备份」段）：可以只导当前这本，也可以导全部书。**导入永远是"新增 EventBook"，不覆盖任何已有内容。**
- 换设备 / 换浏览器的唯一办法就是导出再导入 —— 服务器上没有第二份可以拉。

### 历史版本与保留策略

快照的 `reason` 是枚举：`interval`（15 分钟节奏）、`startup`（距上一份超过 24h 时补）、`manual`（点了"💾 立即存档"）、`import`（导入时）、`pre-restore` / `restored-from`（恢复动作留下的一对）。

淘汰按分层：7 天内全留 → 8–30 天每个自然日留最早一份 → 31–365 天每个月留最早一份 → 总量上限 500 份。`manual` / `import` / `pre-restore` 三类**受保护**，淘汰永不删它们。指纹（canonical hash）相同则不重复存档。

### 可选：镜像到一个本地备份文件夹

历史面板里可以选一个文件夹（需要 Chrome / Edge 的 File System Access API），之后每份快照都会同步落成文件。同一个面板也能查看和修改它：连的是哪个文件夹、上次镜像到什么时候、这本书现在有几个版本，以及更换文件夹、重新授权、「🔄 把每份版本重新镜像一遍」、断开。

```
EventLogger Backups/
├── manifest.json                    # 书名 ↔ 目录、每份快照的指纹
└── <书名>/latest.json + snapshots/<ISO>.json
```

这个文件夹是你自己的（移动硬盘、坚果云、NAS 都行），因此"浏览器被清了"也不等于全丢。它只写不读：删掉文件夹不会影响应用运行。在面板里点"断开"也只是不再镜像，磁盘上已经写出去的副本一个都不动；换文件夹时会把所有 EventBook 的全部历史版本整体回补到新位置，不会留下一个"看着成功、其实是空的"目录。

### ⚠️ 会丢数据的情况

- **清除浏览器数据 / 卸载浏览器** —— IndexedDB 一起没了。公网部署没有任何服务器端副本可以找回。
- **无痕窗口** —— 窗口一关就没了；IndexedDB 完全不可用时界面会直接提示，不会假装保存成功。
- **系统存储紧张时驱逐**（尤其 iOS Safari / 移动端）—— 应用会申请 `persisted` 存储，但决定权在浏览器。

所以：长期数据请至少依赖"导出文件"或"镜像备份文件夹"其中一条。

---

## 改代码前后跑这些

```bash
npm run check    # 9 项纯函数与一致性检查（i18n / 排序 / 槽位 / 剪贴板 / 跨日拖拽 /
                 #   周口径 / 快照策略 / EventBook store / React import）
npm run smoke    # 无头 Chrome 端到端 18 步（真鼠标拖拽 + 直接读 IndexedDB + 网络指纹）
npm run csp:check # 内联脚本哈希与 public/_headers 是否一致
```

`npm run smoke` 覆盖的正是上面三条承诺：建书 → 每本书的周开始日与语言真的作用于整站 → 拖拽建事件 → 零存储指纹 → 手动存档与 hash 去重 → 快照结构不变量 → 改内容后回放旧版本、回放期写操作全被拦 → 恢复（不可逆 + 自动 pre-restore）→ 第二本书数据隔离 → 关掉再打开数据仍在 + PWA 注册 → 顶栏瘦身复核 → 收尾复核全程零非 GET 请求。

选项：`--stop-at=N` 只跑前 N 步、`--applog` 失败时打印页面日志、`--slow=MS` 放慢给人看、`--no-csp` 关 CSP、`--url=` 打已部署的站点、`--no-sandbox`（Linux/容器里 Chrome 起不来时才需要，CI 用的就是它）。

---

## 隐私边界（诚实版）

- 页面不发任何第三方请求：没有统计、没有 CDN、没有外部字体/图片，全部资源同源。
- 事件内容、EventBook 名字**从不出现在 URL 或请求体里**（冒烟测试逐条断言过）。
- 但 CDN 边缘节点仍会记录标准访问日志（IP、User-Agent、被请求的静态路径）。"服务器不存用户数据"指的是业务数据，不等于零日志。
- `robots.txt` 是 `Allow: /` —— 服务端本来没有任何可索引内容。

---

## 更多细节

设计意图与不变量清单见 `design.md`（改数据模型、周口径、快照策略之前请先读 §11）。

---

## 许可证

MIT，见 [`LICENSE`](LICENSE)。
