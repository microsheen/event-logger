// 构建号的唯一出口。__BUILD_ID__ 由 vite.config.js 的 define 在构建时替换成实际字符串。
// typeof 兜底：万一哪天 define 丢了（或这个文件被 node 脚本直接 import），拿到的是 unknown，
// 而不是 ReferenceError 白屏 —— 白屏时最难查，因为看起来像数据坏了。
export const BUILD_ID = typeof __BUILD_ID__ === 'string' && __BUILD_ID__ ? __BUILD_ID__ : 'unknown';
