# Event Logger

**English** · [简体中文](README.zh-CN.md) · [日本語](README.ja-JP.md)

A **single-user** daily time tracker: each day is cut into 10-minute slots, drag to record "what did what when", then read statistics and trends per category (Work / Life / Study).

It is now a PWA that can be published to the public internet — and **the server stores no user data at all**: the URL is openly reachable, the page code is downloadable by anyone, but every event you record stays in your own browser.

---

## Three hard promises

| # | Promise | How it is actually implemented |
|---|---|---|
| 1 | **Data lives only on the user's device**, zero server storage | Every read and write goes to browser IndexedDB (database `event-logger`). Production ships static files only: there is not a single POST / PUT / DELETE anywhere. `npm run smoke` captures every network request and re-verifies "all GET, zero request bodies, zero third parties, your content never appears in a URL" |
| 2 | **Each EventBook carries its own week start and language** | One record in the `books` store = one EventBook, where `settings.weekStartsOn` (0–6) and `settings.language` (zh / en / ja) are properties of **that book**. Switch book, switch convention: week view, calendar headers, statistical ranges and ISO week numbers all follow it |
| 3 | **Periodic backups; past versions viewable and restorable** (restore is irreversible) | Automatic snapshots (one every 15 minutes while editing continues) + a catch-up snapshot at startup + manual saves. "View this version" = read-only replay. "Restore this version" = the current content is first saved automatically as `pre-restore`, then the old content is written back. The snapshot chain is **append-only**, so after a restore you can still restore back |

---

## Publishing to the internet (Cloudflare Pages)

Two routes, pick one: GitHub Actions publishes automatically on push (recommended), or you publish once manually from your own machine.

### Route A: publish on push (GitHub Actions)

The repo ships [`.github/workflows/ci-and-deploy.yml`](.github/workflows/ci-and-deploy.yml). Every push to `master`: run the 9 invariant checks → build → verify the CSP hash; the build output is handed to the deploy job as an artifact (**what goes live is exactly the copy that passed the checks**, not a rebuild), and `wrangler` then publishes it to Cloudflare Pages.

You only have to fill in three things, across two pages:

**① Create an API Token in Cloudflare** — [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens) → `Create Token`, permission **Account · Cloudflare Pages · Edit** (add **Zone · Read** if you bind a custom domain), scoped to your own account. The **Account ID** sits in the right-hand sidebar of any page in the Cloudflare console.

