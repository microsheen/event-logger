# 把 EventLogger 发布到公网：全过程记录（含每一步的原因）

> 这是一份**运维纪实文档**，不是 README 的一部分。README 按约定只写本机怎么 build / 怎么跑测试；
> 「怎么上线、每一步为什么这么做、踩了哪些坑」全部写在这里，方便以后换域名、换账号、排障时照着复现。
>
> **凭证一律不落盘**：文中出现的都是占位符（`<ACCOUNT_ID>`、`<ZONE_ID>`、`<API_TOKEN>`）。
> 真实值只在两个地方存在：GitHub 仓库 Secrets 和你本机的 shell 历史。
>
> **本文已按「可进公开仓库」的标准脱敏**：企业 git host / 企业账号名 / 个人邮箱 / 本机绝对路径 /
> 所有凭证与各种 id 一律写成占位符。要换域名或换账号时照着装即可，不需要任何隐藏知识。

---

## 0. 一分钟看懂现状

| 项 | 值 | 备注 |
| --- | --- | --- |
| 正式站点 | https://daily-event-logger.com | Pages 自定义域名状态 `active`，HTTP→HTTPS 已 301 |
| www | https://www.daily-event-logger.com | 也是 `active`，但**与 apex 是两个不同 origin**（见 §11） |
| Pages 默认域名 | https://daily-event-logger.pages.dev | 与正式域名是**同一份产物**，已逐字节比对 |
| 托管方式 | Cloudflare Pages，Direct Upload（纯静态） | 项目名 `daily-event-logger` |
| 当前线上产物 | deployment `88d8109982f8f02952ddf22b4f7d386d32b1b769`（Direct Upload 以提交 SHA 作部署 id），来自 commit `88d8109` | 2026-10-01T13:27:40Z 上线（首条 `8abb842e` 仍永久可访问） |
| 发布通道 | GitHub Actions：`.github/workflows/ci-and-deploy.yml` | push master / PR / 手动 dispatch；每一次 run 的 id、耗时与产物变化都逐条记在 §13 时间线，别看这里的「最近一次」 |
| 上线开关 | 仓库变量 `DEPLOY_ENABLED = true` | 改成 `false` 即停止自动上线 |
| 域名 | Cloudflare Registrar 注册，`.com` | 2026-10-01 注册，2027-10-01 到期，**默认自动续费** |
| 仓库 | https://github.com/microsheen/event-logger （公开，MIT） | 从 GitHub Enterprise 迁出，历史压成一条初始提交后再无敏感 blob |

---

## 1. 三条硬承诺是怎么反向决定部署方案的

项目的三条承诺不是口号，它们对「上线」这件事有直接约束：

| 承诺 | 对托管方的要求 | 落地证据 |
| --- | --- | --- |
| ① 用户数据只存在浏览器，服务器零存放 | 只能选**纯静态托管**：不能有任何会接收写入的后端，不能为了「同步」加 API | CI 里 `browser-smoke` 这个 job 会断言**全程零非 GET 请求、零请求体、URL 里不出现用户内容**，且它是 `deploy` 的前置条件（blocking gate），不绿就发不出去 |
| ② 每本 EventBook 自定义周起始日与语言（zh/en/ja） | 状态全在 IndexedDB，服务器必须无状态 | 副作用要写清楚：**换设备 / 换浏览器 = 空应用**，这是设计而非 bug；导出→导入是唯一搬运手段 |
| ③ 定期备份、可看历史版本、可恢复（恢复不可逆） | 托管方必须老老实实服务静态文件、不许乱缓存、不许改写响应 | 强烈建议的「镜像到备份文件夹」用 File System Access API 写**浏览者本机**的文件夹，与托管在哪无关 |

另外一个隐性约束：**CSP 必须能生效**。`index.html` 里有一段防闪烁的内联脚本，靠 `public/_headers` 里的
`script-src ... sha256-...` 放行；所以托管平台必须允许自定义响应头 —— 这一条直接淘汰了 GitHub Pages。

---

## 2. 为什么选 Cloudflare Pages，而不是 GitHub Pages（或自己的 VPS）

- **GitHub Pages 不行**：它不允许自定义响应头，`Content-Security-Policy`、
  `Cross-Origin-Opener-Policy`、`Cross-Origin-Embedder-Policy`、`X-Frame-Options`、`Permissions-Policy`
  全都设不上去。这套应用的安全模型和 PWA 行为就建立在几个响应头之上，头没了，等于安全模型没了。
- **Cloudflare Pages 可以**：`_headers` / `_redirects` 文件即配置（跟产物一起进仓库、走 review、走 CI），
  免费档就够用，全球 CDN，自定义域名 + Universal SSL 免费，且 Direct Upload（`wrangler pages deploy dist`）
  意味着**构建在 GitHub Runner 上完成，Cloudflare 只当文件服务器** —— 不需要把源码交给它的构建系统。
- **每次部署有不可变 URL**：`<git-sha>.<project>.pages.dev`，回滚核对、事故复现都靠它。
- **它同样不给你存数据**（纯静态），正好与承诺 ① 一致 —— 不存在「顺手把用户数据写进 KV 吧」这种诱惑。
- 自己的 VPS / Express 反而危险：`server.js` 那种能读写 `data.json` 的形态一旦上公网，承诺 ① 立刻破。
  所以公网版本是**纯静态**，`server.js` 只保留在本机（`GET /api/legacy-data` 这类只读探测如今已无前端调用方，仅供开发机核对）。

---

## 3. 迁移到公开 GitHub（这是发布的前置动作，不是可选项）

### 3.1 为什么不是「把企业仓库改成公开」

原仓库在企业版 GitHub（host 与账号名在本文一律写作 `<enterprise-github>` / `<enterprise-account>`，不留真值）。最省事的做法似乎是改可见性，
但 git 的可见性是**对整个历史**生效的：一旦公开，历史里每一个 blob 都进了公网。而我们的历史里有：

- `data.json` —— 真实用户数据。哪怕只存在一版，承诺①就永久破产（别人能证明「这货存过服务器」）。
- 本机工作目录的绝对路径（含个人用户名）、`start-server.bat` / `EventLogger-AutoStart.vbs` 里的用户名与计划任务名，
  这些是「这台机器长什么样」的情报，公开仓库里没有任何理由存在。
- wrangler / Cloudflare 的本地凭证文件（`.dev.vars`、`.wrangler/` 缓存）。
- 企业域名、企业账号名，以及提交作者里的个人邮箱。

### 3.2 采用的做法：orphan 分支压成一条初始提交

```bash
git checkout --orphan public        # 丢掉全部 parent，只留当前工作树
git add -A && git commit -m "feat: local-first event logger (server stores nothing)"
git branch -D master                # 旧 master 上那些含敏感 blob 的提交整体作废
git branch -m master
git push -u <public-remote> master  # 推到 microsheen/event-logger（新仓库，全新历史）
```

**为什么压成一条而不是「先删敏感文件再补一条提交」**：删除提交不删历史，
`git log -p -- data.json` 或 `git show <老sha>:data.json` 依然能捞出来，公网仓库等于把秘密做成了永久存档。
orphan 从一开始就没写进去，才是真的没有。

**为什么公开前只做一次、而不是边推边 scrub**：只要有一个敏感 blob 进了公网，
就要靠 rewrite + force-push + 请 GitHub 清缓存来收拾，代价远高于事前一次性检查。

### 3.3 公开前 scrub 的 4 件事（逐项说为什么）

| # | 内容 | 为什么必须处理 |
| --- | --- | --- |
| 1 | `.dev.vars` / `.wrangler/` 不进仓库，并写进 `.gitignore` | 一旦泄露就是 Cloudflare 账号级入口；`.gitignore` 让「不再犯」变成机器约束而不是自觉 |
| 2 | `data.json`、`backups/`、`server.log`、`server.err.log` 全部忽略 | 用户数据与运行日志。日志里可能有事件标题片段，同样属于「不该上线的用户内容」 |
| 3 | `EventLogger-AutoStart.vbs` 忽略，`start-server.bat` 去掉绝对路径 | 本机开机自启的胶水脚本，含个人目录结构，对使用者无价值且暴露个人信息 |
| 4 | 企业标识与个人邮箱（remote、账号名、README 里的仓库血缘） | 公开仓库要把「这是谁的、从哪搬来的」降到最低；血缘段落后来也按你要求删了（`19d6ca2`） |

另外顺手改的：`package.json` 补 `license: MIT` 与 `repository.url`（公开包需要自我描述），
README 改成英文默认 + 中英日三份（`ad70793`），并按你的要求**只写本机部署**，
「怎么发布到公网」不进 README —— 它进了这份文档。

### 3.4 为什么选 MIT

- 三条承诺（本地存储 / 无账号 / 无服务端）意味着不存在「靠开源保护商业模式」的需求，授权越短越好。
- MIT 允许闭源衍生 → 别人可以把这个本地工具嵌进自己的私有分发里，采用率最大化。
- 与承诺的「你随时可以拿走自己的一切」立场一致：没有 copyleft 的传染约束。
- GPL 的代价（衍生必须同证、需要维护例外条款）对这个规模的项目是净损耗。

