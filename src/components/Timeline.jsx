import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { slotToTime, slotRangeLabel, formatDate, getWeekRange } from '../utils/time.js';
import { getCategory } from '../utils/categories.js';
import { neighbourBounds, resizeRange, boundarySlotFromY, EDGE_HANDLE_HEIGHT } from '../utils/slotRange.js';
import { useI18n } from '../i18n/index.jsx';
import { dayHeaderLabel } from '../i18n/format.js';
import { pasteRange, hasOverlap } from '../utils/eventClipboard.js';
import { freeWindowsForDay, clampMoveToFreeWindow, columnIndexOfX } from '../utils/dayDrop.js';
import ContextMenu from './ContextMenu.jsx';

const SLOT_HEIGHT = 20;
const TIME_COLUMN_WIDTH_PX = 48;
const TIME_COLUMN_WIDTH = TIME_COLUMN_WIDTH_PX + 'px';
const DAY_COLUMN_MIN_WIDTH = '120px';
const TOTAL_SLOTS = 144;
// 跨日期拖动：指针进入滚动区左右边缘 24px 内自动横滚，一帧一步 6px；落点恒夹在可见列内（不跨周翻页）
const EDGE_SCROLL_ZONE = 24;
const EDGE_SCROLL_STEP = 6;
const NO_EVENTS = []; // 稳定的空数组，避免每次渲染造一个新 [] 把 React.memo 打穿

const containerStyle = {
  flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden',
};

const toolbarStyle = {
  display: 'flex', alignItems: 'center', gap: '8px',
  padding: '8px 16px', borderBottom: '1px solid var(--color-border)',
  background: 'var(--color-surface)', fontSize: '13px', flexShrink: 0,
};

const selectStyle = {
  padding: '4px 8px', border: '1px solid var(--color-border)',
  borderRadius: '6px', fontSize: '13px', background: 'var(--color-bg)', cursor: 'pointer',
};

const viewTabStyle = (active) => ({
  padding: '5px 14px', borderRadius: '6px',
  background: active ? 'var(--color-accent)' : 'var(--color-bg)',
  color: active ? '#fff' : 'var(--color-text-secondary)',
  border: '1px solid ' + (active ? 'var(--color-accent)' : 'var(--color-border)'),
  fontWeight: active ? 600 : 400, fontSize: '12px',
});

const headerRowStyle = {
  display: 'flex', background: 'var(--color-surface)',
  borderBottom: '1px solid var(--color-border)', flexShrink: 0,
};

const cornerHeaderStyle = {
  flex: '0 0 ' + TIME_COLUMN_WIDTH, minWidth: TIME_COLUMN_WIDTH,
  background: 'var(--color-surface)', padding: '8px 4px',
  textAlign: 'center', fontSize: '12px', fontWeight: 600,
  color: 'var(--color-text-secondary)',
};

const headerClipStyle = { flex: 1, overflow: 'hidden' };

const headerInnerStyle = {
  display: 'flex', width: 'max-content', minWidth: '100%', willChange: 'transform',
};

const dayHeaderStyle = {
  flex: 1, minWidth: DAY_COLUMN_MIN_WIDTH, background: 'var(--color-surface)',
  padding: '8px 4px', textAlign: 'center', fontSize: '12px', fontWeight: 600,
};

const todayHeaderStyle = {
  ...dayHeaderStyle, background: 'var(--color-accent-light)', color: 'var(--color-accent)',
};

const scrollAreaStyle = { flex: 1, overflow: 'auto', padding: '0' };

const gridWrapperStyle = {
  display: 'flex', flexDirection: 'column', width: 'max-content',
  minWidth: '100%', minHeight: '100%', paddingTop: '10px',
};

const weekGridStyle = { display: 'flex' };

const timeColumnStyle = {
  width: TIME_COLUMN_WIDTH, minWidth: TIME_COLUMN_WIDTH, flexShrink: 0,
  position: 'sticky', left: 0, zIndex: 5, background: 'var(--color-surface)',
};

const dayColumnStyle = {
  flex: 1, minWidth: DAY_COLUMN_MIN_WIDTH,
  borderLeft: '1px solid var(--color-border)', position: 'relative',
};

const slotBaseStyle = {
  height: SLOT_HEIGHT + 'px', borderBottom: '1px solid #f0f0f0',
  position: 'relative', cursor: 'pointer', transition: 'background 0.1s',
};

const hourSlotStyle = { ...slotBaseStyle, borderTop: '1px solid #ddd' };

const timeLabelStyle = { height: SLOT_HEIGHT + 'px', position: 'relative' };

