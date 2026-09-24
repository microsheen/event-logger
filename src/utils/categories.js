export const CATEGORIES = [
  { key: 'work', icon: '💼', hex: '#4a90d9', color: 'var(--color-work)', light: 'var(--color-work-light)', hover: 'var(--color-work-hover)' },
  { key: 'life', icon: '🏠', hex: '#27ae60', color: 'var(--color-life)', light: 'var(--color-life-light)', hover: 'var(--color-life-hover)' },
  { key: 'study', icon: '📚', hex: '#f39c12', color: 'var(--color-study)', light: 'var(--color-study-light)', hover: 'var(--color-study-hover)' },
];

export function getCategory(key) {
  return CATEGORIES.find(c => c.key === key) || CATEGORIES[0];
}