### 3.5 迁移留下的一个已知瑕疵

`e9b0559` 这条提交是用 **GitHub 网页编辑器**改 workflow 时生成的：author email 落成了个人 Gmail
（committer 是 `noreply@github.com`）。之后开的邮箱隐私开关**只对以后的提交生效**，洗不掉已推送的历史。
要不要 rewrite（rebase + force-push）见 §11 决策项 —— 而且注意：rewrite 会重放那条改动 workflow 的提交，
同样需要 `workflow` 权限。

---

## 4. CI/CD 流水线怎么搭（`.github/workflows/ci-and-deploy.yml`）

### 4.1 三个 job 的形状

```text
checks  ──┐
          ├─► deploy   （needs: [checks, browser-smoke]）
browser-smoke ─┘
```

| job | 名字 | 干什么 | 为什么这么设计 |
| --- | --- | --- | --- |
| `checks` | checks + build | `npm ci` → `npm run check`（9 条不变量检查）→ `npm run build` → `npm run csp:check` → 上传 `dist` artifact | 纯函数级 lint + 构建 + CSP 哈希同步校验，成本最低，先跑 |
| `browser-smoke` | e2e smoke (headless Chrome) | 下载 `checks` 的 `dist`，用真 Chrome 跑 18 步端到端 | 承诺①「服务器零存放」唯一能被机器证明的形式，**blocking**，不绿就发不出去 |
| `deploy` | publish to Cloudflare Pages | 下载同一个 `dist`，`wrangler pages deploy` | 只允许 push/dispatch 到生产分支，且 `vars.DEPLOY_ENABLED == true` |

### 4.2 为什么传 artifact，而不是每个 job 各自 build

两次独立 `vite build` 不保证产出逐字节相同（时间戳注入、依赖解析顺序、hash 命名都可能漂）。
如果 smoke 测的是 A 产物、上线的是 B 产物，那「测试通过」这句话对线上没有任何约束力。
传 artifact 让**被测过的字节 == 被上线的字节**，这也是 `deploy` 里还要 `test -f dist/_headers` 的原因：
artifact 完整性靠断言，不靠「应该没问题」。

### 4.3 为什么 smoke 必须是 blocking gate（不许为了放行而关掉）

smoke 里的关键断言（`scripts/e2e-smoke.mjs`）：

- 全程请求 `非 GET` 数量必须为 0；
- 带请求体的数量必须为 0；
- 任何 URL / 请求体里都不许出现测试事件内容或 EventBook 名（即「用户内容不上线」的直接反证）。

这三条是项目对外承诺的技术形式。让它变软（`continue-on-error`、注释掉 `needs`）等于对外说话不算数，
所以 workflow 顶部注释写明了「flaky 就修它，不要拆 gate」。

### 4.4 上线开关：仓库变量 `DEPLOY_ENABLED`

```yaml
if: ${{ github.event_name != 'pull_request' && github.ref_name == 'master' && vars.DEPLOY_ENABLED == 'true' }}
```

- 为什么不是「先删掉 deploy job」：删了以后要恢复就得改代码、走 review、动 workflow 文件（还撞 §10 的权限墙）。
  变量是数据不是代码，改一下即可停线，且审计上是一次明确的开关动作。
- 为什么不用 `secrets.*` 判断：变量在 Settings 里一眼可见，语义就是「配置」；secret 用来判断开关会把可审计性藏进密文。
- 为什么 job-level `if` 里把分支名写死成 `master` 而不是 `env.PRODUCTION_BRANCH`：
  **`if` 表达式看不到 `env` context**（只看 `vars` / `github` / `needs`），这是踩过的坑，注释里也留了提醒。

### 4.5 你要在哪贴凭证（Settings → Secrets and variables → Actions → *This runner* 分栏）

| 类型 | 名称 | 值 | 为什么 |
| --- | --- | --- | --- |
| Secrets | `CLOUDFLARE_API_TOKEN` | `<API_TOKEN>` | wrangler 认证；secret 才不会出现在日志与 step summary |
| Secrets | `CLOUDFLARE_ACCOUNT_ID` | `<ACCOUNT_ID>` | Pages API 的路径参数；不算严格机密，但没必要在公网仓库的日志里出现 |
| Variables | `DEPLOY_ENABLED` | `true` / `false` | 上线总开关（变量，不是 secret，理由见上） |

注意区分两个入口：**Repository secrets** 与 **Repository variables** 在同一个页面的不同 tab；
贴错 tab 的表现是 workflow 静默拿到空字符串（`vars.X` 读不到 secret，`secrets.X` 读不到 variable），
报错点会漂到很后面，所以 workflow 顶部把所需项写成了注释，方便对照。

### 4.6 其他几处刻意的设计

- `permissions: contents: read`：默认 `GITHUB_TOKEN` 权限过宽，这个流水线不需要写仓库。
- `concurrency.cancel-in-progress: true`：连着 push 时只让最后一个上线，避免旧提交抢在前的部署把线上拉回旧版。
- `npx wrangler pages project create ... || echo "project already exists"`：首次部署不需要人工先在控制台建项目，
  同时保证第二次以后重复执行无害（幂等）。
- `--commit-hash "$GITHUB_SHA"`：Pages 的部署详情页能直接反查 git 提交，事故时不用靠时间戳猜。
- 结尾把「站址 / pages.dev 默认域名 / 本次部署的不可变 URL / Custom domains 页」写进 `$GITHUB_STEP_SUMMARY`，
  让 run 页面自带上线回执。

### 4.7 已知小瑕疵（本轮已修，但要 push 之后才在线上生效）

smoke 步骤名一度写着「15-step」，脚本里实际已经是 18 步（新增「使用帮助」弹窗那一步之后）。
`ci-and-deploy.yml` 里的名字现已同步为 `18-step`。纯字符串，不影响断言行为，但它是 Actions 页面上给人读的承诺：
名字写少三步，看 run 的人会以为闸门比真实的宽松。

留一句提醒：改 `.github/workflows/*` 的提交必须带 `workflow` scope（§10 踩过的那堵墙），
本地改完 ≠ 线上生效，必须 push 才算；这条改动和其余文件一起走同一次 push 即可。

---

## 5. Cloudflare 侧准备（为什么要 API token，而不是 Global Key）

- **Global API Key 是账号级万能钥匙**：能改 DNS、能删域名、能读所有 zone。泄露一次等于整个账号没了。
- **API Token 可以做三件 Global Key 做不到的事**：限定权限范围、限定可操作的 zone/account、随时单独撤销而不影响别处。
  CI 里用的凭证应该满足「泄露后最坏影响 = 能重新部署这个站点」，而不是「能改我所有域名的解析」。

最终给 token 的权限（在 dash.cloudflare.com → My Profile → API Tokens → Create Custom Token）：

| 作用域 | 权限 | 什么时候需要 |
| --- | --- | --- |
| Account | Cloudflare Pages : **Edit** | `wrangler pages deploy` / `project create` / 读部署列表 |
| Zone | Zone : **Read** | 读 zone 列表与状态，确认域名进没进 account |
| Zone | Zone Settings : **Read + Edit** | 绑自定义域名（Pages domains 接口会读 zone 设置） |
| Worker | Worker : **Read + Edit** | Cloudflare 把 Pages 归在 Workers 平台下，不给就报权限不足 |
| Zone | Zone : **DNS : Read + Edit** | **后补的**：§7.3 需要自己建 CNAME，这是唯一一次因权限不够返工 |

**Account ID 在哪看**：控制台右侧栏「Account ID」，或任何页面 URL 里 `dash.cloudflare.com/<32位十六进制>` 的那一段。

**安全提醒**：本次的 token 字符串在聊天里明文出现过。文档不复制它（写 `<API_TOKEN>`），
但建议去控制台 **Roll** 一次，然后把 GitHub 那个 secret 改成新值即可 ——
凭证只是字符串，**改权限不需要换字符串，换字符串不需要重跑绑定**。

---

## 6. 项目名与首次部署

### 6.1 Pages 项目名是全局唯一、且创建后不可改名

`<project>.pages.dev` 是公网可路由的名字，所以 Cloudflare 用**全局唯一**约束它；
而名字同时出现在部署子域名里，改名等于换域名，因此**不提供改名**。
结果：`event-logger` 已被陌生人占用 → 定名 **`daily-event-logger`**。

连带改动（名字散在 4 个地方，全部要一致，否则「本地能部署、CI 部署到另一个项目」）：

1. `package.json` 的 `deploy` 脚本 `--project-name=daily-event-logger`（`28a36d5`）
2. workflow 的 `env.PROJECT_NAME`（`e9b0559`）
3. `design.md` 里 `npm run deploy` 那行说明（`32c175b`）
4. 仓库里已创建的 Pages 项目本身（当时还是新建，无历史包袱）

