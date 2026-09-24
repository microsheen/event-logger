import { useCallback, useEffect, useRef, useState } from 'react';

const TOAST_DURATION_MS = 2500;

// 轻提示的持有者：只存一条消息，后到的覆盖前到的并重置计时
// 刻意不持久化（和剪贴板一样是瞬时 UI 态），也不进 data.json
export function useToast() {
  const [toast, setToast] = useState(null);
  const timerRef = useRef(null);

  const dismiss = useCallback(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    setToast(null);
  }, []);

  const showToast = useCallback((text, tone) => {
    if (!text) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    setToast({ text: text, tone: tone === 'error' ? 'error' : 'info', at: Date.now() });
    timerRef.current = setTimeout(dismiss, TOAST_DURATION_MS);
  }, [dismiss]);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  return { toast, showToast, dismissToast: dismiss };
}
