import React, { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../i18n/index.jsx';
import { BUILD_ID } from '../buildInfo.js';
import { isPersisted } from '../storage/idb.js';
import { CONTACT_EMAIL, buildDiagnosticsText, issuesUrl, mailtoUrl } from '../utils/contact.js';

// 顶栏「💬 反馈」的独立面板：帮助是说明书，这里是找人的路，两个入口各自一个面板。
// 对外动作只有两枚 <a> 的 href —— 用户不点，页面就不会长出任何对外请求；
// 诊断块的原料（数组只报计数、字段白名单、长度上限）全部收口在 src/utils/contact.js 里。

const overlayStyle = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  zIndex: 1000, backdropFilter: 'blur(2px)',
};
const panelStyle = {
  background: 'var(--color-surface)', borderRadius: '12px',
  width: '560px', maxWidth: '92vw', maxHeight: '86vh',
  display: 'flex', flexDirection: 'column', overflow: 'hidden',
  boxShadow: 'var(--shadow-lg)',
};
const headStyle = {
  display: 'flex', alignItems: 'center', gap: '12px',
  padding: '20px 24px 6px', flexShrink: 0,
};
const titleStyle = { fontSize: '18px', fontWeight: 700, flex: 1 };
const closeBtnStyle = {
  padding: '4px 10px', borderRadius: 'var(--radius)', fontSize: '16px', lineHeight: 1,
  background: 'var(--color-bg)', color: 'var(--color-text)', border: '1px solid var(--color-border)',
};
// 正文自己滚：窗口再矮，也不会把两枚入口和诊断块挤出可视区
const bodyStyle = { overflowY: 'auto', padding: '0 24px 10px', flex: 1 };
const introStyle = { fontSize: '12.5px', color: 'var(--color-text-secondary)', lineHeight: 1.7, margin: '0 0 10px' };
const paraStyle = { margin: '0 0 8px', fontSize: '12.5px', lineHeight: 1.7, color: 'var(--color-text)' };
const emailLabelStyle = { fontSize: '11.5px', color: 'var(--color-text-secondary)', marginBottom: '6px' };
const emailStyle = {
  fontSize: '13px', fontWeight: 700, color: 'var(--color-text)', background: 'var(--color-bg)',
  border: '1px solid var(--color-border)', borderRadius: 'var(--radius)', padding: '6px 10px',
  width: 'fit-content', userSelect: 'all', margin: '0 0 8px',
};
const contactRowStyle = { display: 'flex', flexWrap: 'wrap', gap: '8px', margin: '0 0 12px' };
const contactLinkStyle = {
  fontSize: '12px', fontWeight: 600, textDecoration: 'none', width: 'fit-content',
  padding: '6px 12px', borderRadius: '16px', background: 'var(--color-accent)',
  color: '#fff', border: '1px solid var(--color-accent)',
};
const diagLabelStyle = { fontSize: '11.5px', color: 'var(--color-text-secondary)', marginBottom: '6px' };
const diagAreaStyle = {
  font: '11px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', width: '100%',
  boxSizing: 'border-box', padding: '8px 10px', borderRadius: 'var(--radius)', resize: 'vertical',
  background: 'var(--color-bg)', color: 'var(--color-text-secondary)', border: '1px solid var(--color-border)',
};
const contactHintStyle = { fontSize: '11.5px', color: 'var(--color-text-secondary)', lineHeight: 1.7, marginTop: '8px' };
const footStyle = {
  padding: '12px 24px 18px', fontSize: '11px', color: 'var(--color-text-secondary)',
  textAlign: 'center', flexShrink: 0,
};

function navigatorUserAgent() {
  return typeof navigator === 'undefined' ? '' : navigator.userAgent;
}

export default function ContactDialog({ open, onClose, diag }) {
  const { tr } = useI18n();
  const [persisted, setPersisted] = useState(null);
  // draft 为 null 表示「用户还没动过诊断块」，这时文本跟着自动值走（persisted 是异步回来的）
  const [draft, setDraft] = useState(null);
  // open 从 false 翻到 true 的那一帧就在 render 期清状态（React 官方的 adjusting-state 写法）。
  // 只靠 useEffect 做不到这件事：effect 在 commit 之后才跑，于是浏览器会先绘制一帧上一次的草稿。
  // headless Chrome 在 CI 上就是这么抓住「关掉再打开不残留手改草稿」这条断言的，本机快反而看不见。
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setDraft(null);
      setPersisted(null);
    }
  }

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // 每次打开重新采一次：诊断块说的就是「这次打开时」的状态，改动本身由上面那一段负责丢弃
  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    isPersisted().then((value) => { if (alive) setPersisted(value); });
    return () => { alive = false; };
  }, [open]);

  const source = diag || {};
  const autoText = useMemo(() => buildDiagnosticsText({
    books: source.books,
    events: source.events,
    snapshots: source.snapshots,
    lang: source.lang,
    mirrorConnected: source.mirrorConnected,
    persisted,
    buildId: BUILD_ID,
    userAgent: navigatorUserAgent(),
  }), [source.books, source.events, source.snapshots, source.lang, source.mirrorConnected, persisted]);

  if (!open) return null;

  const subject = tr('contact.subject');
  const diagText = draft === null ? autoText : draft;
  const mailHref = mailtoUrl(subject, diagText);
  const issuesHref = issuesUrl(subject, diagText);

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={panelStyle} onClick={(e) => e.stopPropagation()} data-contact-dialog
        role="dialog" aria-modal="true" aria-label={tr('contact.title')}>
        <div style={headStyle}>
          <div style={titleStyle}>{tr('contact.title')}</div>
          <button style={closeBtnStyle} onClick={onClose} data-action="contact-close"
            aria-label={tr('common.close')} title={tr('common.close')}>{'✕'}</button>
        </div>
        <div style={bodyStyle} data-contact-body>
          <div style={introStyle} data-contact-intro>{tr('contact.intro')}</div>
          <div data-contact-lines>
            {(tr('contact.lines') || []).map((para, i) => (
              <p key={i} style={paraStyle}>{para}</p>
            ))}
          </div>
          <div style={emailLabelStyle} data-contact-email-label>{tr('contact.emailLabel')}</div>
          <div style={emailStyle} data-contact-email title={CONTACT_EMAIL}>{CONTACT_EMAIL}</div>
          <div style={contactRowStyle}>
            <a style={contactLinkStyle} href={mailHref} data-contact-mail
              title={tr('contact.mailTip')}>{tr('contact.mailLabel')}</a>
            <a style={contactLinkStyle} href={issuesHref} data-contact-issues
              target="_blank" rel="noopener noreferrer"
              title={tr('contact.issuesTip')}>{tr('contact.issuesLabel')}</a>
          </div>
          <div style={diagLabelStyle} data-contact-diag-label>{tr('contact.diagLabel')}</div>
          <textarea style={diagAreaStyle} rows={6} spellCheck={false} data-contact-diag
            aria-label={tr('contact.diagLabel')}
            value={diagText} onChange={(e) => setDraft(e.target.value)} />
          <div style={contactHintStyle} data-contact-hint>{tr('contact.noMailHint')}</div>
        </div>
        <div style={footStyle}>{tr('app.localBadge')}</div>
      </div>
    </div>
  );
}