### 6.2 首次生产部署

| 项 | 值 |
| --- | --- |
| 触发 | `workflow_dispatch`，run `36811216896`（2026-10-01T03:35:33Z） |
| 结果 | checks / browser-smoke / deploy **三 job 全绿**（success） |
| 产物 | deployment `8abb842e`，来自 commit `32c175b` |
| 落地 | https://daily-event-logger.pages.dev → HTTP 200 + 完整安全头 |

同一 commit 在 02:18:19Z 也有一次 push 触发的成功 run（`36805200701`），
说明「push 自动上线」这条路径同样是通的；手动 dispatch 那次只是用来确认「开关语义正确 + 拿到干净回执」。

### 6.3 为什么之前访问 `pages.dev` 返回 522（这不是坏了）

**Pages 项目创建 ≠ 有内容**。`project create` 只建了一个空壳，没有任何 deployment 时，
边缘节点找不到源站，直接 522。当时看到 522 的第一反应是「绑定失败」，实际是「还没部署过」。
判断依据很简单：读 Pages 的 deployments 列表，空的 → 先跑一次 deploy，别看 DNS。

---

## 7. 绑定自定义域名 `daily-event-logger.com`（三个坑）

### 7.1 先说清「哪些花钱、哪些免费」

- **域名本身不免费**：`.com` 走 Cloudflare Registrar，约 **10.46 USD / 年**，2026-10-01 注册，**2027-10-01 到期**。
- Cloudflare Registrar 是成本价（不加价、无溢价续费），但**默认开启自动续费** —— 这是最容易踩的钱坑：
  不想续的要主动去关（Registrar → Domain Retention / Auto-Renew）。
- **免费的**是这些：DNS 解析、CDN、Universal SSL（含通配证书）、WHOIS 隐私、以及「把域名绑到 Pages」这个动作本身。
  也就是说：**上线不花钱，拥有这个名字才花钱**。
- 到期时间不用登控制台也能核对（公开数据，适合脚本化验证）：

```text
https://rdap.org/domain/daily-event-logger.com
```

  本机环境下 `rdap.verisign.com` 与 `dns.google` 都超时，只有 `rdap.org` 这个聚合入口能通 —— 
  这类「哪个上游能通」的差异必须实测，不能照抄文档里的示例域名。

### 7.2 `8000015 invalid TLD` 是个假错误（方法论比结论有用）

按 Pages 文档给 `POST /pages/projects/<name>/domains` 传 body，稳定返回：

```json
{ "success": false, "errors": [ { "code": 8000015, "message": "invalid TLD" } ] }
```

**对照实验**：换成一个绝对合法的 `example.com`、换成不可能存在的 `foo-bar.test`、甚至换成空 body ——
三个都返回同一个 `8000015`。当错误码与输入**无关**时，它就不是输入校验失败，而是「字段名没认出来，
于是按空域名报错」，`invalid TLD` 是空域名的副产物。

结论：**字段名是 `name`，不是文档里/社区帖里常见的 `rel`**。

```javascript
// 正确
{ name: 'daily-event-logger.com' }
```

反证：后来把 `{ rel, name }` 一起发上去，返回的是 `8000018 already added`（域名已在 §7.3 之前加过一次），
说明第一次其实已经受理了名字，只是校验路径没走到成功分支。
另：`PATCH /pages/projects/<name>/domains/<domain>`（**不带 body**）是让 Pages **重跑一次校验**的手动入口，
状态卡在 pending 时比新建域名更快看到结果。

### 7.3 加完域名仍 `pending`：`CNAME record not set`

文档写着「Cloudflare 会替你创建 CNAME」—— 那句话的前提是**你在控制台走域名向导**。
**走 API 时不会代建**，必须自己在 zone 里建记录：

```javascript
// POST /zones/<ZONE_ID>/dns_records
{ type: 'CNAME', name: '@',   content: 'daily-event-logger.pages.dev', proxied: true, ttl: 1 }
{ type: 'CNAME', name: 'www', content: 'daily-event-logger.pages.dev', proxied: true, ttl: 1 }
```

| 细节 | 为什么 |
| --- | --- |
| 必须 `proxied: true`（橙云） | Pages 的自定义域名靠 Cloudflare 边缘回源；**灰云直连会 525/522**，表现和「没部署」很像，容易误判 |
| apex 也能用 CNAME | Cloudflare 在 DNS 层做 **CNAME flattening**，对外返回 A/AAAA，绕开「根域不许有 CNAME」的 RFC 限制 |
| `ttl: 1` | proxied 记录必须是自动 TTL |
| 第一次建记录报 `10000 Authentication error` | token 缺 `Zone / DNS / Read+Edit`（§5 表格里最后那一行就是为此补的）；补齐权限**不换 token 字符串**，所以 GitHub secret 不用重填 |

建完两条记录约 2 分钟后 Pages 侧变 `active`。
期间 HTTPS 其实**已经通了**：Universal SSL 给 zone 签的是 `*.daily-event-logger.com` 通配证书，
域名一进 zone 就覆盖到它；`active` 只代表 Pages 确认了「这条自定义域名归属这个项目」，不是证书就绪信号。
理解这个差别很有用 —— 它告诉你「状态灯」和「可用性」是两件事，别拿灯当验收。

---

## 8. 上线后的验收（比字节，不靠「看起来一样」）

### 8.1 三个 host 必须逐字节一致

比对的动机不是「域名能不能打开」，而是证明**自定义域名只是别名，不存在第二份内容**。
如果 apex 与 pages.dev 产物不同，说明中间有缓存改写或第二套构建，承诺③（历史版本可核对）就失去锚点。

| 资源 | apex `daily-event-logger.com` | `www` | `pages.dev` |
| --- | --- | --- | --- |
| `/`（index.html） | 200 / 1904 B（两种请求头都一样；2026-10-01 之前浏览器式请求头是 2271 B，见 §8.4） | 同 apex | 200 / 1904 B（两种请求头都一样） |
| `/sw.js` | 200 / 2318 B | 相同 | 相同 |
| `/manifest.webmanifest` | 200 / 651 B | 相同 | 相同 |
| `/robots.txt` | 200 / 94 B | 相同 | 相同 |
| `/favicon.svg` | 200 / 666 B | 相同 | 相同 |
| `/icons/apple-touch-icon.png` | 200 / 2412 B | 相同 | 相同 |
| `/assets/index-DE2uwppR.js` | 200 / 311555 B | 相同 | 相同 |
| `/assets/index-B0WePlwz.css` | 200 / 1776 B | 相同 | 相同 |
| 安全头（9 项，键与值） | 完全相等 | 完全相等 | 完全相等 |

口径提醒：上面的数字是 `arrayBuffer.byteLength`（UTF-8 字节）。中途有一份记录是按解码后的**字符数**写的，
中文资源会明显偏小（例如 index.html 1802 字符 vs 1904 字节）。两者都对，混用会误判成「线上被改过」——
所以核对脚本要先固定口径。

还有一层口径比「字符 vs 字节」更要命：**请求头**。见 §8.4。

### 8.2 安全头来自 `public/_headers`（构建时原样拷进 `dist/`，不进任何 JS bundle）

线上实际值（三 host 相同）：

```text
default-src self; script-src self + sha256-w0gKEdhip21a3vtClMag76dqpcHXt7xV2h45snx7F5M;
style-src self + unsafe-inline; img-src self data:; font-src self data:; connect-src self;
object-src none; frame-ancestors none; base-uri self; form-action self; upgrade-insecure-requests

X-Frame-Options: DENY          X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer   X-XSS-Protection: 0
Cross-Origin-Opener-Policy: same-origin        Cross-Origin-Embedder-Policy: require-corp
Permissions-Policy: accelerometer/camera/geolocation/gyroscope/magnetometer/microphone/payment/usb 全禁用
Cache-Control: /index.html /sw.js /manifest.webmanifest = no-cache；/assets/* 与 /workbox-*.js = immutable 一年
```

- **那串 sha256 是什么**：`index.html` 里内联的引导脚本（React 挂载前定语言，避免首屏闪烁）。
  CSP 只按内容哈希放行这一段，而不是放开 `unsafe-inline` —— 这是「最小例外」的写法。
  改脚本后必须 `npm run csp:check` 同步哈希，CI 里这一步是 gate，专门防「本地正常、线上白屏」。
- **`style-src unsafe-inline` 是被 React 逼的**：内联 style 属性与动态样式表需要它；
  因为 `script-src` 收紧了，样式侧的这点宽松不构成执行风险。
- **换域名零改动**：`_headers` 里没有任何硬编码域名（全是 self 系）。这就是 §2 说的「安全模型建在响应头上」，
  也是它必须在托管平台层生效的原因。
- **HTTP 已强制跳 HTTPS**：apex 与 www 的 `http://` 都 301 到 `https://`。
- **一处待补**：响应里**没有** `Strict-Transport-Security`（HSTS）。补法有两种：在 `_headers` 加一行，
  或在控制台 SSL/TLS → Edge Certificates 开 HSTS。见 §11 决策项。

