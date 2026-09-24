import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './styles/global.css';

// 语言由「当前 EventBook」决定，所以 I18nProvider 搬到 App 内部（App 先读到 book 才知道语言）。
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
