// 模板排序引擎：纯函数，只影响显示顺序，绝不改动存储数组顺序
import { localeTag } from '../i18n/core.js';
import { getCategory } from './categories.js';
import { getUpdatedTime } from './templates.js';

export const SORT_KEYS = ['default', 'name', 'category', 'updated'];
export const DIRECTIONS = ['asc', 'desc'];

// 每个排序字段的自然方向：时间类默认"新的在前"
const DEFAULT_DIRECTION = { default: 'asc', name: 'asc', category: 'asc', updated: 'desc' };

export function defaultDirectionFor(sort) {
  return DEFAULT_DIRECTION[sort] || 'asc';
}

const collatorCache = {};

// zh-CN 按拼音、ja-JP 按五十音、en-US 按字母；sensitivity base 忽略大小写，numeric 让 task2 排在 task10 前
function getCollator(lang) {
  const tag = localeTag(lang);
  if (!collatorCache[tag]) collatorCache[tag] = new Intl.Collator(tag, { sensitivity: 'base', numeric: true });
  return collatorCache[tag];
}

function fallbackLabel(key) {
  return key;
}

function compareByField(field, a, b, collator, categoryLabel) {
  if (field === 'name') {
    const byName = collator.compare(a.template.name, b.template.name);
    if (byName !== 0) return byName;
    return collator.compare(categoryLabel(getCategory(a.template.category).key), categoryLabel(getCategory(b.template.category).key));
  }
  if (field === 'category') {
    const byCategory = collator.compare(categoryLabel(getCategory(a.template.category).key), categoryLabel(getCategory(b.template.category).key));
    if (byCategory !== 0) return byCategory;
    return collator.compare(a.template.name, b.template.name);
  }
  return 0;
}

// sortTemplates(templates, { sort, direction, lang, categoryLabel }) -> 新数组
// direction 只作用于业务比较；最后的插入序号一律升序且不随方向反转，
// 于是同一字段下相同项永不抖动，升序 / 降序互为严格逆序。
export function sortTemplates(templates, options) {
  const opts = options || {};
  const field = SORT_KEYS.indexOf(opts.sort) !== -1 ? opts.sort : 'default';
  const list = Array.isArray(templates) ? templates : [];
  const items = list.map((template, index) => ({ template, index }));
  if (field === 'default' || list.length < 2) return items.map(entry => entry.template);

  const sign = opts.direction === 'desc' ? -1 : 1;
  const collator = getCollator(opts.lang);
  const categoryLabel = typeof opts.categoryLabel === 'function' ? opts.categoryLabel : fallbackLabel;

  function compareEntries(a, b) {
    if (field === 'updated') {
      const timeA = getUpdatedTime(a.template);
      const timeB = getUpdatedTime(b.template);
      // 未知时间永远垫底，不冒充"最新"，因此不参与 sign 反转
      if (timeA === null && timeB === null) return a.index - b.index;
      if (timeA === null) return 1;
      if (timeB === null) return -1;
      if (timeA !== timeB) return sign * (timeA - timeB);
      return a.index - b.index;
    }
    const business = compareByField(field, a, b, collator, categoryLabel);
    if (business !== 0) return sign * business;
    return a.index - b.index;
  }

  return items.sort(compareEntries).map(entry => entry.template);
}