### 8.3 未知路径返回 200 + index.html，包括 `/api/legacy-data`（无害，但要能解释）

Pages 对 SPA 做 history fallback：不存在的路径也回 `index.html`（HTTP 200），不是 404。
所以 `GET /api/legacy-data` 会「看起来像个接口」。它无害，两点理由：

1. 公网**没有这个接口**。`/api/legacy-data` 只存在于本机 `server.js`（把老 `data.json` 读进来做迁移探测）。
2. **已无前端调用方**：随首启引导页一起移除的「本机旧 `data.json` 一键迁移」入口（`src/utils/legacyFetch.js` 已删）之后，前端不会再请求这个路由，它只保留给开发机手工核对；旧 `data.json` 改走 EventBook 菜单里的「📥 导入为新的 EventBook」。

返回体是 HTML 而不是 JSON，这本身就是「服务器没有任何写入口/读入口」的证据。
（想更干净可以给 `/api/*` 加 `_redirects` 指向 404，属于优化，不属于修复。）

### 8.4 zone 上的 Web Analytics 会自动注入第三方 beacon（只有浏览器式请求头才看得见）

- **现象**：用浏览器式请求头（Chrome UA + `Accept: text/html` + `Sec-Fetch-Mode: navigate`）取 `/`，
  apex 与 `www` 返回 **2271 B**，`pages.dev` 返回 **1904 B**（B 指字节数 = `Buffer.byteLength`；同一份 HTML 的字符数是 2169 / 1802，两个口径别混。1904 B 与本机 `dist/index.html` 逐字节相等，注入多出来的 367 B 就是下面那一行 `<script>`）。差的是 Cloudflare 按 **zone 级 Web Analytics
  自动安装**插在 `</body>` 之前的那一行（`pages.dev` 不在这个 zone 上，所以不注入）：

  ```html
  <script type="module" src="https://static.cloudflareinsights.com/beacon.min.js/v31edd..."
    integrity="sha512-iIg7k2xntmwu6/uSb5tpc/hySgZc4eoL31yB29W6tJFo2akwjPWcEqnCEdJvGexCL0KEQwVYv5BlowfhVz26hg=="
    crossorigin="anonymous"
    data-cf-beacon='{"version":"2024.11.0","token":"<BEACON_TOKEN>","r":1,"spa":2}'></script>
  ```

- **为什么 §8.1 的逐字节比对抓不到它**：node `fetch` / curl 默认 `Accept: */*`、没有 `Sec-Fetch-Mode: navigate`，
  Cloudflare 判定这不是人在浏览页面，**不注入**，于是三 host 的 HTML 又完全相等。「逐字节全等」和「被注入」
  能同时为真，取决于谁去取——这不是文档自相矛盾，是必须写死的比对口径。
- **它打破什么**：承诺「零第三方请求」——真实浏览器会去连 `static.cloudflareinsights.com`。而 beacon 若真跑起来，
  它还会往同源 `/cdn-cgi/rum` **POST** 性能数据，那连「所有请求都是 GET」这条也一起破了。
- **为什么用户数据仍然没出去**：本页 CSP 是 `script-src 'self' 'sha256-w0gKEdhip21a3vtClMag76dqpcHXt7xV2h45snx7F5M='`，
  不含这个域，Chrome **当场拦下脚本执行**（控制台留一条 CSP violation），所以没有任何东西被发出去。
  拦下是兜底，不是解决。首轮线上 smoke 的 9 条红里有 **7 条**是它：「零 JS 异常 / 零 CSP 违规」3 处、
  「镜像块渲染零 JS 异常」、「帮助面板全程零 JS 异常」、「零第三方」、「全程零跨域」（另 2 条是 §9.3 那两个脚本抖动）。
  同一套产物在本地跑 18 步全绿——本地那个随机端口服务器不属于这个 zone，没人给它注入。
- **修法（只有持有该 Cloudflare 账号的人能做，仓库侧改不了）**：
  1. 控制台 → **Analytics & Logs → Web Analytics** → 选中 `daily-event-logger.com` 站点 →
     **Manage site → Advanced Options** → 把 **Automatic setup / JS Snippet injection** 设为 **Disabled** → Update。
     **⚠️ 本账号里没有这个下拉框**，见下面「实际结案」。
  2. 再看 **Workers & Pages → `daily-event-logger` → Settings → Web Analytics**，项目级也有一个开关，两处都要关。
  3. 访问量统计本来就不要 → 直接 **Delete site** 更彻底（那个 token 已经随 HTML 公开在公网，上面抄录时写作 `<BEACON_TOKEN>`，
     删站点顺手作废它）。删的只是 Analytics 的站点属性：域名、Pages 项目、产物、安全头一概不动。
- **✅ 实际结案（2026-10-01 15:03Z，走第 3 步）**，顺带纠正两处传闻：
  - **本账号 `Advanced Options` 展开后只有「Web Analytics Rules（要 Pro 套餐才给用）」的升级推销和一个红色 Delete，
     根本没有 Automatic setup 下拉框**——就是社区 cloudflare/workers-sdk#14552 / #15898（"Disabling Web Analytics for
     Pages is no longer possible"）说的情形。所以对本项目唯一可操作的入口是 **Delete**；**不要为此升级套餐**，
     付费买到的是过滤规则，不是「停止注入」。
  - **Delete 之后注入立刻停止，并不需要再发一次部署。** 官方文档与社区的说法是「注入发生在部署时，关掉要等下一次
     Pages 部署才消失」，本例不成立。教训：**先复验，再决定要不要发空提交**，别白跑一轮 CI。
  - 15:04Z 复验：三 host 带浏览器式请求头取 `/` 全部回到 **1904 B / 1802 字符**，`data-cf-beacon`、`cloudflareinsights.com`、
     `cdn-cgi` 全无，9 项安全头原样。与本机 `dist/index.html` 只差 asset 文件名的 hash（跨环境不稳定，见 §13 那条 14:12）。
  - **15:20Z 再复验一次「新部署会不会把注入带回来」**（`d2f5420` 的 CI 于 15:18:01 发出 deployment
    `27ce420b`，job 收尾 15:18:04）：三 host 带浏览器式请求头取 `/` 仍是 **1904 B**，`data-cf-beacon` /
    `cloudflareinsights.com` / `cdn-cgi` 全无，**HTML 里的第三方 URL 数为 0**，CSP 与 9 项安全头原样；
    线上 smoke 在 HEAD 的分离 worktree 里跑，构建号自报 `d2f5420f-20261001151631`（证明测的就是这次部署），
    18 步 196 条断言、0 红、全程 33 个请求方法分布 `{"GET":33}`。结论：**关掉不需要靠部署生效，部署也不会把它加回来**
    ——「注入发生在部署时」这条理论在本例双向都不成立。
  - **关掉之后一共验到第三个独立部署，两次追加复验同一结论**：`1534725` 的部署 `6d7ce44f`（CI 15:35:45Z 完成）
    之后 15:37Z 取一次，`87c21e3` 的部署 `29da0643`（CI 19:09:46Z 完成）之后 23:58Z 取一次——三 host 带浏览器式请求头
    每次都回到同一份 **1904 B / 1802 字符**，`data-cf-beacon` / `cloudflareinsights.com` / `cdn-cgi` 全无，
    **HTML 里的第三方 URL 数为 0**，`_headers` 的 8 个响应头与 CSP hash `sha256-w0gKEdh…` 原样
    （`Strict-Transport-Security` 依旧没有，见 §8.2 待补那条）。**23:58Z 那次顺手把线上 smoke 又打了一遍**
    （HEAD 的 `--detach` worktree，零依赖）：`data-build="87c21e3f-20261001190814"`（对得上 `29da0643`）、
    **196 条 ✓ / 0 条 ✗**、33 个请求 `{"GET":33}`。至此「部署不会把注入带回来」有**三个独立样本**，不再是一个——
    但也只有三个，别写成「反复验证过很多次」。
- **怎么确认真的关掉**：带浏览器式请求头再取一次 `/`，`data-cf-beacon` 应当消失、字节数回到 **1904**（与本机产物只差一个
  asset hash）；再 `node scripts/e2e-smoke.mjs --url=https://daily-event-logger.pages.dev`，应 18 步全绿（apex 若被公司
  网关拦，见 §9 的绕法）。**2026-10-01 15:06Z / 15:20Z / 23:58Z 已按此验过三次：
  每次都是 196 条断言、0 红；后两次紧跟一次全新部署，见上面「实际结案」里那两个样本。**
- **别用的歪路**：把 `static.cloudflareinsights.com` 加进 CSP 白名单能让控制台安静，但那等于亲手把
  「零第三方」的承诺改掉——要关的是注入，不是报警。

---

## 9. 从公司网络打线上 smoke 会红：Zscaler 拦截，不是应用缺陷

