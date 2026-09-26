// EventBook 的整包导出 / 导入（v2 信封）：一个文件 = 若干本簿（含各自设置、事件、模板）。
// 导出前一定先 flush 内存态，保证文件内容与 IndexedDB 一致；导入前给当前簿存一份受保护快照。
import { useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { readLiveData, writeLiveData, saveBook, sanitizeBookName } from '../storage/books.js';
import { toV2Envelope, booksFromEnvelope, planImport } from '../storage/legacy.js';
import { createSnapshot, listSnapshots } from '../storage/snapshots.js';
import { formatDate } from '../utils/time.js';
import { detectLang } from '../i18n/core.js';

function parseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: err };
  }
}

// 备份文件名不许出现 Windows 非法字符
function fileSlug(name) {
  const cleaned = sanitizeBookName(name || '').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'eventbook';
}

export function useBookTransfer(books, backup, guards) {
  const g = guards || {};

  async function entriesOf(list) {
    const out = [];
    for (let i = 0; i < list.length; i++) {
      out.push({ book: list[i], live: await readLiveData(list[i].id) });
    }
    return out;
  }

  async function download(entries, nameHint) {
    const envelope = toV2Envelope(entries, Date.now());
    const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'event-logger-' + fileSlug(nameHint) + '-' + formatDate(new Date()) + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return envelope.books.length;
  }

  const exportAll = useCallback(async () => {
    if (g.beforeExport) await g.beforeExport();
    const list = books.books || [];
    if (!list.length) return 0;
    return download(await entriesOf(list), 'all');
  }, [books.books, g.beforeExport]);

  const exportBook = useCallback(async (book) => {
    if (!book) return 0;
    if (g.beforeExport) await g.beforeExport();
    return download([{ book: book, live: await readLiveData(book.id) }], book.name);
  }, [g.beforeExport]);

  // 落盘：新 id 防撞、名字撞车加后缀；写 book 行 + live 行 + 镜像 manifest
  const importEnvelope = useCallback(async (raw, options) => {
    const opts = options || {};
    const parsed = booksFromEnvelope(raw, { deviceLang: opts.deviceLang || detectLang(), idFactory: uuidv4, bookName: opts.bookName });
    if (!parsed.books.length) return { ok: false, count: 0, warnings: parsed.warnings };
    if (g.beforeImport) await g.beforeImport();
    const planned = planImport(books.books || [], parsed.books, { idFactory: uuidv4 });
    const written = [];
    for (let i = 0; i < planned.length; i++) {
      const item = planned[i];
      await saveBook(item.book);
      await writeLiveData(item.book.id, { events: item.events, templates: item.templates });
      // 「导入」本身是个值得记住的节点：存一份受保护快照，日后可回到刚导入完的样子
      const snap = await createSnapshot(item.book.id, { events: item.events, templates: item.templates }, 'import', { force: true });
      if (backup && backup.active && snap.created) await backup.syncSnapshot(item.book, snap.snapshot);
      written.push(item.book);
    }
    await books.refresh();
    if (g.afterImport) await g.afterImport(planned, written);
    const last = written[written.length - 1];
    if (last) books.selectBook(last.id);
    return { ok: true, count: written.length, books: written };
  }, [books.books, books.refresh, books.selectBook, backup, g.beforeImport, g.afterImport]);

  const importFromText = useCallback(async (text) => {
    const parsed = parseJson(text);
    if (!parsed.ok) return { ok: false, badJson: true };
    return importEnvelope(parsed.value);
  }, [importEnvelope]);

  const importFromFile = useCallback((file) => new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = async (ev) => resolve(await importFromText(String(ev.target.result || '')));
    reader.onerror = async () => resolve({ ok: false, badJson: true });
    reader.readAsText(file);
  }), [importFromText]);

  // 「镜像到本地文件夹」的整链重推：manifest + 每本 latest.json + 每本的全部历史版本。
  // 判"现在能不能写"用 canMirror()（读 ref），不能用 backup.active（读 state）：
  // 「选完新文件夹 → 立刻补齐」是同一次事件里的连续动作，那时 active 还没被 setState 翻上来。
  // 不可写时返回 null，让 UI 明说"什么都没改"，而不是留个近乎空的文件夹冒充备份成功。
  const mirrorAll = useCallback(async () => {
    if (!backup.supported || !backup.canMirror()) return null;
    if (g.beforeExport) await g.beforeExport();
    const list = books.books || [];
    const entries = [];
    for (let i = 0; i < list.length; i++) {
      entries.push({ book: list[i], live: await readLiveData(list[i].id), snapshots: await listSnapshots(list[i].id) });
    }
    const result = await backup.resyncAll(entries);
    if (!result || !result.ok) return null;
    return result.value;
  }, [books.books, backup.supported, backup.canMirror, backup.resyncAll, g.beforeExport]);

  return { exportAll, exportBook, importEnvelope, importFromText, importFromFile, mirrorAll };
}
