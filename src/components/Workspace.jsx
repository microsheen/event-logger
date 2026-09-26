import React, { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import Header from './Header.jsx';
import Calendar from './Calendar.jsx';
import Timeline from './Timeline.jsx';
import EventDialog from './EventDialog.jsx';
import TemplateManager from './TemplateManager.jsx';
// recharts 只被统计面板用到，拆成按需 chunk：首屏 JS 从 ~680 kB 降到 ~250 kB（未压缩）
const StatsPanel = lazy(() => import('./StatsPanel.jsx'));
import Toast from './Toast.jsx';
import HistoryPanel from './HistoryPanel.jsx';
import BookSettingsDialog from './BookSettingsDialog.jsx';
import { useEvents } from '../hooks/useEvents.js';
import { useTemplates } from '../hooks/useTemplates.js';
import { useI18n } from '../i18n/index.jsx';
import { formatDate, parseDate, slotRangeLabel } from '../utils/time.js';
import { dayHeaderLabel, relativeTime, absoluteTimeLabel } from '../i18n/format.js';
import { clipboardFromEvent, pasteRange, hasOverlap } from '../utils/eventClipboard.js';

const mainLayoutStyle = { display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' };
const leftColumnStyle = {
  width: 'var(--sidebar-width)', minWidth: 'var(--sidebar-width)', display: 'flex',
  flexDirection: 'column', borderRight: '1px solid var(--color-border)', overflowY: 'auto',
};
const rightColumnStyle = {
  flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: '400px',
};
const statsWrapperStyle = { flex: 1, overflow: 'auto', borderTop: '1px solid var(--color-border)' };
const statsFallbackStyle = {
  padding: '24px 14px', textAlign: 'center', fontSize: '12px', color: 'var(--color-text-secondary)',
};
const saveIndicatorStyle = (visible) => ({
  position: 'fixed', bottom: '16px', right: '16px', padding: '6px 14px', borderRadius: '20px',
  background: 'var(--color-accent)', color: '#fff', fontSize: '12px', fontWeight: 500, zIndex: 300,
  opacity: visible ? 1 : 0, transition: 'opacity 0.3s', pointerEvents: 'none',
});
const bannerBase = {
  display: 'flex', alignItems: 'center', gap: '12px', padding: '8px 16px',
  fontSize: '13px', fontWeight: 600, flexShrink: 0,
};
const previewBannerStyle = {
  ...bannerBase, background: 'var(--color-danger)', color: '#fff',
};
const bannerBtnStyle = {
  padding: '4px 12px', borderRadius: '14px', fontSize: '12px', fontWeight: 600,
  background: 'rgba(255,255,255,0.18)', color: '#fff', border: '1px solid rgba(255,255,255,0.6)',
};
const writerBannerStyle = {
  ...bannerBase, background: 'var(--color-accent-light)', color: 'var(--color-accent)',
  borderBottom: '1px solid var(--color-accent)',
};

// 恢复要等 React 把 importEvents/importTemplates 的效果回灌到 bookData 的 ref 里，再落快照
const nextTick = () => new Promise((resolve) => { setTimeout(resolve, 0); });

export default function Workspace({ books, backup, bookData, transfer, toast, showToast }) {
  const { lang, tr } = useI18n();
  const book = books.activeBook;
  const settings = book.settings;
  const weekStartsOn = settings.weekStartsOn;

  const [selectedDate, setSelectedDate] = useState(new Date());
  const [dialogState, setDialogState] = useState(null);
  const [showTemplates, setShowTemplates] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  // 弹窗开关住在 useBooks（App 层），这里只派生：整棵重挂载（换书 / ⏳ loading）都不会把它弄丢
  const showBookSettings = books.settingsOpenFor != null && books.settingsOpenFor === book.id;
  const [statsScope, setStatsScope] = useState(settings.statsScope);
  const [clipboard, setClipboard] = useState(null);

  const { events, addEvent, updateEvent, deleteEvent, getDateSet, importEvents } =
    useEvents(bookData.events, bookData.onEventsChange);
  const { templates, addTemplate, updateTemplate, deleteTemplate, importTemplates } =
    useTemplates(bookData.templates, bookData.onTemplatesChange);

  const preview = bookData.preview;
  const readOnly = !!preview || !bookData.canWrite;

  // —— 回放态：日历/时间轴/统计全部读快照内容，不读 live —— 
  const shownEvents = preview && preview.payload ? (preview.payload.events || []) : events;
  const shownDateSet = useMemo(() => {
    if (!preview) return null;
    return new Set(shownEvents.map((e) => e.date));
  }, [preview, shownEvents]);
  const dateSet = shownDateSet || getDateSet();

  useEffect(() => {
    const seed = bookData.remoteSeed;
    if (!seed) return;
    importEvents(seed.events);
    importTemplates(seed.templates);
  }, [bookData.remoteSeed, importEvents, importTemplates]);

  const guardWrite = useCallback(() => {
    if (preview) { showToast(tr('app.readOnlyBlocked'), 'error'); return false; }
    if (!bookData.canWrite) {
      showToast(tr('app.otherTabEditing', { name: book.name }), 'error');
      return false;
    }
    bookData.claimWrite();
    return true;
  }, [preview, bookData, book.name, showToast, tr]);

  const patchSettings = useCallback((patch) => {
    books.patchBook(book, { settings: Object.assign({}, patch) });
  }, [books.patchBook, book]);

  const handleRangeChange = useCallback((key, value) => {
    if (!guardWrite()) return;
    const next = { timelineStart: settings.timelineStart, timelineEnd: settings.timelineEnd };
    next[key] = value;
    if (next.timelineStart >= next.timelineEnd) return;
    patchSettings(next);
  }, [guardWrite, settings.timelineStart, settings.timelineEnd, patchSettings]);

  const handleScopeChange = useCallback((scope) => {
    setStatsScope(scope);
    if (!guardWrite()) return;
    patchSettings({ statsScope: scope });
  }, [guardWrite, patchSettings]);
  useEffect(() => { setStatsScope(settings.statsScope); }, [settings.statsScope]);

  const handleCreateEvent = useCallback((startSlot, endSlot, eventDateStr) => {
    if (!guardWrite()) return;
    setDialogState({ mode: 'create', initialData: { startSlot, endSlot }, dateStr: eventDateStr || formatDate(selectedDate) });
  }, [guardWrite, selectedDate]);

  const handleEditEvent = useCallback((event) => {
    if (preview) { showToast(tr('app.readOnlyBlocked'), 'error'); return; }
    setDialogState({ mode: 'edit', initialData: event, dateStr: event.date });
  }, [preview, showToast, tr]);

  const handleMoveEvent = useCallback((eventId, newStartSlot, newEndSlot, newDateStr) => {
    if (!guardWrite()) return;
    const updates = { startSlot: newStartSlot, endSlot: newEndSlot };
    // 跨日期拖动多带一个目标日期；不带就绝不写 date 键
    if (typeof newDateStr === 'string' && newDateStr) updates.date = newDateStr;
    updateEvent(eventId, updates);
  }, [guardWrite, updateEvent]);

  const handleMoveBlocked = useCallback((targetDateStr) => {
    if (!targetDateStr) return;
    showToast(tr('timeline.dropNoSpace', { day: dayHeaderLabel(parseDate(targetDateStr), lang) }), 'error');
  }, [showToast, tr, lang]);

  const handleCopyEvent = useCallback((event) => {
    const payload = clipboardFromEvent(event, 'copy');
    if (!payload) return;
    setClipboard(payload);
    showToast(tr('timeline.copied', { name: payload.name }), 'info');
  }, [showToast, tr]);

  const handleCutEvent = useCallback((event) => {
    const payload = clipboardFromEvent(event, 'cut');
    if (!payload) return;
    setClipboard(payload);
    showToast(tr('timeline.cutHint', { name: payload.name }), 'info');
  }, [showToast, tr]);

  const handleClearClipboard = useCallback(() => setClipboard(null), []);

  const handlePasteClipboard = useCallback((targetDateStr, slot) => {
    if (!clipboard) return;
    if (!guardWrite()) return;
    const range = pasteRange(clipboard, slot, { min: settings.timelineStart, max: settings.timelineEnd });
    if (!range) return;
    const ignoreId = clipboard.mode === 'cut' ? clipboard.sourceId : null;
    const blocker = hasOverlap(events, targetDateStr, range.startSlot, range.endSlot, ignoreId);
    if (blocker) {
      showToast(tr('timeline.pasteConflict', {
        name: blocker.name,
        range: slotRangeLabel(blocker.startSlot, blocker.endSlot),
      }), 'error');
      return;
    }
    const eventData = {
      name: clipboard.name, category: clipboard.category, templateId: clipboard.templateId,
      date: targetDateStr, startSlot: range.startSlot, endSlot: range.endSlot,
    };
    if (clipboard.mode === 'cut' && events.some((e) => e.id === clipboard.sourceId)) {
      updateEvent(clipboard.sourceId, eventData);
      setClipboard(null);
    } else {
      addEvent(eventData);
      if (clipboard.mode === 'cut') setClipboard(null);
    }
  }, [clipboard, events, settings.timelineStart, settings.timelineEnd, guardWrite, addEvent, updateEvent, showToast, tr]);

  const handleSave = useCallback((data) => {
    if (!guardWrite()) return;
    if (dialogState.mode === 'create') addEvent(data);
    else updateEvent(data.id, data);
    setDialogState(null);
  }, [dialogState, guardWrite, addEvent, updateEvent]);

  const handleDelete = useCallback((id) => {
    if (!guardWrite()) return;
    if (confirm(tr('app.confirmDeleteEvent'))) {
      deleteEvent(id);
      setDialogState(null);
    }
  }, [guardWrite, deleteEvent, tr]);

  const handleTemplatesOpen = useCallback(() => {
    if (!guardWrite()) return;
    setShowTemplates(true);
  }, [guardWrite]);

  const handleExportAll = useCallback(async () => {
    const n = await transfer.exportAll();
    if (n) showToast(tr('app.exportDone', { n: n }), 'info');
  }, [transfer.exportAll, showToast]);

  const handleExportBook = useCallback(async () => {
    await transfer.exportBook(book);
  }, [transfer.exportBook, book]);

  const handleImportFile = useCallback(async (file) => {
    if (!guardWrite()) return;
    const result = await transfer.importFromFile(file);
    if (!result.ok) {
      showToast(tr(result.badJson ? 'header.importBadFile' : 'app.importNothing'), 'error');
      return;
    }
    showToast(tr('app.importBooks', { n: result.count }), 'info');
  }, [guardWrite, transfer.importFromFile, showToast, tr]);

  const handleCreateBook = useCallback(async () => {
    const name = tr('book.unnamed') + ' ' + (books.books.length + 1);
    await books.createBook({ name, language: lang, weekStartsOn }, { openSettings: true });
  }, [books, lang, weekStartsOn, tr]);

  const handleDeleteBook = useCallback(async () => {
    if (books.books.length <= 1) return;
    const ok = confirm(tr('book.deleteConfirm', {
      name: book.name,
      events: events.length,
      templates: templates.length,
      snapshots: bookData.snapshots.length,
    }));
    if (!ok) return;
    const result = await books.removeBook(book);
    if (backup.active) {
      (result.removedSnapshots || []).forEach((s) => backup.dropSnapshot(book, s));
      await backup.dropBook(book);
    }
    showToast(tr('book.deleteDone', { name: book.name }), 'info');
  }, [books, book, events.length, templates.length, bookData.snapshots.length, backup, showToast, tr]);

  const handleArchiveNow = useCallback(async () => {
    const result = await bookData.snapshotNow();
    showToast(result && result.created ? tr('history.archived') : tr('history.unchanged'), 'info');
    return result;
  }, [bookData.snapshotNow, showToast, tr]);

  const handleRestore = useCallback(async (snapshot) => {
    if (!snapshot) return false;
    const payload = await bookData.restoreToSnapshot(snapshot);
    if (!payload) return false;
    importEvents(payload.events);
    importTemplates(payload.templates);
    setSelectedDate(new Date());
    setClipboard(null);
    await nextTick();
    await bookData.finishRestore(snapshot.id);
    setShowHistory(false);
    showToast(tr('history.restoreDone', { time: absoluteTimeLabel(snapshot.createdAt, lang) }), 'info');
    return true;
  }, [bookData, importEvents, importTemplates, setSelectedDate, showToast, tr, lang]);
  const handleTakeOver = useCallback(() => {
    bookData.claimWrite();
  }, [bookData.claimWrite]);

  const guardedAddTemplate = useCallback((name, category, timestamps) => {
    if (!guardWrite()) return null;
    return addTemplate(name, category, timestamps);
  }, [guardWrite, addTemplate]);

  const guardedUpdateTemplate = useCallback((id, updates) => {
    if (!guardWrite()) return;
    updateTemplate(id, updates);
  }, [guardWrite, updateTemplate]);

  const guardedDeleteTemplate = useCallback((id) => {
    if (!guardWrite()) return;
    deleteTemplate(id);
  }, [guardWrite, deleteTemplate]);

  const handleSaveBookSettings = useCallback(async (patch) => {
    if (!guardWrite()) return false;
    books.patchBook(book, patch);
    await books.flushSettings();
    showToast(tr('book.saved'), 'info');
    books.closeSettings();
    return true;
  }, [guardWrite, books, book, showToast, tr]);


  return (
    <>
      <Header
        book={book}
        books={books.books}
        onSelectBook={books.selectBook}
        onCreateBook={handleCreateBook}
        onOpenBookSettings={() => books.openSettings(book.id)}
        onDeleteBook={handleDeleteBook}
        onExportBook={handleExportBook}
        onExportAll={handleExportAll}
        onImportFile={handleImportFile}
        onOpenTemplates={handleTemplatesOpen}
        onOpenHistory={() => setShowHistory(true)}
        historyCount={bookData.snapshots.length}
        locked={readOnly}
      />
      {preview && (
        <div style={previewBannerStyle}>
          <span style={{ flex: 1 }}>
            {tr('preview.banner', { time: absoluteTimeLabel(preview.createdAt, lang) })}
          </span>
          <span style={{ fontSize: '12px', fontWeight: 400 }}>
            {tr('history.eventsN', { n: (preview.payload && preview.payload.events ? preview.payload.events.length : 0) })}
            {' · '}
            {tr('preview.readonlyNote')}
          </span>
          <button style={bannerBtnStyle} onClick={() => handleRestore(preview)}>{tr('history.restore')}</button>
          <button style={bannerBtnStyle} onClick={bookData.closePreview}>{tr('preview.exit')}</button>
        </div>
      )}
      {!preview && !bookData.canWrite && (
        <div style={writerBannerStyle}>
          <span style={{ flex: 1 }}>{tr('app.otherTabEditing', { name: book.name })}</span>
          <button style={{ ...bannerBtnStyle, background: 'var(--color-accent)', borderColor: 'var(--color-accent)' }}
            onClick={handleTakeOver}>{tr('app.takeOver')}</button>
        </div>
      )}
      <div style={mainLayoutStyle}>
        <div style={leftColumnStyle}>
          <Calendar selectedDate={selectedDate} onSelectDate={setSelectedDate} dateSet={dateSet} weekStartsOn={weekStartsOn} />
          <div style={statsWrapperStyle}>
            <Suspense fallback={<div style={statsFallbackStyle}>{'⏳'} {tr('app.loading')}</div>}>
              <StatsPanel events={shownEvents} selectedDate={selectedDate} scope={statsScope}
                onScopeChange={handleScopeChange} weekStartsOn={weekStartsOn} />
            </Suspense>
          </div>
        </div>
        <div style={rightColumnStyle}>
          <Timeline events={shownEvents} selectedDate={selectedDate}
            onCreateEvent={handleCreateEvent} onEditEvent={handleEditEvent} onMoveEvent={handleMoveEvent}
            timelineStart={settings.timelineStart} timelineEnd={settings.timelineEnd}
            onTimelineStartChange={(v) => handleRangeChange('timelineStart', v)}
            onTimelineEndChange={(v) => handleRangeChange('timelineEnd', v)}
            clipboard={clipboard} onCopyEvent={handleCopyEvent} onCutEvent={handleCutEvent}
            onPasteClipboard={handlePasteClipboard} onClearClipboard={handleClearClipboard}
            onMoveBlocked={handleMoveBlocked} weekStartsOn={weekStartsOn} readOnly={readOnly} />
        </div>
      </div>
      <div style={saveIndicatorStyle(bookData.saving)}>{'💾'} {tr('app.saving')}</div>
      <Toast toast={toast} />
      <HistoryPanel
        open={showHistory}
        onClose={() => setShowHistory(false)}
        book={book}
        snapshots={bookData.snapshots}
        previewId={preview ? preview.id : null}
        onPreview={(s) => { setShowHistory(true); bookData.openPreview(s); }}
        onExitPreview={bookData.closePreview}
        onRestore={handleRestore}
        onArchiveNow={handleArchiveNow}
        quota={bookData.quota}
        backup={backup}
        onMirrorAll={transfer.mirrorAll}
        onExportAll={handleExportAll}
        lang={lang}
      />
      {showBookSettings && (
        <BookSettingsDialog book={book} onClose={() => books.closeSettings()} onSave={handleSaveBookSettings} />
      )}
      {showTemplates && (
        <TemplateManager templates={templates} onAdd={guardedAddTemplate} onUpdate={guardedUpdateTemplate}
          onDelete={guardedDeleteTemplate} onClose={() => setShowTemplates(false)} />
      )}
      {dialogState && (
        <EventDialog mode={dialogState.mode} initialData={dialogState.initialData}
          templates={templates} events={shownEvents} dateStr={dialogState.dateStr}
          onSave={handleSave} onDelete={handleDelete} onCancel={() => setDialogState(null)} onAddTemplate={guardedAddTemplate} />
      )}
    </>
  );
}