- **现象**：`npm run smoke` 指向线上域名时，「所有请求都是同源」这条断言失败；
  页面文字变成 `C03 Are you sure you want to visit this site?...`，抓到的跨域 URL 是
  `gateway.zscalerthree.net` / `login.zscalerthree.net`。
- **判定**：企业 TLS 网关对**刚注册的陌生域名**做拦截/重分类跳转。请求确实跨了域，断言没有误报，
  错的是网络环境。同一套产物在 CI（GitHub Runner，不受公司网关约束）里 18 步全绿。
- **影响面**：只有这台企业机。手机热点或等域名被重新分类就好。
- **可选缓解**：在网关提示页点 Continue 放行一次；请 IT 加白；或者干脆不在本机打线上（验收以 CI 为准）。
- **绕法（15:06 实测有效）**：同一份产物也挂在 `daily-event-logger.pages.dev`，那个域名不在公司网关的拦截名单里。
  要拿「线上全绿」这个结论时打 `--url=https://daily-event-logger.pages.dev`，别在 apex 上重试到怀疑人生。两者产物逐字节
  相同（§8.1），所以这个结论对 apex 同样成立。
- **2026-10-02 00:12Z 修正上面那条的归因**：`pages.dev` 能通不是因为「那个域名不在名单里」，而是这次请求
  恰好没走代理。同一时刻 node `fetch`（直连、不读 PAC）取 apex 与 `www` 都是 **200 / `server: cloudflare` /
  1904 B / 同一份 `index-DtlSh-MB.js` / 零 beacon**；`Invoke-WebRequest` 默认吃系统 PAC 兜底的 `PROXY 127.0.0.1:9000`，
  对**同一个 apex URL** 返回 403。所以「换 host 就好」是巧合，真正要控制的是走不走代理——本机打线上一律用
  node（第 1 条已经这么写了），并且别把 `Invoke-WebRequest` 的状态码当成站点的状态码。smoke 用 `--url=` 时走的是
  Chrome，Chrome 读 PAC，所以 apex 上那次 `C03` 拦截页确实来自代理链路：换成 `pages.dev` 只是让它少一跳。

顺带四条同类经验（前三条是「本机网络 / 本地秒开 vs 真实用户视角」，第 4 条是「本机跑一千遍都绿、CI 上偶发红」）：

1. 本机 `curl.exe` 会报 schannel `CRYPT_E_REVOCATION_OFFLINE`（吊销列表取不到），而 node `fetch` 正常。
   **验证一律用 node**，别在 curl 上浪费时间。
2. `git push` 偶发 `Failed to connect to github.com port 443`。**根因不是 GitHub，也不是「只能重试」，是 git 不走
   这台机器的代理**：`github.com` 的 DNS 被网关改写成 `20.27.177.113` 这类网关地址，直连它的 443 时通时不通
   （15:13Z 与 15:15Z 两次 push 都报这个错；15:19Z 再用 `Test-NetConnection github.com -Port 443` 测又 3/3 通）。
   同期浏览器和 `Invoke-WebRequest https://github.com` 一直是通的、`api.github.com` 也全程可用
   （`gh run view` 一切正常）——原因是系统 PAC（`AutoConfigURL=http://127.0.0.1:9000/localproxy-*.pac`）
   兜底 `return "PROXY 127.0.0.1:9000"`，而 **git 从不读 PAC，只会直连**。所以「网页能开、git 连不上」并不矛盾。
   - **两条路各自都会抽，一条不通就换另一条**（别说什么「确定性绕法」）。本轮同一台机器上的实测样本：
     15:13Z 与 15:15Z 直连两次**快速失败** → 15:16Z 走代理 **7.6 s 一次就通**（`aa45a1c..d2f5420`）
     → 15:19Z 直连又 3/3 通 → 15:28Z 走代理的 push **挂住不返回**（>1.5 min）→ 15:30Z 换回直连 **6 s 发上去**
     （`d2f5420..d8b0d46`）。同一条链路一会儿最快一会儿最慢，所以值得做的是「换路 + 设超时」，不是迷信某一条。
   - **push 必须带超时**：git 默认没有连接超时，代理链路挂住时 `git push` 会**无限等**。本轮两个挂死样本：
     15:28Z 那条代理 push 一直挂着（15:31Z 的进程表里 `git-remote-https` 还在），最后是换直连才把提交发上去；
     15:30:18Z 我另发的一条代理 `ls-remote` 挂到 15:36Z，进程树 `43228→79660→34696→55180` 只能手杀。
     所以带 `-c http.lowSpeedLimit=1000 -c http.lowSpeedTime=20`（20 s 内低于 1000 B/s 就中断），
     能让**传输阶段**的停滞早点失败。**但它既管不住连接阶段，也不能保证「没推上去」——见下一条**。
   - **`timeout` 只保护调用方，保护不了后台：本轮最贵的一个样本（`87c21e3` 的 push）**。为了把它推上去我跑了个
     detached 重试循环：direct / proxy 交替，每击 `execFileSync('git', …, { timeout: 20000 })`，自己往
     `_push_retry.log` 追加行。15:37:47Z 启动，逐击记录：`#1 direct FAIL 20008 ms`（`spawnSync` 报 `ETIMEDOUT`）
     → `#1 proxy FAIL 18896 ms`（`Operation too slow`，这条说明 `lowSpeedTime` 在传输阶段真的生效了）
     → `#2 direct FAIL 20009 ms` → **`#2 proxy FAIL 12509190 ms`**（git 自报 `Connection timed out after
     12507567 ms`）→ `#3 direct FAIL 20027 ms` → **19:07:52Z 循环用 `git branch -vv` 判 LANDED**。三条结论：
     - **纯连接挂住时 `http.lowSpeedTime` 不参与**（它量的是连上之后的传输速率），所以那一击实打实等了
       **3 h 28 min**；能兜住它的只有调用方自己的超时。
     - **调用方超时杀的是 `git.exe`，不是它的孙子 `git-remote-https`**：后者带着已协商好的会话继续在后台跑，
       而 ref 最后就是被某次「已判失败」的调用留下的后台进程推上去的（指认不出是哪一次）——落地判定 19:07:52Z
       距 `#2 proxy` 返回（≈19:07:15）只有 37 s，而**整个循环没有任何一击返回过成功**。
       所以 **push 的返回值不是事实来源，refs 才是**：报失败后、重试前，先看 `git branch -vv` 里 `ahead`
       有没有消失（或 `git ls-remote` 对 SHA），否则会重复推、或把已经成功的 push 误判成「远端坏了」。
     - 重试循环必须**自带判据**（每击之后查 refs），不能只靠退出码决定要不要继续。
   - 代理参数只写成一次性 `-c http.proxy=http://127.0.0.1:9000`，**别 `git config --global http.proxy` 固化**：
     那个本地代理是公司机器上的进程，换网络或它没起来时，固化会把本来能直连的 push 全钉死。
   - **先分清报错类型**（这条不变）：`refusing to allow an OAuth App...` 是权限问题（见 §10）；
     `Failed to connect` 是网络/代理问题，不要去改凭证。13:38–13:44 那次连续 4 次失败、第 5 次才通，
     当时按「抖动」记的，现在看同属这条——直接加 `-c http.proxy=` 就不必重试 5 遍。
3. `--url=` 打远程站点会暴露 smoke 脚本自己的两处抖动（本地秒开永远撞不上，本轮已修在
   `scripts/e2e-smoke.mjs`）：① 定位助手是 `Page.addScriptToEvaluateOnNewDocument` 注入的，`document-start` 就装好，
   那时 `document.body` 还不存在，第一处 `document.body.innerText` 直接抛 null，整步白屏诊断也跟着废掉；
   ② 助手找不到元素时返回 `{ err: ... }`，而对象是**真值**，于是 `until(() => call('clickable', ...))` 把「没找到」
   读成「已就绪」直接放行，下一步就报「找不到点击目标」（本轮第 16 步就是这么倒的）。
   现在等待条件统一过 `ready()`（`{ err }` 判为未就绪），并且等 `body` 出现、等 `#root` 真挂上才打启动诊断。
   顺带一条：这条 Zscaler 拦截**时通时不通**，同一台机器连着打两次线上，可能一次跑完 18 步、另一次在第 1 步就
   停在 `C03 Are you sure...` 的拦截页上——后者红的是网络环境，别当成回归。
4. 不变量检查里的**毫秒边界**抖动（14:18 那条纯文档提交就是这么红的）：`scripts/check-template-sort.mjs`
   的 `ago(days)` 每次调用都读一遍 `Date.now()`，而断言写成 `eq(..., merged.createdAt, ago(60))` —— 拿
   「建 fixture 时算出的串」和「跑断言时重算的串」比字符串。本机通常在同一毫秒内跑完，永远相等；CI 上两次
   调用跨到下一毫秒就固定差 1ms，于是报「导入合并不伪造 createdAt / updatedAt」——和提交内容毫无关系。
   修法：基准时钟只取一次（`const NOW = Date.now()`），改完连打 40 遍 0 红。**判据**：断言里凡是在重算
   fixture 的期望值，就不许再读当前时间；比时间戳一律用「同一份常量」或允许误差的 `Math.abs(...) < n`。

