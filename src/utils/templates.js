// 模板时间戳工具：纯函数、无 React 依赖，便于 scripts/check-template-sort.mjs 直接校验
// 约定：createdAt / updatedAt 均为 ISO 8601 字符串（UTC），由 new Date().toISOString() 生成
// 存量模板没有的时间戳不做补写，保持"未知时间"语义（排序时垫底）

export function nowIso() {
  return new Date().toISOString();
}

// 只有可解析的非空字符串才算有效时间，避免脏数据把排序带偏
export function isValidIso(value) {
  return typeof value === 'string' && value.trim() !== '' && Number.isFinite(Date.parse(value));
}

// 模板的修改时间（毫秒）；缺失或非法返回 null，语义是"未知时间"
export function getUpdatedTime(template) {
  if (!template || !isValidIso(template.updatedAt)) return null;
  return Date.parse(template.updatedAt);
}

// 加载 / 导入时清洗：保留合法时间戳，丢弃非法值
export function normalizeTemplate(template) {
  if (!template || typeof template !== 'object') return template;
  const next = { ...template };
  if (!isValidIso(next.createdAt)) delete next.createdAt;
  if (!isValidIso(next.updatedAt)) delete next.updatedAt;
  return next;
}

// 新建模板的时间戳；带入参时间戳时（导入合并）沿用原值，否则用当前时间
export function stampNewTemplate(name, category, timestamps) {
  const iso = nowIso();
  const createdAt = timestamps && isValidIso(timestamps.createdAt) ? timestamps.createdAt : iso;
  const updatedAt = timestamps && isValidIso(timestamps.updatedAt) ? timestamps.updatedAt : createdAt;
  return { name, category, createdAt, updatedAt };
}

// 只有 name / category 真的变化时才刷新 updatedAt；调用方无法借 updates 伪造时间戳
export function stampUpdatedTemplate(prev, updates, iso) {
  const base = prev || {};
  const safeUpdates = { ...updates };
  delete safeUpdates.createdAt;
  delete safeUpdates.updatedAt;
  const nameChanged = safeUpdates.name !== undefined && safeUpdates.name !== base.name;
  const categoryChanged = safeUpdates.category !== undefined && safeUpdates.category !== base.category;
  const next = { ...base, ...safeUpdates };
  if (nameChanged || categoryChanged) next.updatedAt = iso || nowIso();
  if (!isValidIso(next.createdAt)) delete next.createdAt;
  if (!isValidIso(next.updatedAt)) delete next.updatedAt;
  return next;
}
