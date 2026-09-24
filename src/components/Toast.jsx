import React from 'react';

const toneStyle = {
  info: {
    background: 'var(--color-accent-light)', color: 'var(--color-accent)',
    border: '1px solid var(--color-accent)',
  },
  error: {
    background: 'var(--color-danger-light)', color: 'var(--color-danger)',
    border: '1px solid var(--color-danger)',
  },
};

const baseStyle = {
  position: 'fixed', bottom: '16px', left: '50%', transform: 'translateX(-50%)',
  padding: '8px 16px', borderRadius: '20px', fontSize: '12px', fontWeight: 500,
  maxWidth: '70vw', boxShadow: 'var(--shadow)', pointerEvents: 'none',
  zIndex: 1300, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
};

// 自研 toast：替代 design.md §12 点名的原生 alert，用于"粘贴被冲突拒绝"这类非阻塞反馈
export default function Toast({ toast }) {
  if (!toast || !toast.text) return null;
  const tone = toast.tone === 'error' ? toneStyle.error : toneStyle.info;
  return <div style={{ ...baseStyle, ...tone }}>{toast.text}</div>;
}
