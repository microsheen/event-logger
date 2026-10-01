import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { I18nProvider, useI18n } from './i18n/index.jsx';
import { useBooks } from './hooks/useBooks.js';
import { useBackupFolder } from './hooks/useBackupFolder.js';
import { useBookData } from './hooks/useBookData.js';
import { useBookTransfer } from './hooks/useBookTransfer.js';
import { useToast } from './hooks/useToast.js';
import Toast from './components/Toast.jsx';
import Workspace from './components/Workspace.jsx';
import { isSupported } from './storage/idb.js';
import './styles/global.css';

const screenStyle = {
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  height: '100vh', padding: '24px', textAlign: 'center',
  fontSize: '16px', color: 'var(--color-text-secondary)',
};

const errDetailStyle = {
  marginTop: '10px', fontSize: '12px', color: 'var(--color-text-secondary)', wordBreak: 'break-all',
};
const retryBtnStyle = {
  marginTop: '18px', padding: '10px 22px', borderRadius: 'var(--radius)',
  background: 'var(--color-accent)', color: '#fff', fontWeight: 700, fontSize: '14px',
};

const cardStyle = {
  maxWidth: '520px', margin: '0 auto', padding: '28px',
  background: 'var(--color-surface)', border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius)', boxShadow: 'var(--shadow)',
  fontSize: '14px', color: 'var(--color-text)', lineHeight: 1.7, textAlign: 'left',
};

// 语言由当前 EventBook 决定，所以 Provider 必须在读到 book 之后再包一层。
// 渲染门顺序：不支持 IDB → 书目加载中（含零本书时自举默认簿）→ 本书数据加载中 → Workspace
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
  const { tr } = useI18n();
  const { toast, showToast } = useToast();
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
    const message = bookData.storageError || books.storageError;
    if (!message || reportedError.current === message) return;
    reportedError.current = message;
    showToast(tr('app.storageFailed', { message: message }), 'error');
  }, [bookData.storageError, books.storageError, showToast, tr]);

  if (!isSupported()) {
    return <div style={screenStyle}><div style={cardStyle}>{'⚠️'} {tr('app.noStorage')}</div></div>;
  }

  if (books.loading) {
    return <div style={screenStyle}>{'⏳'} {tr('app.loading')}</div>;
  }

  // 一本 book 都没有时 useBooks 会当场自举「默认」簿，所以这里只剩「连自举都失败」：
  // 配额耗尽 / 隐私模式 / IDB 被别的标签页阻塞。引导页已经不存在，给一条重试出口。
  if (!books.activeBook) {
    return (
      <>
        <div style={screenStyle}>
          <div style={cardStyle}>
            <div>{'⚠️'} {tr('app.initFailed')}</div>
            {books.storageError && <div style={errDetailStyle}>{books.storageError}</div>}
            <button style={retryBtnStyle} onClick={() => window.location.reload()}>
              {tr('common.retry')}
            </button>
          </div>
        </div>
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