**② Create two Repository secrets in GitHub** — [Settings → Secrets and variables → Actions](https://github.com/microsheen/event-logger/settings/secrets/actions):

| Secret name | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | the token from the previous step |
| `CLOUDFLARE_ACCOUNT_ID` | your Account ID |

**③ On the same page, switch to the Variables tab and add `DEPLOY_ENABLED`** — this is the master switch: **the deploy job only runs when the value is exactly the string `true`**. Unset, or set to `false`, and the workflow still checks and builds, but not one byte changes in production. So the order is: paste the secrets, then set `DEPLOY_ENABLED` to `true`, and the next push to `master` publishes.

```bash
gh variable set DEPLOY_ENABLED --body true     # start publishing (or just type it in the Variables web UI)
gh variable set DEPLOY_ENABLED --body false    # stop publishing with one switch
```

You do not have to create the Pages project by hand: the first workflow run executes `wrangler pages project create event-logger --production-branch master` and skips it if it already exists. The published address is always <https://event-logger.pages.dev>, and each individual deployment also gets its own `https://<commit-sha>.event-logger.pages.dev`; the Pages dashboard can roll production back to any deployment in one click.

There is also a `browser-smoke` job that runs the 15-step end-to-end below under headless Chrome on Linux. It currently carries `continue-on-error: true`, which means **a red run does not block the deploy** (Chrome's sandbox misbehaves occasionally inside containers). Once you are satisfied it is stable in CI, delete that line and it becomes a hard gate.

### Route B: publish once from your own machine

```bash
npm install
npx wrangler login     # authorise once in the browser; credentials stay on this machine
npm run deploy
```

`npm run deploy` = `npm run build` → `npm run csp:check` → `wrangler pages deploy dist --project-name=event-logger`. The first run asks whether to create the `event-logger` project; press Enter to confirm.

### Three things to read before deploying

1. **There is a sha256 in the CSP.** `script-src` in `public/_headers` whitelists the inline "set the language before React mounts" script in `index.html`. If you change that script you must run `npm run csp:check` to sync the hash, otherwise CSP blocks the inline script in production and the UI stays blank. `npm run deploy` already puts `csp:check` ahead of the deploy, so you cannot skip it.
2. **Port 3002 is a local concern, unrelated to production.** There is no backend process in production. `server.js` and both `.bat` files read `PORT` (default 3002); only the dev proxy target in `vite.config.js` and this document still hard-code 3002 — locally, to move port, besides `set PORT=8080 && npm start` you must sync those two places.
3. **`/api/legacy-data` on `server.js` is read-only**, used solely for "if this machine still has the old `data.json`, import it in one click from the first-run onboarding". It does not exist on the public internet, and the frontend skips the probe and hides the entry on any non-localhost hostname (see `src/utils/legacyFetch.js`).

---

## Local development and running

```bash
npm run dev      # Vite on 5173 (/api proxied to 3002; the backend is only needed to migrate an old data.json)
npm run build    # frontend output -> dist/ (the PWA's sw.js / manifest are generated with it)
npm start        # node server.js: static files + a read-only legacy probe, default http://localhost:3002
```

`start-server.bat` / `stop-server.bat` still work (they probe by port and look the PID up), but today they are just "a local static file server" — stop the service and your data does not leave this machine either. The `EventLogger-AutoStart.vbs` boot-login script is a convenience for a personal machine, it hard-codes absolute local paths, and it is **not in the repo** (it is listed in `.gitignore`); if you want autostart, create a vbs with the same name on your own machine containing only `ws.Run "<path to this repo>\start-server.bat", 0, False`.

---

## Where the data actually lives

Browser IndexedDB, database `event-logger` (version 1), four stores:

| store | keyPath | contents |
|---|---|---|
| `books` | `id` | each EventBook's name + settings (week start, language, timeline viewport, statistics presets) + timestamps |
| `data` | `bookId` | this book's current `events` / `templates`, plus `rev` (+1 on every write) and `updatedAt` |
| `snapshots` | `id` | past versions: each one carries a complete payload and can be replayed directly |
| `meta` | `key` | the backup folder handle (`backupDirectory`) |

- The first launch runs the onboarding: create the first EventBook, or — if one exists on this machine — import the old `data.json`.
- Export / import live in the top bar: export just the current book, or all books. **Import always creates a new EventBook; it never overwrites anything that already exists.**
- The only way to move between devices or browsers is export then import — there is no second copy on a server to pull.

### Past versions and the retention policy

A snapshot's `reason` is an enum: `interval` (the 15-minute cadence), `startup` (catch-up when the last snapshot is more than 24h old), `manual` (you clicked "💾 Save now"), `import` (during an import), `pre-restore` / `restored-from` (the pair left behind by a restore).

Eviction is tiered: keep everything within 7 days → for days 8–30 keep the earliest snapshot of each calendar day → for days 31–365 keep the earliest of each month → hard cap of 500 snapshots. The three reasons `manual` / `import` / `pre-restore` are **protected**; eviction never deletes them. If the fingerprint (canonical hash) is identical, no duplicate snapshot is stored.

### Optional: mirror to a local backup folder

In the history panel you can pick a folder (needs the File System Access API in Chrome / Edge); after that every snapshot is also written out as a file:

```
EventLogger Backups/
├── manifest.json                    # book name <-> directory, fingerprint of every snapshot
└── <book name>/latest.json + snapshots/<ISO>.json
```

That folder is yours (external drive, Sync service, NAS, anything), so "the browser got wiped" no longer equals "everything is gone". It is write-only: deleting the folder does not affect the app.

### ⚠️ Situations where you can lose data

- **Clearing browser data / uninstalling the browser** — IndexedDB goes with it. A public deployment has no server-side copy to recover from.
- **Private windows** — gone the moment the window closes; when IndexedDB is entirely unavailable the UI says so plainly instead of pretending the save succeeded.
- **Eviction under storage pressure** (especially iOS Safari / mobile) — the app requests `persisted` storage, but the browser decides.

So: for long-lived data, rely on at least one of "export files" or "the mirror backup folder".

---

## Run these before and after changing code

```bash
npm run check     # 9 pure-function and consistency checks (i18n / sorting / slots / clipboard /
                  #   cross-midnight dragging / week convention / snapshot policy / EventBook store / React imports)
npm run smoke     # headless Chrome end-to-end, 15 steps (real mouse dragging + reading IndexedDB directly + network fingerprint)
npm run csp:check # whether the inline script hash matches public/_headers
```

`npm run smoke` covers exactly the three promises above: create a book → each book's week start and language really apply site-wide → drag to create events → the zero-storage fingerprint → manual save and hash dedup → snapshot structural invariants → edit content then replay an old version, every write during replay is blocked → restore (irreversible + automatic pre-restore) → data isolation for a second book → close and reopen and the data is still there + PWA registration → a final check that the whole session made zero non-GET requests.

Options: `--stop-at=N` run only the first N steps, `--applog` print the page log on failure, `--slow=MS` slow it down for humans, `--no-csp` disable CSP, `--url=` target a deployed site, `--no-sandbox` (only needed when Chrome cannot start in Linux/containers; that is what CI uses).

---

## Privacy boundaries (the honest version)

- The page makes no third-party requests at all: no analytics, no CDN, no external fonts or images, every asset is same-origin.
- Event content and EventBook names **never appear in a URL or a request body** (the smoke test asserts this request by request).
- But CDN edge nodes still write standard access logs (IP, User-Agent, the static path requested). "The server stores no user data" refers to your data, not to zero logging.
- `robots.txt` says `Allow: /`. There is simply nothing server-side worth indexing.

---

## More detail

Design intent and the list of invariants live in `design.md` (currently Chinese only) — read §11 before touching the data model, the week convention or the snapshot policy.

---

## License

MIT, see [`LICENSE`](LICENSE).
