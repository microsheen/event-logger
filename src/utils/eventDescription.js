// 事件描述（description）的规则层：纯函数、无 React 依赖，便于 scripts/check-event-desc.mjs 直接在 Node 里断言
// 约定：描述恒为字符串（旧事件没有该键 → 读作空串）；上限 500 字符；换行只由 UI 的多行输入产生，存储不做折叠
export const MAX_EVENT_DESC = 500;

// 归一顺序固定：先换行符归一 + 剥离控制字符（留着脏字符就没法算准长度），再截断到上限，最后修剪首尾空白。
// 三步都幂等，因此 normalize(normalize(x)) === normalize(x)：重复过一遍管线不会越改越短
export function normalizeEventDescription(raw) {
  if (typeof raw !== 'string') return '';
  const text = raw
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  const clipped = text.length > MAX_EVENT_DESC ? text.slice(0, MAX_EVENT_DESC) : text;
  return clipped.replace(/^[\s\uFEFF]+|[\s\uFEFF]+$/g, '');
}

// 读取侧统一入口：渲染或比较描述一律先过归一，脏数据不会把 tooltip 撑坏
export function eventDescription(event) {
  return normalizeEventDescription(event && event.description);
}
