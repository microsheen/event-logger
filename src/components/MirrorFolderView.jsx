import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n/index.jsx';
import { listMirrorTree, ROOT_DIR_NAME, SNAPSHOT_DIR_NAME, LIST_LIMIT } from '../storage/folderBackup.js';

// 「查看镜像文件夹」：浏览器没法替用户打开资源管理器（FileSystemDirectoryHandle 只有名字，
// 没有绝对路径，也不允许网页启动本地程序），所以这里做的是浏览器能做到的那一步 ——
// 把磁盘上真实的文件名只读列出来。绝不创建目录、绝不写文件、绝不读文件内容，
// 读到的清单只用来显示，永不回流成应用状态（数据始终只来自 IndexedDB）。
const boxStyle = {
  marginTop: '8px', padding: '8px 10px', borderRadius: '8px',
  border: '1px solid var(--color-border)', background: 'var(--color-bg)',
};
const headRowStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' };
const headStyle = { fontSize: '11px', fontWeight: 700, wordBreak: 'break-all' };
const toolsStyle = { display: 'flex', gap: '4px', flexShrink: 0 };
const tinyBtnStyle = {
  padding: '2px 8px', borderRadius: '6px', background: 'var(--color-surface)',
  border: '1px solid var(--color-border)', color: 'var(--color-text)', fontSize: '11px',
};
const faintStyle = { fontSize: '11px', color: 'var(--color-text-secondary)', lineHeight: 1.6 };
const errorStyle = {
  fontSize: '11px', color: 'var(--color-danger)', background: 'var(--color-danger-light)',
  borderRadius: '6px', padding: '6px 8px', lineHeight: 1.6, wordBreak: 'break-all', marginTop: '6px',
};
const bodyStyle = { maxHeight: '160px', overflowY: 'auto', marginTop: '6px' };
const bookStyle = { borderTop: '1px dashed var(--color-border)', marginTop: '6px', paddingTop: '6px' };
const bookNameStyle = { fontSize: '11px', fontWeight: 700, wordBreak: 'break-all' };
const fileStyle = { fontSize: '11px', color: 'var(--color-text-secondary)', wordBreak: 'break-all', lineHeight: 1.5 };
const footRowStyle = { display: 'flex', alignItems: 'center', gap: '6px', marginTop: '8px', flexWrap: 'wrap' };

function hiddenCount(total, shown) {
  const left = Number(total || 0) - shown;
  return left > 0 ? left : 0;
}

export default function MirrorFolderView({ backup, versionCount, busy, scanKey, onResync, onClose }) {
  const { tr } = useI18n();
  const rootHandle = backup ? backup.rootHandle : null;
  const [state, setState] = useState({ loading: true, tree: null });
  const seq = useRef(0);

  const scan = useCallback(async (target) => {
    const mine = seq.current + 1;
    seq.current = mine;
    setState({ loading: true, tree: null });
    let result = null;
    try {
      result = await listMirrorTree(target);
    } catch (err) {
      result = { ok: false, error: 'read', message: (err && err.message) || String(err) };
    }
    if (seq.current !== mine) return;      // 已经有更新的扫描在跑，丢掉这份过期结果
    setState({ loading: false, tree: result });
  }, []);

  // 打开时扫一次；整链补齐 / 立即存档之后由上层把 scanKey 递增一下，清单就跟着重读。
  // 不挂钩每次自动镜像：那样每敲一次字都要遍历一遍目录，面板展开时反而更卡。
  useEffect(() => {
    scan(rootHandle);
  }, [rootHandle, scanKey, scan]);

  const tree = state.tree;
  const books = (tree && tree.books) || [];
  const rootFiles = (tree && tree.rootFiles) || [];
  const resyncTitle = versionCount
    ? tr('folder.resyncHint') + ' ' + tr('folder.chain', { count: versionCount })
    : tr('folder.resyncHint');

  return (
    <div style={boxStyle} data-mirror-view>
      <div style={headRowStyle}>
        <span style={headStyle}>{tr('folder.viewTitle', { name: (tree && tree.root) || (backup && backup.rootName) || '' })}</span>
        <span style={toolsStyle}>
          <button style={tinyBtnStyle} data-action="mirror-view-refresh" disabled={busy}
            onClick={() => scan(rootHandle)} title={tr('folder.viewRefreshHint')}>{tr('folder.viewRefresh')}</button>
          <button style={tinyBtnStyle} data-action="mirror-view-close" aria-label={tr('common.close')}
            onClick={onClose} title={tr('folder.hide')}>{'✕'}</button>
        </span>
      </div>
      {state.loading && <div style={faintStyle}>{tr('folder.viewLoading')}</div>}
      {!state.loading && tree && !tree.ok && (
        <div style={errorStyle}>{tr('folder.viewFailed', { message: tree.message || tree.error || '' })}</div>
      )}
      {!state.loading && tree && tree.ok && tree.missingRoot && (
        <div style={faintStyle}>{tr('folder.viewNoRoot', { root: ROOT_DIR_NAME })}</div>
      )}
      {!state.loading && tree && tree.ok && !tree.missingRoot && (
        <div style={bodyStyle}>
          {!!rootFiles.length && (
            <div>
              {rootFiles.map((name) => <div key={'r' + name} style={fileStyle}>{name}</div>)}
              {hiddenCount(tree.rootTotal, rootFiles.length) > 0 && (
                <div style={fileStyle}>{tr('folder.viewMore', { n: hiddenCount(tree.rootTotal, rootFiles.length) })}</div>
              )}
            </div>
          )}
          {books.map((row) => (
            <div key={row.folder} style={bookStyle}>
              <div style={bookNameStyle}>{row.folder + '/'}</div>
              <div style={fileStyle}>{row.files.join(' · ') || tr('folder.viewEmpty')}</div>
              <div style={fileStyle}>{tr('folder.viewSnapN', { n: row.snapshotTotal, dir: SNAPSHOT_DIR_NAME })}</div>
              <div>
                {row.snapshots.map((name) => <div key={row.folder + name} style={fileStyle}>{name}</div>)}
                {hiddenCount(row.snapshotTotal, row.snapshots.length) > 0 && (
                  <div style={fileStyle}>{tr('folder.viewMore', { n: hiddenCount(row.snapshotTotal, row.snapshots.length) })}</div>
                )}
              </div>
            </div>
          ))}
          {!books.length && !rootFiles.length && (
            <div style={faintStyle}>{tr('folder.viewNoRoot', { root: ROOT_DIR_NAME })}</div>
          )}
        </div>
      )}
      {/* 折叠进来的整链补齐：正文按钮行已经不放这种大动作了（I33） */}
      <div style={footRowStyle}>
        <button style={tinyBtnStyle} data-action="mirror-resync" disabled={busy} onClick={onResync} title={resyncTitle}>
          {busy ? tr('folder.mirroring') : tr('folder.resync')}
        </button>
        <span style={faintStyle}>{tr('folder.viewNote', { limit: LIST_LIMIT })}</span>
      </div>
    </div>
  );
}
