import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import { BUILD_ID } from './buildInfo.js';
import './styles/global.css';

// 构建号挂到 <html data-build>：Service Worker 的「旧壳」会让页面看起来还在跑旧代码，
// 出问题时先看这个值，再决定是怀疑修复还是怀疑缓存。
document.documentElement.dataset.build = BUILD_ID;

// 语言由「当前 EventBook」决定，所以 I18nProvider 搬到 App 内部（App 先读到 book 才知道语言）。
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