const timeLabelTextStyle = {
  position: 'absolute', right: '6px', top: 0,
  transform: 'translateY(-50%)', fontSize: '10px',
  color: 'var(--color-text-secondary)', fontWeight: 500,
  lineHeight: '1', background: 'var(--color-surface)', padding: '0 2px',
};

function getEventStyle(event, baseSlot) {
  const top = (event.startSlot - baseSlot) * SLOT_HEIGHT;
  const height = (event.endSlot - event.startSlot) * SLOT_HEIGHT;
  const cat = getCategory(event.category);
  return {
    position: 'absolute', top: top + 'px',
    left: '2px', right: '2px', height: height + 'px',
    background: cat.light, borderLeft: '3px solid ' + cat.color,
    borderRadius: '3px', padding: '1px 4px',
    fontSize: '10px', fontWeight: 500, color: cat.hover,
    display: 'flex', alignItems: 'center',
    cursor: 'grab', zIndex: 10, overflow: 'hidden', lineHeight: '1.2',
  };
}

function getGhostEventStyle(event, baseSlot) {
  const base = getEventStyle(event, baseSlot);
  return { ...base, opacity: 0.5, zIndex: 20, cursor: 'grabbing', pointerEvents: 'none', boxShadow: '0 2px 8px rgba(0,0,0,0.2)' };
}

// 粘贴落点预览：与真实落点用同一个 pasteRange/hasOverlap 算出来，所以"看到哪就是贴到哪"；会冲突时整块转红
function getPastePreviewStyle(preview, baseSlot) {
  const base = getEventStyle(
    { startSlot: preview.startSlot, endSlot: preview.endSlot, category: preview.category },
    baseSlot,
  );
  if (preview.conflict) {
    return {
      ...base, zIndex: 14, opacity: 0.6, pointerEvents: 'none',
      background: 'var(--color-danger-light)', borderLeft: '3px dashed var(--color-danger)',
      color: 'var(--color-danger)',
    };
  }
  return {
    ...base, zIndex: 14, opacity: 0.6, pointerEvents: 'none',
    borderLeft: '3px dashed ' + getCategory(preview.category).color,
  };
}

// 跨日期拖动的落点预览：与真正提交走同一个 clampMoveToFreeWindow，所以“看到哪就是搬到哪”。
// 目标日装得下就显示夹紧后的真实落点，装不下就停在候选位并整块转红——红色用实线左边框，
// 与粘贴预览的虚线冲突态区分开：“会被拒绝”和“会自动避让”是两种语义。
function getDropGhostStyle(preview, baseSlot) {
  const base = getGhostEventStyle({
    startSlot: preview.startSlot, endSlot: preview.endSlot, category: preview.category,
  }, baseSlot);
  if (preview.valid) return { ...base, zIndex: 22 };
  return {
    ...base, zIndex: 22,
    background: 'var(--color-danger-light)', borderLeft: '3px solid var(--color-danger)',
    color: 'var(--color-danger)',
  };
}

// 目标列表头跟着落点变色：指针纵向拖出可见区时，列高亮是唯一还看得见的落点提示
const dropTargetHeaderStyle = (valid) => ({
  ...dayHeaderStyle,
  background: valid ? 'var(--color-accent-light)' : 'var(--color-danger-light)',
  color: valid ? 'var(--color-accent)' : 'var(--color-danger)',
});

// 上下边缘热区：无可见外观，只负责把光标变成 ns-resize 并接住 mousedown
const edgeHandleStyle = (edge) => ({
  position: 'absolute', left: 0, right: 0, height: EDGE_HANDLE_HEIGHT + 'px',
  top: edge === 'start' ? 0 : 'auto', bottom: edge === 'end' ? 0 : 'auto',
  cursor: 'ns-resize', background: 'transparent', zIndex: 2,
});

function buildTimeOptions() {
  const opts = [];
  for (let i = 0; i <= TOTAL_SLOTS; i++) {
    opts.push({ value: i, label: slotToTime(i) });
  }
  return opts;
}

const TIME_OPTIONS = buildTimeOptions();