---

## 10. 收尾提交为什么第一次推不上去（GitHub 的 workflow 权限墙）

### 10.1 现象

```text
remote: error: refusing to allow an OAuth App to create or update workflow
remote:   `.github/workflows/ci-and-deploy.yml` without workflow scope
```

本地那条提交 `062aacc` 同时改了 6 个文件：README（en/zh-CN/ja-JP）、`design.md`、`.gitignore`、
以及 `.github/workflows/ci-and-deploy.yml`（加 `SITE_URL`、把摘要里的链接改成自定义域名）。
**只要一个提交碰了 workflow 文件，整条提交就被拒**，不是只跳过那个文件。

### 10.2 为什么 GitHub 要这么设计（以及为什么不该绕）

workflow 文件 = 在仓库里执行任意代码的权力。如果「改 CI」可以跟着一堆文档提交悄悄进去，
那么被污染的令牌就能静默改写上线逻辑（比如把 secrets 发到外部）。
所以 GitHub 要求 OAuth 令牌显式持有 `workflow` scope —— 这是一道**故意设置摩擦**的闸门。
绕开它的办法（拆提交、把 workflow 改动放到网页编辑器里手改）都存在，但代价是把「文档」和「流水线」拆成两次上线，
而且 YAML 在网页里没有本地校验，恰恰是最容易写错的那类文件。所以选择走正规授权。

### 10.3 试过但无效的旁路

- **改用 SSH push**：`ssh -T git@github.com` 认证成的是另一个个人账号（这台机上的 SSH key 属于它，不是本仓库 owner），
  于是 `Permission to microsheen/event-logger.git denied`。换协议不解决「谁在推」。
- **只推文档、workflow 留到以后**：可行，但会让本地与远端长期分叉，且 workflow 里的错误链接继续留在公网。

### 10.4 实际解法（设备码流，5 分钟窗口）

```bash
gh auth refresh -h github.com -s workflow
# 1) 终端打印一次性码 C734-XXXX 与 https://github.com/login/device
# 2) 在已登录 microsheen 的浏览器里输入码 → Continue → Authorize
# 3) gh 自己轮询到令牌，写回 keyring
git push origin master      # 32c175b..062aacc
```

- **为什么码一直「过期」**：设备码有效期 15 分钟，而它必须**在已登录目标账号的浏览器**里输入。
  之前两次失败分别是：超时，以及浏览器停在登录页（`github.com/login?return_to=...`）。
- **凭证检查**：授权后 `gh auth status` 的 Token scopes 应包含 `workflow`：
  `gist, read:org, repo, workflow`。
- 结果：远端 master = `062aacc`，run `36841446225`（push 触发，2026-10-01T09:14:42Z）开始跑三 job。

---

## 11. 还需要你决定的 7 件事（按优先级）

| # | 事项 | 现状 | 影响 | 建议 |
| --- | --- | --- | --- | --- |
| 1 | **www 与 apex 是两个 origin** | 两者都能独立打开、内容相同 | 用户在 `www.` 上记的数据，切到 apex 就看不见（IndexedDB 按 origin 隔离）。这是**数据一致性风险**，不是美观问题 | 加一条 Redirect Rule：`www.daily-event-logger.com/*` → `https://daily-event-logger.com/$1` 301，从此只认一个 origin |
| 2 | `pages.dev` 是否收口 | 三个 host 全部公开可访问 | 搜索引擎会看到重复内容；但保留它是回滚核对的锚点 | **不要重定向**，改为给 `pages.dev` 加 `X-Robots-Tag: noindex`（Pages 支持按 host 设头），锚点与 SEO 两头都要 |
| 3 | **workflow 摘要里那个 URL 是错的** | `echo 'This deployment: https://$GITHUB_SHA.$PROJECT_NAME.pages.dev'` | 实测：完整 commit sha 那种写法 **404**；Pages 用的是自己的短 deployment id —— `https://8abb842e.daily-event-logger.pages.dev` 实测 **200** | 现在已有 `workflow` 权限，直接改成从 `wrangler pages deployment list --json` 取真 id（顺手把 smoke 步骤名同步成 18-step 那半已经做掉了，见 §4.7） |
| 4 | HSTS 缺失 | 无 `Strict-Transport-Security` | 首次访问仍可能被降级/改写（对企业网络尤其有意义） | `_headers` 加 `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`，或控制台开 HSTS |
| 5 | **API token 在聊天里明文出现过** | 权限含 Pages:Edit + Zone DNS:Edit | 能重新部署这个站点、能改这两条 CNAME | 去控制台 **Roll**，然后只更新 GitHub 的 `CLOUDFLARE_API_TOKEN` secret（字符串变了不用重跑任何绑定） |
| 6 | 历史里那条 Gmail + 域名自动续费 | `e9b0559` 的 author 是个人 Gmail；`.com` 默认自动续费（10.46 USD/年，2027-10-01 到期） | Gmail 已在公网历史里；续费不关的话明年会自己扣钱 | Gmail 要不要洗由你定：rewrite 会重放那条碰 workflow 的提交，**同样需要 `workflow` scope**（现在有了，随时可做）；续费开关建议现在就去看一眼 |
| 7 | ~~关掉 zone 上的 Web Analytics 自动注入~~ **✅ 15:03 已关（Delete 站点属性）** | 曾经：apex / `www` 的 HTML 被插入 `static.cloudflareinsights.com/beacon.min.js`，执行被自家 CSP 拦下 | 现在：三 host 带浏览器式请求头都是 1904 B、无 beacon；线上 smoke 18 步 196 条断言全绿（§13 15:06）。「零第三方」不再靠 CSP 兜底 | 复验口径见 §8.4 末尾。日后若要用 Web Analytics，走 **Manual setup**（自己粘 snippet），别再开自动注入 |

补充说明（不算决策，但要知道）：**中国大陆访问 Cloudflare 免费节点不稳定**是普遍现象，
与本项目配置无关。如果目标用户主要在境内，要么接受偶发不通，要么换带中国大陆优化的方案（那会引入备案与新的信任问题，
与「零服务端存放」的立场不冲突，但成本明显上升）。

---

## 12. 回滚 / 停线 / 解绑（都写成可执行顺序）

### 12.1 回滚一次上线

每次部署都有**不可变 URL**（`https://<deployment-id>.daily-event-logger.pages.dev`，实测 `8abb842e` 那条至今 200），
产物不存在被覆盖的可能，所以回滚只是「把生产别名指回旧 deployment」：

```bash
npx wrangler pages deployment list --project-name=daily-event-logger   # 找到要回退的那条 id
```

然后在 Pages 项目 → Deployments → 目标那条 → **Rollback**（或调 API
`POST /pages/projects/<project>/deployments/<id>/history/rollback`）。
为什么强调它：承诺③要求「历史版本可核对」，如果线上产物会被就地覆盖，这个承诺就无从谈起。

### 12.2 停掉自动上线（不改代码）

Settings → Secrets and variables → Actions → **Variables** → `DEPLOY_ENABLED` 改 `false`。
为什么不建议删 secrets：删了以后恢复要重新贴值，且失败信息会伪装成认证错误，排查成本高；
变量开关是「配置动作」，日志里 `skipped` 一眼可辨。

### 12.3 解绑自定义域名（顺序错了会留垃圾）

1. 先删 zone 里的两条 CNAME（`@` 与 `www` → `daily-event-logger.pages.dev`）；
2. 再到 Pages 项目 → Custom domains → **Remove domain**；
3. 若不再使用，域名可以从 Registrar 转出或放着不管（关掉自动续费即可，到期自然失效）。

为什么是这个顺序：反了的话 Pages 侧已经解除归属、DNS 侧却还指着 `pages.dev`，
Pages 会一直显示一个绑不过去的 pending 域名，删起来要等状态同步。

### 12.4 彻底下线

Delete Pages project（产物随之不可访问）→ 处理域名 → GitHub 仓库设 private 或删除。
注意：数据本来就不在服务器上，所以下线**不需要任何导出动作**；用户的记录在他们自己浏览器里，
真要迁移，让用户用应用内的「导出全部」自行带走。

---

## 13. 时间线（全部 UTC，2026-10-01 → 10-02）

