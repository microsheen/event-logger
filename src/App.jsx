import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { I18nProvider, useI18n } from './i18n/index.jsx';
import { useBooks } from './hooks/useBooks.js';
import { useBackupFolder } from './hooks/useBackupFolder.js';
import { useBookData } from './hooks/useBookData.js';
import { useBookTransfer } from './hooks/useBookTransfer.js';
import { useToast } from './hooks/useToast.js';
import Toast from './components/Toast.jsx';
import Workspace from './components/Workspace.jsx';
import FirstRunGuide from './components/FirstRunGuide.jsx';
import { isSupported } from './storage/idb.js';
import { fetchLegacyData } from './utils/legacyFetch.js';
import './styles/global.css';

const screenStyle = {
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  height: '100vh', padding: '24px', textAlign: 'center',
  fontSize: '16px', color: 'var(--color-text-secondary)',
};

const cardStyle = {
  maxWidth: '520px', margin: '0 auto', padding: '28px',
  background: 'var(--color-surface)', border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius)', boxShadow: 'var(--shadow)',
  fontSize: '14px', color: 'var(--color-text)', lineHeight: 1.7, textAlign: 'left',
};

// 语言由当前 EventBook 决定，所以 Provider 必须在读到 book 之后再包一层
export default function App() {
  const books = useBooks();
  const backup = useBackupFolder();
  const bookData = useBookData(books.activeBook, backup);
  const activeBook = books.activeBook;

  const handleLanguageChange = useCallback((next) => {
    if (!books.activeBook) return;
    books.patchBook(books.activeBook, { settings: { language: next } });
  }, [books.activeBook, books.patchBook]);

  return (
    <I18nProvider lang={activeBook ? activeBook.settings.language : undefined} onLanguageChange={handleLanguageChange}>
      <RootView books={books} backup={backup} bookData={bookData} />
    </I18nProvider>
  );
}

function RootView({ books, backup, bookData }) {
  const { tr, lang } = useI18n();
  const { toast, showToast } = useToast();
  // undefined = 还没探测过；null = 这台电脑上没有旧 data.json
  const [legacy, setLegacy] = useState(undefined);
  const [legacyBusy, setLegacyBusy] = useState(false);
  const reportedError = useRef(null);

  const beforeExport = useCallback(async () => {
    await books.flushSettings();
    await bookData.flushSave();
  }, [books.flushSettings, bookData.flushSave]);

  // 导入永远是「新增 EventBook」，不覆盖任何已有簿；镜像文件夹的 manifest 只由 mirrorAll 整链重推时写
  const afterImport = useCallback(async () => {
    await books.refresh();
  }, [books.refresh]);

  const guards = useMemo(() => ({ beforeExport, afterImport }), [beforeExport, afterImport]);
  const transfer = useBookTransfer(books, backup, guards);

  useEffect(() => {
    let cancelled = false;
    fetchLegacyData().then((data) => { if (!cancelled) setLegacy(data); }).catch(() => { if (!cancelled) setLegacy(null); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const message = bookData.storageError || books.storageError;
    if (!message || reportedError.current === message) return;
    reportedError.current = message;
    showToast(tr('app.storageFailed', { message: message }), 'error');
  }, [bookData.storageError, books.storageError, showToast, tr]);

  const handleCreate = useCallback(async (form) => {
    const book = await books.createBook(form);
    showToast(tr('book.created', { name: book.name }), 'info');
    return book;
  }, [books.createBook, showToast, tr]);

  const handleRestoreFile = useCallback(async (file) => {
    const result = await transfer.importFromFile(file);
    if (!result.ok) {
      showToast(tr(result.badJson ? 'header.importBadFile' : 'app.importNothing'), 'error');
      return false;
    }
    showToast(tr('app.importBooks', { n: result.count }), 'info');
    return true;
  }, [transfer.importFromFile, showToast, tr]);

  const handleImportLocal = useCallback(async () => {
    setLegacyBusy(true);
    try {
      const data = legacy || await fetchLegacyData();
      if (!data) { showToast(tr('firstRun.localNone'), 'error'); return false; }
      const result = await transfer.importEnvelope(data, { bookName: tr('book.unnamed') });
      if (!result.ok) { showToast(tr('app.importNothing'), 'error'); return false; }
      showToast(tr('app.importBooks', { n: result.count }), 'info');
      setLegacy(null);
      return true;
    } catch (err) {
      showToast(tr('firstRun.localFailed', { message: err && err.message ? err.message : String(err) }), 'error');
      return false;
    } finally {
      setLegacyBusy(false);
    }
  }, [legacy, transfer.importEnvelope, showToast, tr]);

  if (!isSupported()) {
    return <div style={screenStyle}><div style={cardStyle}>{'⚠️'} {tr('app.noStorage')}</div></div>;
  }

  if (books.loading) {
    return <div style={screenStyle}>{'⏳'} {tr('app.loading')}</div>;
  }

  if (!books.activeBook) {
    return (
      <>
        <FirstRunGuide
          lang={lang}
          legacy={legacy}
          legacyBusy={legacyBusy}
          onCreate={handleCreate}
          onRestoreFile={handleRestoreFile}
          onImportLocal={handleImportLocal}
        />
        <Toast toast={toast} />
      </>
    );
  }

  if (bookData.loading) {
    return <div style={screenStyle}>{'⏳'} {tr('app.loading')}</div>;
  }

  return (
    <>
      <Workspace
        key={books.activeBook.id}
        books={books}
        backup={backup}
        bookData={bookData}
        transfer={transfer}
        toast={toast}
        showToast={showToast}
      />
    </>
  );
}
