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
| `meta` | `key` | the backup folder handle (`backupDirectory`) and the auto-mirror cadence (`mirrorIntervalMinutes`, default 10) |

- The first launch runs the onboarding: create the first EventBook, or — if one exists on this machine — import the old `data.json`.
- Export / import live in the EventBook menu at the top left (the "Data & backup" section): export just the current book, or all books. **Import always creates a new EventBook; it never overwrites anything that already exists.** The history panel toolbar also carries a "⬇️ Export all" shortcut: same single implementation, works in every browser, no folder mirroring needed.
- The only way to move between devices or browsers is export then import — there is no second copy on a server to pull.

### Past versions and the retention policy

A snapshot's `reason` is an enum: `interval` (the 15-minute cadence), `startup` (catch-up when the last snapshot is more than 24h old), `manual` (you clicked "💾 Save now"), `import` (during an import), `pre-restore` / `restored-from` (the pair left behind by a restore).

Eviction is tiered: keep everything within 7 days → for days 8–30 keep the earliest snapshot of each calendar day → for days 31–365 keep the earliest of each month → hard cap of 500 snapshots. The three reasons `manual` / `import` / `pre-restore` are **protected**; eviction never deletes them. If the fingerprint (canonical hash) is identical, no duplicate snapshot is stored.

### Optional: mirror to a local backup folder

In the history panel you can pick a folder (needs the File System Access API in Chrome / Edge); after that every snapshot is also written out as a file. That panel keeps the mirror to a single status line (which folder, when it last synced) — where the files land on disk and what each button does live in the tooltips of the title and of "🔄 Re-mirror every version", change folder, re-grant access and disconnect. When it is connected you can also choose how often the live copy is rewritten: every 1, 5, 10, 15, 30 or 60 minutes, 10 by default (a per-device setting; "💾 Save now" and "Re-mirror every version" always write immediately, and version files still land with every snapshot).

```
EventLogger Backups/
├── manifest.json                    # book name <-> directory, fingerprint of every snapshot
└── <book name>/latest.json + snapshots/<ISO>.json
```

That folder is yours (external drive, Sync service, NAS, anything), so "the browser got wiped" no longer equals "everything is gone". It is write-only: deleting the folder does not affect the app. "Disconnect" only stops mirroring — files already written stay exactly where they are — and switching folders re-pushes every book's whole history, so the new folder never ends up almost empty.

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
npm run smoke     # headless Chrome end-to-end, 17 steps (real mouse dragging + reading IndexedDB directly + network fingerprint)
npm run csp:check # whether the inline script hash matches public/_headers
```

`npm run smoke` covers exactly the three promises above: create a book → each book's week start and language really apply site-wide → drag to create events → the zero-storage fingerprint → manual save and hash dedup → snapshot structural invariants → edit content then replay an old version, every write during replay is blocked → restore (irreversible + automatic pre-restore) → data isolation for a second book → close and reopen and the data is still there + PWA registration → the slim-header check (export/import now live in the book menu) → a final check that the whole session made zero non-GET requests.

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