function getWeekDates(selectedDate, weekStartsOn) {
  const [firstDay] = getWeekRange(selectedDate, weekStartsOn);
  const dates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(firstDay);
    d.setDate(firstDay.getDate() + i);
    dates.push(d);
  }
  return dates;
}
// React.memo：拖动每帧只让“目标列”重渲染，其余 6 列拿到的 props 引用全不变（含 NO_EVENTS / null）
const DayColumn = React.memo(function DayColumn({ date, events, timelineStart, timelineEnd, onCreateEvent,
  onEditEvent, onMoveEvent, cutId, pastePreview, onEventContextMenu, onBlankContextMenu,
  resolveDrop, endDrop, dropPreview, registerColumn, onDropBlocked, readOnly }) {
  const { tr } = useI18n();
  const [hoverSlot, setHoverSlot] = useState(null);
  const [slotDragStart, setSlotDragStart] = useState(null);
  const [slotDragEnd, setSlotDragEnd] = useState(null);
  // 只用于“把原地那条压暗”；落点预览住在上层 Timeline（dropPreview），因为它要知道落到哪一列
  const [draggingEvent, setDraggingEvent] = useState(null);
  // 边缘缩放中的事件：{ id, edge, startSlot, endSlot }，端点只活在拖动期间，松手才提交
  const [resize, setResize] = useState(null);
  const columnRef = useRef(null);

  const dateStr = formatDate(date);

  // 双写：本列用 rect.top 算纵向槽位，父层用 rect.left/right 判横向落到哪一天
  const attachColumn = useCallback((el) => {
    columnRef.current = el;
    registerColumn(dateStr, el);
  }, [registerColumn, dateStr]);

  const slotEventMap = useMemo(() => {
    const map = {};
    events.forEach(e => {
      for (let s = e.startSlot; s < e.endSlot; s++) { map[s] = e; }
    });
    return map;
  }, [events]);

  const getSlotFromY = useCallback((clientY) => {
    if (!columnRef.current) return null;
    const rect = columnRef.current.getBoundingClientRect();
    const y = clientY - rect.top;
    const slot = Math.floor(y / SLOT_HEIGHT) + timelineStart;
    return Math.max(timelineStart, Math.min(timelineEnd - 1, slot));
  }, [timelineStart, timelineEnd]);

  const handleSlotMouseDown = useCallback((slot, e) => {
    if (readOnly) return; // 只读回放：不启动新建拖拽
    if (e.button !== 0) return; // 右键只走 contextmenu，别顺手开始一次拖拽新建
    if (slotEventMap[slot]) return;
    e.preventDefault();
    setSlotDragStart(slot);
    setSlotDragEnd(slot);

    const handleMove = (moveEvt) => {
      const s = getSlotFromY(moveEvt.clientY);
      if (s !== null) {
        setHoverSlot(s);
        setSlotDragEnd(s);
      }
    };
    const handleUp = () => {
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
      setSlotDragStart(prev => {
        setSlotDragEnd(prevEnd => {
          if (prev !== null && prevEnd !== null) {
            const start = Math.min(prev, prevEnd);
            const end = Math.max(prev, prevEnd) + 1;
            if (!slotEventMap[start]) {
              onCreateEvent(start, end, dateStr);
            }
          }
          return null;
        });
        return null;
      });
    };
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
  }, [slotEventMap, getSlotFromY, onCreateEvent, dateStr, readOnly]);

  // 一个手势两种意图：拖过就是“移动”，没拖过就是“打开编辑”。
  // 跨日期之后落点不能由本列自己算了——交给 Timeline 的 resolveDrop（它看得见所有列），
  // 本列只保留“到底拖过没有”和“最后一次落点长什么样”两件事。
  const handleEventMouseDown = useCallback((event, e) => {
    if (readOnly) return; // 只读回放：不启动移动/编辑手势
    if (e.button !== 0) return; // 右键只弹菜单，不启动移动/编辑手势
    e.preventDefault();
    e.stopPropagation();
    const startSlot = getSlotFromY(e.clientY);
    if (startSlot === null) return;
    const offset = startSlot - event.startSlot;
    let hasMoved = false;
    let last = null;

    const handleMove = (moveEvt) => {
      const next = resolveDrop(event, offset, moveEvt.clientX, moveEvt.clientY);
      if (!next) return;
      hasMoved = true;
      last = next;
      setDraggingEvent(event);
      document.body.classList.add('slot-moving');
    };
    const handleUp = () => {
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
      document.body.classList.remove('slot-moving');
      setDraggingEvent(null);
      endDrop();
      if (!hasMoved) { onEditEvent(event); return; }
      if (!last) return;
      // 目标日没有放得下的连续空档：整次作废，时长绝不为了“塞进去”而变形；只在真的跨日期时提示
      if (!last.valid) {
        if (last.dateStr !== dateStr) onDropBlocked(last.dateStr);
        return;
      }
      if (last.dateStr !== dateStr || last.startSlot !== event.startSlot || last.endSlot !== event.endSlot) {
        onMoveEvent(event.id, last.startSlot, last.endSlot, last.dateStr);
      }
    };
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
  }, [getSlotFromY, dateStr, onMoveEvent, onEditEvent, resolveDrop, endDrop, onDropBlocked, readOnly]);

  // 上边缘改 startSlot、下边缘改 endSlot：按下时快照邻居墙与视口，拖动过程中不重算，避免墙跟着端点漂移
  const handleEdgeMouseDown = useCallback((event, edge, e) => {
    if (readOnly) return; // 只读回放：不启动缩放手势
    if (e.button !== 0) return; // 右键只弹菜单
    if (!columnRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    const rectTop = columnRef.current.getBoundingClientRect().top;
    const original = { startSlot: event.startSlot, endSlot: event.endSlot };
    const bounds = { min: timelineStart, max: timelineEnd };
    const neighbours = neighbourBounds(events, event);
    const originY = e.clientY;
    let pointerMoved = false; // 用像素位移判定是不是点击：被邻居墙完全挡住时不该弹出编辑框
    let last = original;

    document.body.classList.add('slot-resizing');

    const handleMove = (moveEvt) => {
      const candidate = boundarySlotFromY(moveEvt.clientY, rectTop, timelineStart, SLOT_HEIGHT);
      const next = resizeRange(original, edge, candidate, bounds, neighbours);
      if (Math.abs(moveEvt.clientY - originY) > 2) pointerMoved = true;
      last = next;
      setResize({ id: event.id, edge, startSlot: next.startSlot, endSlot: next.endSlot });
    };
    const handleUp = () => {
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
      document.body.classList.remove('slot-resizing');
      setResize(null);
      if (last.startSlot !== original.startSlot || last.endSlot !== original.endSlot) {
        // 缩放永远不跨日期，第四参显式传当天，与移动路径同一套签名
        onMoveEvent(event.id, last.startSlot, last.endSlot, dateStr);
      } else if (!pointerMoved) {
        // 与条体同一套「一个手势两种意图」：边缘单击（没真的改动区间）仍是打开编辑
        onEditEvent(event);
      }
    };
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
  }, [events, timelineStart, timelineEnd, onMoveEvent, onEditEvent, readOnly]);

  const slots = [];
  for (let i = timelineStart; i < timelineEnd; i++) {
    const isHour = i % 6 === 0;
    const inDragRange = slotDragStart !== null && slotDragEnd !== null &&
      i >= Math.min(slotDragStart, slotDragEnd) && i <= Math.max(slotDragStart, slotDragEnd);
    const isHover = hoverSlot === i && slotDragStart === null && !draggingEvent && !resize;
    const hasEvent = !!slotEventMap[i];
    let bg = 'transparent';
    if (inDragRange && !hasEvent) bg = 'var(--color-accent-light)';
    else if (isHover && !hasEvent) bg = '#f8f9fa';
    slots.push(
      <div key={i}
        data-slot={i}
        style={isHour ? { ...hourSlotStyle, background: bg } : { ...slotBaseStyle, background: bg }}
        onMouseDown={(e) => handleSlotMouseDown(i, e)}
        onMouseMove={() => setHoverSlot(i)}
        onContextMenu={(e) => onBlankContextMenu(dateStr, i, e)}
      />
    );
  }

  const visibleEvents = events.filter(e => e.startSlot < timelineEnd && e.endSlot > timelineStart);

  return (
    <div style={dayColumnStyle}
      data-date={dateStr}
      data-weekday={date.getDay()}
      onMouseLeave={() => setHoverSlot(null)}
      ref={attachColumn}
    >
      <div style={{ position: 'relative', userSelect: 'none' }}>
        {slots}
        {visibleEvents.map(e => {
          const isBeingDragged = draggingEvent && draggingEvent.id === e.id;
          const activeResize = resize && resize.id === e.id ? resize : null;
          // 拖动中的事件本体直接跟手（不用幽灵块），tooltip 同步显示预览区间
          const shown = activeResize
            ? { ...e, startSlot: activeResize.startSlot, endSlot: activeResize.endSlot }
            : e;
          const barStyle = getEventStyle(shown, timelineStart);
          // 待粘贴的剪切事件：留在原地但压暗 + 虚线边，真搬动发生在 paste 那一刻（延迟删除）
          const isCutPending = cutId != null && cutId === e.id;
          const finalStyle = isCutPending
            ? { ...barStyle, opacity: 0.45, borderLeft: '3px dashed ' + getCategory(e.category).color }
            : barStyle;
          return (
            <div key={e.id}
              data-event-id={e.id}
              data-start={shown.startSlot}
              data-end={shown.endSlot}
              style={isBeingDragged
                ? { ...finalStyle, opacity: 0.25 }
                : (activeResize ? { ...finalStyle, zIndex: 12, cursor: 'ns-resize' } : finalStyle)
              }
              onMouseDown={(ev) => handleEventMouseDown(e, ev)}
              onContextMenu={(ev) => {
                ev.preventDefault();
                ev.stopPropagation(); // 别冒到 ContextMenu 的 document 关闭监听，也别落到下面的槽位
                onEventContextMenu(e, ev.clientX, ev.clientY);
              }}
              title={e.name + ' (' + tr('category.' + e.category) + ')\n' + slotRangeLabel(shown.startSlot, shown.endSlot)
                + (isCutPending ? '\n' + tr('timeline.cutHint', { name: e.name }) : '')}
            >
              {e.name}
              <div style={edgeHandleStyle('start')} onMouseDown={(ev) => handleEdgeMouseDown(e, 'start', ev)} />
              <div style={edgeHandleStyle('end')} onMouseDown={(ev) => handleEdgeMouseDown(e, 'end', ev)} />
            </div>
          );
        })}
        {pastePreview && (
          <div style={getPastePreviewStyle(pastePreview, timelineStart)}
            title={pastePreview.name + ' (' + slotRangeLabel(pastePreview.startSlot, pastePreview.endSlot) + ')\n' + pastePreview.hint}>
            {pastePreview.name}
          </div>
        )}
        {dropPreview && (
          <div style={getDropGhostStyle(dropPreview, timelineStart)}
            title={dropPreview.name + ' (' + slotRangeLabel(dropPreview.startSlot, dropPreview.endSlot) + ')'}>
            {dropPreview.name}
          </div>
        )}
      </div>
    </div>
  );
});
export default function Timeline({ events, selectedDate, onCreateEvent, onEditEvent, onMoveEvent, timelineStart, timelineEnd, onTimelineStartChange, onTimelineEndChange,
  clipboard, onCopyEvent, onCutEvent, onPasteClipboard, onClearClipboard, onMoveBlocked,
  weekStartsOn, readOnly }) {
  const { lang, tr } = useI18n();
  const [viewMode, setViewMode] = useState('week');
  // 右键菜单态：kind='event' 带事件本体，kind='blank' 带目标日期列 + 槽位
  const [menu, setMenu] = useState(null);
  const headerInnerRef = useRef(null);
  // —— 跨日期拖动：落点是“哪一列”级别的状态，必须住在 Timeline 而不是 DayColumn ——
  const [dropPreview, setDropPreview] = useState(null);
  const scrollAreaRef = useRef(null);
  const columnElsRef = useRef(new Map());
  const pointerRef = useRef(null); // 最近一次拖动意图 { event, offset, clientX, clientY }
  const edgeScrollRef = useRef({ raf: 0, dir: 0 });
  const resolveDropRef = useRef(null);

  const weekDates = useMemo(() => getWeekDates(selectedDate, weekStartsOn), [selectedDate, weekStartsOn]);

  const weekEventsByDate = useMemo(() => {
    const weekDateStrs = new Set(weekDates.map(d => formatDate(d)));
    const map = {};
    weekDates.forEach(d => { map[formatDate(d)] = []; });
    events.filter(e => weekDateStrs.has(e.date)).forEach(e => {
      if (map[e.date]) map[e.date].push(e);
    });
    return map;
  }, [events, weekDates]);

  const dayEvents = useMemo(() => {
    const dateStr = formatDate(selectedDate);
    return events.filter(e => e.date === dateStr);
  }, [events, selectedDate]);

  // 可落点的列 = 当前可见列：周视图 7 列，日视图 1 列——同一套代码自动退化成“只能同日移动”
  const visibleDateStrs = useMemo(
    () => (viewMode === 'week' ? weekDates.map(d => formatDate(d)) : [formatDate(selectedDate)]),
    [viewMode, weekDates, selectedDate],
  );

  // 落点判定要按日期取“目标日已有的事件”，与列渲染共用同一份派生结果，不另建索引
  const eventsByDateStr = useMemo(() => (
    viewMode === 'week' ? weekEventsByDate : { [formatDate(selectedDate)]: dayEvents }
  ), [viewMode, weekEventsByDate, dayEvents, selectedDate]);

  const registerColumn = useCallback((dateStr, el) => {
    if (el) columnElsRef.current.set(dateStr, el);
    else columnElsRef.current.delete(dateStr);
  }, []);

  // 一次 pointermove 可能撞上多帧；落点没变就复用旧对象，其余 6 列的 React.memo 才有意义
  const sameDrop = (a, b) => !!a && !!b && a.dateStr === b.dateStr
    && a.startSlot === b.startSlot && a.endSlot === b.endSlot && a.valid === b.valid;

  // 边缘自动横滚：一帧滚一步，滚完立刻用同一个 resolveDrop 重算落点，所以“滚到哪、落到哪”永远一致
  const tick = useCallback(() => {
    const s = edgeScrollRef.current;
    s.raf = 0;
    const area = scrollAreaRef.current;
    const p = pointerRef.current;
    if (!area || !p || !s.dir || !resolveDropRef.current) return;
    area.scrollLeft += s.dir * EDGE_SCROLL_STEP; // 改 scrollLeft → onScroll 照常触发，表头位移保持同步
    resolveDropRef.current(p.event, p.offset, p.clientX, p.clientY);
  }, []);

  const setEdgeScroll = useCallback((dir) => {
    const s = edgeScrollRef.current;
    const nextDir = pointerRef.current ? dir : 0; // 没有拖动在进行就不该让 rAF 跑起来
    if (s.dir === nextDir) {
      if (nextDir && !s.raf) s.raf = requestAnimationFrame(tick);
      return;
    }
    s.dir = nextDir;
    if (s.raf) { cancelAnimationFrame(s.raf); s.raf = 0; }
    if (nextDir) s.raf = requestAnimationFrame(tick);
  }, [tick]);

  // 完整落点：横向定列 → 纵向定槽 → 时长锁死、夹进目标日空档，顺手驱动边缘自动横滚
  const resolveDrop = useCallback((event, offset, clientX, clientY) => {
    const area = scrollAreaRef.current;
    if (!area) return null;
    const duration = event.endSlot - event.startSlot;
    if (!(duration >= 1)) return null; // 脏数据（零长/倒序）不进入拖动
    const scrollRect = area.getBoundingClientRect();
    // 拖到网格外（工具栏、表头、侧栏）不取消拖动，而是吸附到最近的一列：落点恒在可见列内
    const x = Math.max(scrollRect.left + TIME_COLUMN_WIDTH_PX + 1, Math.min(scrollRect.right - 1, clientX));
    const rects = visibleDateStrs.map((ds) => {
      const el = columnElsRef.current.get(ds);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top };
    });
    const index = columnIndexOfX(x, rects);
    if (index < 0 || !rects[index]) return null;
    const dateStr = visibleDateStrs[index];
    const rawSlot = Math.floor((clientY - rects[index].top) / SLOT_HEIGHT) + timelineStart;
    const slot = Math.max(timelineStart, Math.min(timelineEnd - 1, rawSlot));
    const candidate = Math.max(0, Math.min(TOTAL_SLOTS - duration, slot - offset));
    const clamped = clampMoveToFreeWindow(
      freeWindowsForDay(eventsByDateStr[dateStr] || NO_EVENTS, event.id), duration, candidate,
    );
    // 装不下时预览停在候选位并整块转红：位置仍然跟手，只是松手会作废
    const next = {
      id: event.id, name: event.name, category: event.category, dateStr: dateStr,
      startSlot: clamped.valid ? clamped.startSlot : candidate,
      endSlot: clamped.valid ? clamped.endSlot : candidate + duration,
      valid: clamped.valid,
    };
    pointerRef.current = { event: event, offset: offset, clientX: clientX, clientY: clientY };
    const canScrollX = area.scrollWidth > area.clientWidth + 1;
    const zoneLeft = scrollRect.left + TIME_COLUMN_WIDTH_PX + EDGE_SCROLL_ZONE;
    const zoneRight = scrollRect.right - EDGE_SCROLL_ZONE;
    setEdgeScroll(canScrollX ? (clientX < zoneLeft ? -1 : (clientX > zoneRight ? 1 : 0)) : 0);
    setDropPreview((prev) => (sameDrop(prev, next) ? prev : next));
    return next;
  }, [visibleDateStrs, eventsByDateStr, timelineStart, timelineEnd, setEdgeScroll]);

  // 拖动结束（含切日期 / 切视图 / 卸载等异常路径）：停掉横滚循环并收起预览，绝不留“没有在拖却在滚动”的僵尸 rAF
  const endDrop = useCallback(() => {
    pointerRef.current = null;
    const s = edgeScrollRef.current;
    s.dir = 0;
    if (s.raf) { cancelAnimationFrame(s.raf); s.raf = 0; }
    setDropPreview(null);
  }, []);

  useEffect(() => { resolveDropRef.current = resolveDrop; }, [resolveDrop]);
  useEffect(() => () => {
    const s = edgeScrollRef.current;
    if (s.raf) cancelAnimationFrame(s.raf);
  }, []);

  const handleWeekCreateEvent = useCallback((startSlot, endSlot, dateStr) => {
    onCreateEvent(startSlot, endSlot, dateStr);
  }, [onCreateEvent]);

  const handleDayCreateEvent = useCallback((startSlot, endSlot) => {
    onCreateEvent(startSlot, endSlot, formatDate(selectedDate));
  }, [onCreateEvent, selectedDate]);

  // —— 右键菜单：事件条给 copy / cut，空白槽位给 paste（剪贴板为空时置灰）——
  const closeMenu = useCallback(() => setMenu(null), []);

  const handleEventContextMenu = useCallback((event, x, y) => {
    if (readOnly) return; // 只读回放：copy/cut 会让用户以为能改数据
    setMenu({ kind: 'event', event: event, x: x, y: y });
  }, [readOnly]);

  const handleBlankContextMenu = useCallback((dateStr, slot, e) => {
    if (readOnly) return; // 只读回放：paste 入口同样关闭
    e.preventDefault();
    e.stopPropagation(); // 菜单自己挂在 document 上的 contextmenu 关闭监听，别把刚打开的菜单关掉
    setMenu({ kind: 'blank', dateStr: dateStr, slot: slot, x: e.clientX, y: e.clientY });
  }, [readOnly]);

  const cutId = clipboard && clipboard.mode === 'cut' ? clipboard.sourceId : null;

  // 落点预览复用 pasteRange / hasOverlap：与 App 真正的粘贴写入走完全同一套纯函数，不会"预览一套、落地另一套"
  const pastePreview = useMemo(() => {
    if (!menu || menu.kind !== 'blank' || !clipboard) return null;
    const range = pasteRange(clipboard, menu.slot, { min: timelineStart, max: timelineEnd });
    if (!range) return null;
    const blocker = hasOverlap(events, menu.dateStr, range.startSlot, range.endSlot, cutId);
    return {
      dateStr: menu.dateStr,
      name: clipboard.name,
      category: clipboard.category,
      startSlot: range.startSlot,
      endSlot: range.endSlot,
      conflict: !!blocker,
      hint: blocker
        ? tr('timeline.pasteConflict', { name: blocker.name, range: slotRangeLabel(blocker.startSlot, blocker.endSlot) })
        : tr('timeline.contextPaste') + ': ' + slotRangeLabel(range.startSlot, range.endSlot),
    };
  }, [menu, clipboard, cutId, events, timelineStart, timelineEnd, tr]);

  const menuItems = useMemo(() => {
    if (!menu) return [];
    if (menu.kind === 'event') {
      return [
        { key: 'copy', label: tr('timeline.contextCopy'), onSelect: () => onCopyEvent(menu.event) },
        { key: 'cut', label: tr('timeline.contextCut'), onSelect: () => onCutEvent(menu.event) },
      ];
    }
    const items = [{
      key: 'paste',
      label: tr('timeline.contextPaste'),
      disabled: !clipboard,
      onSelect: () => onPasteClipboard(menu.dateStr, menu.slot),
    }];
    if (clipboard) {
      items.push({ key: 'cancel', label: tr('common.cancel'), onSelect: onClearClipboard });
    }
    return items;
  }, [menu, clipboard, tr, onCopyEvent, onCutEvent, onPasteClipboard, onClearClipboard]);

  // 上下文一变（切日期 / 切日周视图 / 改视口）落点就失去意义：菜单与拖动预览一起作废
  useEffect(() => { setMenu(null); endDrop(); }, [selectedDate, viewMode, timelineStart, timelineEnd, endDrop]);

  const handleScroll = useCallback((e) => {
    if (headerInnerRef.current) {
      headerInnerRef.current.style.transform = 'translateX(' + (-e.currentTarget.scrollLeft) + 'px)';
    }
    setMenu(null); // 滚动后坐标与落点都失效，菜单跟着收起
  }, []);

  const timeLabels = [];
  for (let i = timelineStart; i < timelineEnd; i++) {
    const isHour = i % 6 === 0;
    timeLabels.push(
      <div key={i} style={timeLabelStyle}>
        {isHour ? <span style={timeLabelTextStyle}>{slotToTime(i)}</span> : null}
      </div>
    );
  }

  const headerDates = viewMode === 'week' ? weekDates : [selectedDate];
  const todayStr = formatDate(new Date());
  const selectedDateStr = formatDate(selectedDate);
  // 预览只下发给被右键的那一列，周视图不会串台
  const previewFor = (ds) => (pastePreview && pastePreview.dateStr === ds ? pastePreview : null);
  // 拖动预览只下发给目标列，其余列拿到引用不变的 null，配合 React.memo 才不会一帧重渲染整周
  const dropPreviewFor = (ds) => (dropPreview && dropPreview.dateStr === ds ? dropPreview : null);

  return (
    <div style={containerStyle}>
      <div style={toolbarStyle}>
        <div style={{ display: 'flex', gap: '4px', marginRight: '8px' }}>
          <button style={viewTabStyle(viewMode === 'day')} onClick={() => setViewMode('day')}>{tr('common.day')}</button>
          <button style={viewTabStyle(viewMode === 'week')} onClick={() => setViewMode('week')}>{tr('common.week')}</button>
        </div>
        <span style={{ color: 'var(--color-text-secondary)' }}>{tr('timeline.timeRange')}</span>
        <select style={selectStyle} value={timelineStart}
          onChange={e => { const v = Number(e.target.value); if (v < timelineEnd) onTimelineStartChange(v); }}>
          {TIME_OPTIONS.filter(o => o.value < timelineEnd).map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <span style={{ color: 'var(--color-text-secondary)' }}>{tr('timeline.to')}</span>
        <select style={selectStyle} value={timelineEnd}
          onChange={e => { const v = Number(e.target.value); if (v > timelineStart) onTimelineEndChange(v); }}>
          {TIME_OPTIONS.filter(o => o.value > timelineStart).map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <span style={{ marginLeft: 'auto', color: 'var(--color-text-secondary)', fontSize: '12px' }}>
          {slotToTime(timelineStart)} - {slotToTime(timelineEnd)}
        </span>
      </div>

      <div style={headerRowStyle}>
        <div style={cornerHeaderStyle}>{tr('timeline.time')}</div>
        <div style={headerClipStyle}>
          <div style={headerInnerStyle} ref={headerInnerRef}>
            {headerDates.map((d) => {
              const ds = formatDate(d);
              const isToday = ds === todayStr;
              const isDropTarget = !!dropPreview && dropPreview.dateStr === ds;
              return (
                <div key={ds} data-header-date={ds} style={isDropTarget
                  ? dropTargetHeaderStyle(dropPreview.valid)
                  : (isToday ? todayHeaderStyle : dayHeaderStyle)}>
                  {dayHeaderLabel(d, lang)}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div style={scrollAreaStyle} ref={scrollAreaRef} onScroll={handleScroll}>
        <div style={gridWrapperStyle}>
          <div style={weekGridStyle}>
            <div style={timeColumnStyle}>
              {timeLabels}
            </div>
            {viewMode === 'week' ? (
              weekDates.map((d) => {
                const ds = formatDate(d);
                return (
                  <DayColumn key={ds}
                    date={d}
                    events={weekEventsByDate[ds] || NO_EVENTS}
                    timelineStart={timelineStart}
                    timelineEnd={timelineEnd}
                    onCreateEvent={handleWeekCreateEvent}
                    onEditEvent={onEditEvent}
                    onMoveEvent={onMoveEvent}
                    cutId={cutId}
                    pastePreview={previewFor(ds)}
                    onEventContextMenu={handleEventContextMenu}
                    onBlankContextMenu={handleBlankContextMenu}
                    resolveDrop={resolveDrop}
                    endDrop={endDrop}
                    dropPreview={dropPreviewFor(ds)}
                    registerColumn={registerColumn}
                    onDropBlocked={onMoveBlocked}
                    readOnly={readOnly}
                  />
                );
              })
            ) : (
              <DayColumn
                date={selectedDate}
                events={dayEvents}
                timelineStart={timelineStart}
                timelineEnd={timelineEnd}
                onCreateEvent={handleDayCreateEvent}
                onEditEvent={onEditEvent}
                onMoveEvent={onMoveEvent}
                cutId={cutId}
                pastePreview={previewFor(selectedDateStr)}
                onEventContextMenu={handleEventContextMenu}
                onBlankContextMenu={handleBlankContextMenu}
                resolveDrop={resolveDrop}
                endDrop={endDrop}
                dropPreview={dropPreviewFor(selectedDateStr)}
                registerColumn={registerColumn}
                onDropBlocked={onMoveBlocked}
                readOnly={readOnly}
              />
            )}
          </div>
        </div>
      </div>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={closeMenu} />
      )}
    </div>
  );
}