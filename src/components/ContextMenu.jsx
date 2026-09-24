import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

const EDGE_MARGIN = 8;

const menuStyle = (x, y, ready) => ({
  position: 'fixed', left: x + 'px', top: y + 'px',
  minWidth: '140px', padding: '4px 0',
  background: 'var(--color-surface)', border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-lg)',
  zIndex: 1200, fontSize: '13px', color: 'var(--color-text)',
  userSelect: 'none', visibility: ready ? 'visible' : 'hidden',
});

const itemStyle = (hovered, disabled) => ({
  padding: '7px 14px', whiteSpace: 'nowrap',
  cursor: disabled ? 'not-allowed' : 'pointer',
  background: (hovered && !disabled) ? 'var(--color-accent-light)' : 'transparent',
  color: (hovered && !disabled) ? 'var(--color-accent)' : 'var(--color-text)',
  opacity: disabled ? 0.45 : 1,
});

// 自研右键菜单：inline style 没有 :hover，所以 hover 走 React state（同 Header 的 HoverButton）
// 菜单项在 mousedown 就动作，因为 document 上的关闭监听比 click 先到，等 click 时本体已经卸载了
export default function ContextMenu({ x, y, items, onClose }) {
  const menuRef = useRef(null);
  const [pos, setPos] = useState({ x: x, y: y });
  const [ready, setReady] = useState(false);
  const [hoverKey, setHoverKey] = useState(null);

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const nextX = Math.max(EDGE_MARGIN, Math.min(x, window.innerWidth - rect.width - EDGE_MARGIN));
    const nextY = Math.max(EDGE_MARGIN, Math.min(y, window.innerHeight - rect.height - EDGE_MARGIN));
    setPos({ x: nextX, y: nextY });
    setReady(true);
  }, [x, y, items]);

  useEffect(() => {
    const close = () => onClose();
    const onKeyDown = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', close);
    document.addEventListener('contextmenu', close);
    document.addEventListener('wheel', close, { passive: true });
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('contextmenu', close);
      document.removeEventListener('wheel', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  const handleItemMouseDown = (item, e) => {
    e.preventDefault();
    e.stopPropagation(); // 别冒到 document 的关闭监听，也别穿到时间轴槽位触发拖拽新建
    if (item.disabled) return;
    if (item.onSelect) item.onSelect();
    onClose(); // 动作完即收起，不留"已粘贴但菜单还挂着"的中间态
  };

  // 菜单自身吃掉 mousedown / contextmenu：前者防穿透到槽位，后者让菜单内再右键不把它关掉
  return (
    <div ref={menuRef} style={menuStyle(pos.x, pos.y, ready)}
      onMouseDown={e => e.stopPropagation()}
      onContextMenu={e => { e.preventDefault(); e.stopPropagation(); }}
      onMouseLeave={() => setHoverKey(null)}>
      {items.map(item => (
        <div key={item.key}
          style={itemStyle(hoverKey === item.key, !!item.disabled)}
          onMouseEnter={() => setHoverKey(item.key)}
          onMouseDown={e => handleItemMouseDown(item, e)}>
          {item.label}
        </div>
      ))}
    </div>
  );
}