| 时刻 | 事件 | 说明 |
| --- | --- | --- |
| 01:51:34 | Cloudflare 账号创建 | 用邮箱注册，控制台标题即账号所有人邮箱（此处略） |
| ~02:00:13 | Pages 项目 `daily-event-logger` 创建 | 项目名全局唯一，`event-logger` 已被占用（§6.1） |
| 02:04:40 | run 36804109033（push, `28a36d5`）success | 项目名对齐这条改动 |
| 02:18:19 | run 36805200701（push, `32c175b`）success | 标题统一为 Daily Event Logger |
| 03:23:25 | 域名 `daily-event-logger.com` 注册 + zone 激活 | 10.46 USD/年，2027-10-01 到期，默认自动续费 |
| 03:35:33 | run 36811216896（**workflow_dispatch**）success | 手动按一次，专门验证「开关为 true 时确实会上线」 |
| 03:37:09 | deployment `8abb842e` 上线 | 来自 `32c175b`；`pages.dev` 首次 200（此前 522 = 空项目，§6.3） |
| 03:41:06 / 03:41:24 | 用 API 加 apex + www 两条自定义域名 | 状态 `pending`，报 `CNAME record not set`（§7.3） |
| 03:41 → 08:40 | （约 5 小时空档） | 是人离开了，不是时间戳异常 |
| 08:40 | 给 token 补 `Zone / DNS : Read + Edit` | 建 CNAME 报 `10000 Authentication error` 的根因；权限变更不换 token 字符串 |
| 08:43:37 / 08:43:53 | 建两条 proxied CNAME（`@`、`www` → `daily-event-logger.pages.dev`） | 橙云必须 true，灰云会 525/522 |
| ~08:46 | 两条自定义域名双双 `active` | 期间 HTTPS 已可用（通配证书早就覆盖，§7.3） |
| 08:5x | 本地提交 `062aacc` → **push 被拒** | `refusing to allow an OAuth App ... without workflow scope`（§10） |
| 09:0x | 设备码流授权成功 | `gh auth refresh -s workflow` → scopes 增加 `workflow` |
| 09:14:42 | push 成功 `32c175b..062aacc` → run 36841446225 | 网络抖动导致前两次 `Failed to connect` 失败（§9.2） |
| 09:15:06 / 09:16:11 / 09:16:45 | checks / browser-smoke / deploy 依次 success | 三 job 全绿，smoke 仍是 gate |
| 09:16:41 | **deployment `ca2cdcec`** 上线 | 来自 `062aacc`；线上仍是 1904 B / 200，与 pages.dev 一致 |
| 13:04:27 / 13:04:28 | `26f4832` + `82acc01`（「❓ 使用帮助」入口与弹窗 + 三语文档口径） | push `a6ab81c..82acc01` 一次成功（`workflow` scope 早已就位） |
| 13:04:50 → 13:07:05 | run `36866143472` 三 job 全 success | checks+build 13:05:23 → 浏览器 smoke 13:06:02 → publish 13:07:05；线上三 host 同时换上新 bundle `index-DE2uwppR.js`（311555 B，逐字节相同） |
| 13:11 | 第一次从本机打线上 smoke | 9 条红：7 条是 §8.4 那个 zone 自动注入的 beacon，2 条是 §9.3 那两个脚本抖动（本轮已修） |
| 13:17 | 本机 `npm run smoke` 18 步全绿 | 随机端口服务器不属于任何 zone，没人给它注入 beacon，所以线上那 7 条红在这里根本不复现 |
| 13:22 / 13:24 | 两次远程 smoke 都停在校验页 | §9.3 那台企业网关对刚注册的域名时通时不通，两次都停在第 1 步，拿到的是 Zscaler `C03 Are you sure...` 拦截页正文（新诊断打印能直接说出「页面被网关改了」），不是应用失败；同一份代码 13:17 本机 18 步全绿 |
| 13:26:13 → 13:27:44 | run `36868663133`（`88d8109`）三 job success | 只动测试脚本与 design.md，bundle 内容不变（仍 `index-DE2uwppR.js` / 311555 B），照发一次部署 |
| 13:34:36 → 13:36:21 | run `36869691598`（`297ce3f`）三 job success | 文档口径修正：`npm run smoke -- --url=`（少了 `--` 时 npm 吞参数、实测打到本机产物）；DEPLOYMENT.md 按自家脱敏标准入库 |
| 13:37 | design.md 文件索引与代码对齐（`data-*` 锚点其实在 `HelpDialog.jsx`，`Workspace.jsx` 一个都没有）+ 补上本段 | 纯文档，产物不变 |
| 13:38 → 13:44 | `25459eb` 的 push 重试 5 次才通 | §9 第 2 条那个网关抖动，本轮再次命中，重试即可 |
| 13:44:14 → 13:46:10 | run `36870897249`（`25459eb`）三 job success | checks 13:44:48 → smoke 13:45:35 → publish 13:46:10；线上仍是 `index-DE2uwppR.js` / 311555 B |
| 13:47:39 → 13:49:12 | run `36871326101`（`a7ec7b9`）三 job success | 只动本文档，产物不变，线上仍是 `index-DE2uwppR.js` / 311555 B |
| 14:10:29 → 14:12:22 | `71b3ef6` push 一次成功 → run `36874299459` 三 job success | checks 14:10:46→14:11:12、smoke 14:11:14→14:11:48、publish 14:11:51→14:12:22；deployment `f174b586` |
| 14:12 | 线上换上新 bundle `index-BXH9qyKy.js` / 316083 B | apex / www / pages.dev 三 host 同一份；三语新文案（`这是一个记录你的工作` / `Before you start logging` / `ローカルフォルダーにミラー`）与 `data-help-top`、`data-help-warn-title` 两个新锚点都在产物里 |
| 14:12 | 别拿 bundle 文件名比本机与 CI | 同一份源码本机 build 出 `index-D7hNtOyy.js` / 316084 B：index chunk 里内嵌懒加载 `StatsPanel-*.js` 的哈希，跨环境不稳定。要比的是内容（grep 文案与 `data-*` 锚点），不是文件名 |
| 14:14 → 14:15 | 线上 smoke：第 17 步 7 条新断言全过，10 条红全是同一个根因 | 开头两段介绍、备份提醒排在目录之前、en/zh 逐字等于字典——都在真实线上产物上通过；10 条红全部指向 §8.4 那个按 zone 自动注入的 `beacon.min.js` 被自家 CSP 拦下（零第三方 / 零跨域 / 零 JS 异常），与本轮改动无关，关掉自动注入并重发一次部署才会消失 |
| 14:17 → 14:18 | run `36875325960`（`ed326e3`，纯文档）checks + build **偶发红** | 撞上面第 4 条那个毫秒边界；smoke / publish 两个 job 因此 `skipped`，线上产物没动（仍是 `71b3ef6` 那一版） |
| 14:20 → 14:22 | `check-template-sort.mjs` 冻结基准时钟（141 → 144 行） | 只动测试脚本，改完连打 40 遍 0 红；design.md 文件索引里的行数与判据同步 |
| 14:23:34 → 14:25:33 | run `36875959507`（`02be0fe`）三 job success | 九项不变量 + 18 步 smoke 全绿，publish 上线 deployment（bundle 换成 `index-CqlvO2qS.js`，三 host 同一份；帮助开头三块的新文案与两个 `data-help-*` 锚点复核在产物里）。**这条记录本身要靠下一次提交带上，所以它写的「线上当前 bundle」到了那次部署又会变——比对内容，别比对文件名** |
| 14:28:28 | run `36876350740`（`aa45a1c`，纯文档）三 job success | deployment `de6257b3`；线上当前 bundle `index-D_bhO3R_.js`，三 host 同一份 |
| 15:01 → 15:02 | 交接摘要说「工作树干净」是错的 | `git status` 有 11 个已改文件 + 5 个未跟踪文件，是一整块**未提交**的「事件描述」功能（`desc:check` 那一版）。本轮**不碰它**，线上验证改到 HEAD 的独立 worktree 里做（`git worktree add --detach` + 只读跑 smoke，收尾先 `rmdir` 摘掉 node_modules 联接再 `git worktree remove`，绝不递归穿过联接） |
| 15:03 | ✅ §8.4 结案：在控制台 **Delete** 掉 Web Analytics 站点属性 | 该账号的 `Advanced Options` 里根本没有 Automatic setup 下拉框，只有 Rules 的 Pro 升级推销 + 红色 Delete。**删完注入当场就停，没有重发部署** |
| 15:04 | 三 host 带浏览器式请求头复验：全部 1904 B / 1802 字符 | `data-cf-beacon`、`cloudflareinsights.com`、`cdn-cgi` 全无；与本机 `dist/index.html` 只差一处 asset 文件名 hash（`index-BobZR8tk` 本机旧构建 vs `index-D_bhO3R_` 线上，长度相同所以都是 1904 B）；9 项安全头原样 |
| 15:05 → 15:06 | 线上 smoke **首次 18 步全绿**：196 条断言、0 红 | apex 那次仍被 Zscaler 拦在第 1 步（`C03 …` + 两条 403），改打 `pages.dev` 就通了（见 §9 新增绕法）。`data-build="aa45a1ce-20261001142651"` 证明测的正是 `de6257b3`；「零第三方」「全程零跨域」「全程零非 GET（33 个请求全是 GET）」「零 CSP 违规」全部转绿 |
| 15:13 → 15:15 | `d2f5420` 的 push 直连失败 2 次 | 都报 `Failed to connect to github.com port 443`；当时仍按「网关抖动、重试即可」（§9 第 2 条旧口径）处理 |
| 15:16 | 改用 `git -c http.proxy=http://127.0.0.1:9000 push` **7.6 s 一次就通**（`aa45a1c..d2f5420`） | 找到一条被忽略的原因：系统 PAC 兜底走 `PROXY 127.0.0.1:9000`，而 git 不读 PAC |
| 15:28 → 15:30 | 同一个代理参数这次**挂住不返回**，换直连 6 s 发上去（`d2f5420..d8b0d46`） | 推翻我 15:16 刚写下的「确定性绕法」：两条路各自都会抽。§9 第 2 条二次改写，改成「换路 + 必须带 `http.lowSpeedTime` 超时」，。挂死是常态而不是偶发：15:28Z 那条代理 push 到 15:31Z 进程表里还在，15:30:18Z 的代理 ls-remote 挂到 15:36Z 只能手杀 |
| 15:16:14 → 15:18:04 | run `36882901568`（`d2f5420`，纯文档）三 job success | checks 15:16:14→15:16:38、smoke 15:16:40→15:17:30、publish 15:17:35→15:18:04，deployment `27ce420b`；只动 DEPLOYMENT.md，产物内容不变 |
| 15:20 → 15:21 | ✅ 复验「新部署不会把 beacon 带回来」+ 线上 smoke 再全绿 | 三 host 1904 B / 零 `data-cf-beacon` / HTML 第三方 URL 数 0 / CSP 与 9 项安全头原样；分离 worktree 里跑 `--url=…pages.dev`，构建号 `d2f5420f-20261001151631`、18 步 196 条断言 0 红、33 个请求全 GET |
| 15:31 → 15:36 | `d8b0d46`（被 concurrency 取消，**不产生部署**）与 `1534725` 两条 push 直连发上去；run `36885137193` 三 job success，deployment `6d7ce44f`（15:35:45Z） | 「部署不带回注入」的第二个样本：15:37Z 三 host 仍 1904 B / 零 `data-cf-beacon` |
| 15:37:47 → 19:07:52 | `87c21e3` 的 push：**5 击全报失败，3 h 30 m 之后 refs 却落地了** | 见 §9 新增那条。`#2 proxy` 实际阻塞 **12,509 s**（纯连接挂住时 `lowSpeedTime` 不参与）；落地由某次「已判失败」调用留下的后台 `git-remote-https` 完成，**判据是 `git branch -vv`，不是返回值** |
| 19:09:46 | run `36912005524`（`87c21e3`）三 job success，deployment `29da0643` | 只动 DEPLOYMENT.md，产物内容不变；CI 内 18 步 smoke 绿 |
| 23:58 → 00:02 | ✅ 第三次复验 beacon + **线上 smoke 再全绿** | 三 host **1904 B / 零 `data-cf-beacon` / 零 `cdn-cgi` / HTML 第三方 URL 数 0**，`_headers` 8 个响应头与 CSP hash 原样；`--detach` worktree 里打 `…pages.dev`，`data-build="87c21e3f-20261001190814"`、**196 ✓ / 0 ✗**、33 个请求全 `{"GET":33}` |
| 00:05:13 | `533f17c` **功能提交落 `master`**：事件新增可选的多行 `description`（13 文件 +243/−24） | push 走直连一次成功（6.9 s，带 `-c http.lowSpeedLimit=1000 -c http.lowSpeedTime=25`——§9 第 2 条那条「必须带超时」照办）。CI 的 checks 从 9 项变 **10 项**：新增 `desc:check` 并已并入 `npm run check`，所以 `npm run check` 绿 = 它也绿。**注意**：workflow 里那步的名字仍写着 9 项与旧清单，那是 cosmetic，碰 `.github/workflows/*` 要走 `workflow` scope，本轮没动 |
| 00:05:37 → 00:07:26 | run `36944229048` 三 job success，deployment `8d73c584` | checks 00:05:39→00:06:03、smoke 00:06:05→00:06:53、publish 00:06:56→00:07:26；`gh run view --log --job` 才拿得到 wrangler 那句 `Deployment complete`，`gh api …/jobs/{id}/logs` 这条路这次只返回 100 B 错误体 |
| 00:07:22 | 线上换上新 bundle `index-DtlSh-MB.js` | 三 host（apex / www / pages.dev）带浏览器式请求头各取一次：全部 **200 / 1904 B / 同一份 asset / 零 `data-cf-beacon` / HTML 第三方 URL 数 0 / CSP 297 B / 22 个响应头**；产物里 grep 到三语描述文案（`补充说明（可选）` / `Add a description (optional)` / `説明を追加（任意）`）与归一函数的 `
?` 那条 replace，`data-build` 自报 `533f17c3-20261002000555`——文件名不能用来比对本机与 CI（§13 第 14:12 那条），要比的是内容 |
| 00:09 → 00:10 | ✅ 线上 smoke（`--url=…pages.dev`）**18 步 211 条 ✓ / 0 条 ✗**、33 个请求全 GET | 比上一轮的 196 条多出的 15 条正是本轮新增的描述往返断言：留空也落键 `description:""`、tooltip 第三行逐字等于输入、条体正文不含描述、清空立刻生效、改名不丢描述、描述不出现在任何 URL 里 |
| 00:12 | 纠正 §9「apex 被公司网关拦」的归因 | 拦的是**走不走代理**，不是主机名：node `fetch` 直连取 apex / www 都 200 且同一份产物，而 `Invoke-WebRequest`（默认吃系统 PAC → `127.0.0.1:9000`）对同一个 apex URL 给 403。这次没取到 403 正文，不能断言就是 Zscaler 的 `C03` 页，但结论够用：本机复验线上一律用 node，别拿 `Invoke-WebRequest` 的码下结论 |

