import { useState, useEffect, useCallback, useRef } from 'react';
import { v4 as uuidv4 } from 'uuid';

export function useEvents(externalEvents, onEventsChange) {
  const [events, setEvents] = useState(externalEvents || []);
  const initialized = useRef(false);

  useEffect(() => {
    if (externalEvents && !initialized.current) {
      // 确保所有事件都有 ID（修复旧数据中缺少 id 的问题）
      const withIds = externalEvents.map(e => e.id ? e : { ...e, id: uuidv4() });
      setEvents(withIds);
      initialized.current = true;
    }
  }, [externalEvents]);

  useEffect(() => {
    if (initialized.current && onEventsChange) {
      onEventsChange(events);
    }
  }, [events, onEventsChange]);

  const addEvent = useCallback((eventData) => {
    // id 放在展开运算符之后，确保始终生成新的 UUID
    const newEvent = { ...eventData, id: uuidv4() };
    setEvents(prev => [...prev, newEvent]);
    return newEvent;
  }, []);

  const updateEvent = useCallback((id, updates) => {
    setEvents(prev => prev.map(e => e.id === id ? { ...e, ...updates } : e));
  }, []);

  const deleteEvent = useCallback((id) => {
    if (!id) return; // 防止无效 id 导致误删
    setEvents(prev => prev.filter(e => e.id !== id));
  }, []);

  const getEventsForDate = useCallback((dateStr) => {
    return events.filter(e => e.date === dateStr);
  }, [events]);

  const getDateSet = useCallback(() => {
    return new Set(events.map(e => e.date));
  }, [events]);

  const importEvents = useCallback((newEvents) => {
    setEvents(newEvents);
  }, []);

  return { events, addEvent, updateEvent, deleteEvent, getEventsForDate, getDateSet, importEvents };
}
