import { useState, useEffect, useCallback, useRef } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { normalizeTemplate, stampNewTemplate, stampUpdatedTemplate } from '../utils/templates.js';

export function useTemplates(externalTemplates, onTemplatesChange) {
  const [templates, setTemplates] = useState(() => (externalTemplates || []).map(normalizeTemplate));
  const initialized = useRef(false);

  useEffect(() => {
    if (externalTemplates && !initialized.current) {
      setTemplates(externalTemplates.map(normalizeTemplate));
      initialized.current = true;
    }
  }, [externalTemplates]);

  useEffect(() => {
    if (initialized.current && onTemplatesChange) {
      onTemplatesChange(templates);
    }
  }, [templates, onTemplatesChange]);

  // timestamps 仅用于导入合并时沿用原创建 / 修改时间，正常新增走当前时间
  const addTemplate = useCallback((name, category, timestamps) => {
    const exists = templates.find(t => t.name === name && t.category === category);
    if (exists) return exists;
    const newTemplate = { id: uuidv4(), ...stampNewTemplate(name, category, timestamps) };
    setTemplates(prev => [...prev, newTemplate]);
    return newTemplate;
  }, [templates]);

  // 只有名称 / 类别真的变化才刷新 updatedAt，且 updates 无法覆盖时间戳
  const updateTemplate = useCallback((id, updates) => {
    setTemplates(prev => prev.map(t => (t.id === id ? stampUpdatedTemplate(t, updates) : t)));
  }, []);

  const deleteTemplate = useCallback((id) => {
    setTemplates(prev => prev.filter(t => t.id !== id));
  }, []);

  const importTemplates = useCallback((newTemplates) => {
    setTemplates((newTemplates || []).map(normalizeTemplate));
  }, []);

  return { templates, addTemplate, updateTemplate, deleteTemplate, importTemplates };
}