---

## 14. 常用命令片段（凭证一律占位）

先设环境变量，别把值写进任何文件：

```bash
CF_TOKEN=<API_TOKEN>
CF_ACCOUNT=<ACCOUNT_ID>
# zone id 用下面第一条命令查出来，不要手抄
```

**为什么用 node 而不是 PowerShell**：外层 shell 会吞 `$`（变量插值冲突），
带 JSON 的请求一旦用引号拼接就会静默改体；所以下面统一用 node `fetch`，
返回值立刻 `JSON.parse`，出错能看见完整 error body。

```javascript
// 0) 看 Cloudflare 认为这个账号下有哪些 Pages 项目与域名
const H = { Authorization: 'Bearer ' + process.env.CF_TOKEN, 'Content-Type': 'application/json' };
const cf = async (p, opt = {}) => {
  const r = await fetch('https://api.cloudflare.com/client/v4' + p, { ...opt, headers: H });
  const j = await r.json();
  if (!j.success) throw new Error(JSON.stringify(j.errors));   // 一定要把 errors 打出来
  return j.result;
};
await cf('/accounts/' + process.env.CF_ACCOUNT + '/pages/projects');                  // 项目列表
await cf('/accounts/' + process.env.CF_ACCOUNT + '/pages/view/daily-event-logger/domains'); // 自定义域名 + status
```

```javascript
// 1) 绑自定义域名：字段名必须是 name（§7.2，写成 rel 会稳定报 8000015）
await cf('/accounts/' + A + '/pages/view/daily-event-logger/domains', {
  method: 'POST', body: JSON.stringify({ name: 'daily-event-logger.com' }),
});

// 2) 重跑一次域名校验（不带 body）
await cf('/accounts/' + A + '/pages/view/daily-event-logger/domains/daily-event-logger.com', { method: 'PATCH' });

// 3) 建 CNAME（需要 token 有 Zone/DNS Read+Edit；proxied 必须 true）
const zone = '<ZONE_ID>';
for (const name of ['daily-event-logger.com', 'www.daily-event-logger.com']) {
  await cf('/zones/' + zone + '/dns_records', {
    method: 'POST', body: JSON.stringify({ type: 'CNAME', name, content: 'daily-event-logger.pages.dev', proxied: true, ttl: 1 }),
  });
}

// 4) 读回 DNS（排查时先确认记录在不在、是不是橙云）
await cf('/zones/' + zone + '/dns_records?name=daily-event-logger.com');
```

```bash
# 5) CI/CD 侧常用三条
gh run list --limit 5
gh run view <run-id> --log | Select-String 'Deployment complete'   # 拿真 deployment id
gh run watch <run-id>

# 6) 本机直接上线（README 里那条，日常其实用不到：push 就自动上线了）
npm run deploy        # build → csp:check → wrangler pages deploy dist --project-name=daily-event-logger
```

工具环境的三条限制（踩过，省时间）：

- `exec_command` 不要传 `justification`：本机 sandbox 已是 danger-full-access，多传会被拒。
- `Remove-Item` 递归删除会被安全策略拦；删单个文件用 node `fs.unlinkSync` 更快。
- `shell: 'bash'` 会跳进 WSL 并报错，Windows 上老老实实用默认 powershell。
