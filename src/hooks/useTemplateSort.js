import { useSyncExternalStore } from 'react';
import { DIRECTIONS, SORT_KEYS, defaultDirectionFor } from '../utils/templateSort.js';

// 排序偏好是本机 UI 偏好，和语言偏好一样存 localStorage，不进 data.json
export const TEMPLATE_SORT_STORAGE_KEY = 'event-logger:template-sort';
const FALLBACK = { sort: 'default', direction: 'asc' };

function isValidSort(value) {
  return SORT_KEYS.indexOf(value) !== -1;
}

function isValidDirection(value) {
  return DIRECTIONS.indexOf(value) !== -1;
}

function sanitize(candidate) {
  const sort = isValidSort(candidate.sort) ? candidate.sort : FALLBACK.sort;
  if (sort === 'default') return { sort, direction: 'asc' };
  const direction = isValidDirection(candidate.direction) ? candidate.direction : defaultDirectionFor(sort);
  return { sort, direction };
}

function parse(raw) {
  if (!raw) return FALLBACK;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return FALLBACK;
    return sanitize({ sort: parsed.sort, direction: parsed.direction });
  } catch (err) {
    return FALLBACK;
  }
}

function readStored() {
  try {
    return parse(window.localStorage.getItem(TEMPLATE_SORT_STORAGE_KEY));
  } catch (err) {
    return FALLBACK;
  }
}

function writeStored(next) {
  try {
    window.localStorage.setItem(TEMPLATE_SORT_STORAGE_KEY, JSON.stringify(next));
  } catch (err) {
    // 隐私模式或存储被禁用时忽略，内存中的偏好仍然生效
  }
}

// 模块级 store：两个弹窗共享同一份偏好，无需把 props 从 App 一路传下去
let state = null;
const listeners = new Set();

function emit() {
  listeners.forEach(function (notify) { notify(); });
}

export function getTemplateSort() {
  if (!state) state = typeof window === 'undefined' ? FALLBACK : readStored();
  return state;
}

function update(makeNext) {
  const current = getTemplateSort();
  const next = sanitize(makeNext(current));
  if (next.sort === current.sort && next.direction === current.direction) return;
  state = next;
  writeStored(next);
  emit();
}

// 点当前字段不产生任何变化；切换字段时把方向重置为该字段的自然方向
export function setTemplateSortField(sort) {
  update(function (current) {
    if (!isValidSort(sort) || current.sort === sort) return current;
    return { sort, direction: defaultDirectionFor(sort) };
  });
}

export function toggleTemplateSortDirection() {
  update(function (current) {
    if (current.sort === 'default') return current;
    return { sort: current.sort, direction: current.direction === 'asc' ? 'desc' : 'asc' };
  });
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', function (event) {
    if (event.key !== null && event.key !== TEMPLATE_SORT_STORAGE_KEY) return;
    // 其它标签页改了偏好：丢弃缓存，下次读取重新解析
    state = null;
    emit();
  });
}

function subscribe(notify) {
  listeners.add(notify);
  return function () {
    listeners.delete(notify);
  };
}

export function useTemplateSort() {
  const snapshot = useSyncExternalStore(subscribe, getTemplateSort, getTemplateSort);
  return {
    sort: snapshot.sort,
    direction: snapshot.direction,
    setSort: setTemplateSortField,
    toggleDirection: toggleTemplateSortDirection,
  };
}
