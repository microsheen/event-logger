import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import {
  LANGS,
  htmlLang,
  isValidLang,
  resolveInitialLang,
  translate,
  writeStoredLang,
} from './core.js';

const I18nContext = createContext(null);

// 界面语言现在由「当前 EventBook」决定：lang / onLanguageChange 受控于 App。
// 没有 book（首启引导页）时退化为内部 state，值来自 localStorage 缓存或浏览器语言。
export function I18nProvider({ lang, onLanguageChange, children }) {
  const [innerLang, setInnerLang] = useState(() => resolveInitialLang(null).lang);
  const current = isValidLang(lang) ? lang : innerLang;

  React.useEffect(() => {
    writeStoredLang(current);
    document.documentElement.lang = htmlLang(current);
    document.title = translate(current, 'app.title');
  }, [current]);

  const setLanguage = useCallback((next) => {
    if (!isValidLang(next)) return;
    setInnerLang(next);
    if (onLanguageChange) onLanguageChange(next);
  }, [onLanguageChange]);

  const tr = useCallback((key, params) => translate(current, key, params), [current]);

  const value = useMemo(() => ({
    lang: current,
    langs: LANGS,
    tr,
    setLanguage,
  }), [current, tr, setLanguage]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used inside I18nProvider');
  return ctx;
}

export { LANGS };