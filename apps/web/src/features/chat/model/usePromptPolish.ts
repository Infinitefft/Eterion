import { useLayoutEffect, useRef, useState } from 'react';

import { getApiError } from '@/api/errors';
import { polishPrompt } from '@/api/prompt';
import { useAuthStore } from '@/store/auth-store';

type Revision = { original: string; polished: string; applied: boolean };

/** 只保存最近一次润色；普通输入不写入存储，不参与 IM 消息状态。 */
export function usePromptPolish(scope: string, prompt: string, setPrompt: (value: string) => void) {
  const userId = useAuthStore((state) => state.user?.id ?? null);
  const sessionVersion = useAuthStore((state) => state.sessionVersion);
  const key = userId ? `eterion:prompt-polish:${userId}:${scope}` : null;
  const [revision, setRevision] = useState<Revision | null>(null);
  const [isPolishing, setIsPolishing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const viewRef = useRef<object | null>(null);

  useLayoutEffect(() => {
    const view = {};
    viewRef.current = view;
    setRevision(null);
    setIsPolishing(false);
    setNotice(null);
    setPrompt('');
    if (key) {
      try {
        const raw = localStorage.getItem(key);
        const saved: unknown = raw ? JSON.parse(raw) : null;
        if (saved && typeof saved === 'object' && 'original' in saved && 'polished' in saved && 'applied' in saved
          && typeof saved.original === 'string' && typeof saved.polished === 'string' && typeof saved.applied === 'boolean'
          && saved.original.length <= 16000 && saved.polished.length <= 16000) {
          const restored = { original: saved.original, polished: saved.polished, applied: saved.applied };
          setRevision(restored);
          setPrompt(restored.applied ? restored.polished : restored.original);
        }
      } catch {
        setNotice('本地记录暂不可用，本次仍可润色和撤销');
      }
    }
    return () => {
      viewRef.current = null;
      requestRef.current?.abort();
      requestRef.current = null;
    };
  }, [key, sessionVersion, setPrompt]);

  function save(next: Revision | null) {
    setRevision(next);
    if (!key) return;
    try {
      if (next) localStorage.setItem(key, JSON.stringify(next));
      else localStorage.removeItem(key);
    } catch {
      setNotice('本地保存失败，当前页面仍可撤销；刷新后记录可能丢失');
    }
  }

  function clear() {
    setNotice(null);
    save(null);
  }

  function edit(value: string) {
    if (requestRef.current) return;
    setPrompt(value);
    setNotice(null);
    if (revision) save(null);
  }

  async function polish() {
    if (requestRef.current || !userId || !prompt.trim()) return;
    if (prompt.trim().length > 8000) {
      setNotice('提示词超过 8000 字符，请缩短后再润色');
      return;
    }
    const original = prompt;
    const view = viewRef.current;
    const controller = new AbortController();
    requestRef.current = controller;
    setIsPolishing(true);
    setNotice(null);
    const isCurrent = () => view !== null && viewRef.current === view && !controller.signal.aborted
      && useAuthStore.getState().sessionVersion === sessionVersion;
    try {
      // 请求前保存原文，失败或刷新也不会丢掉输入。
      save({ original, polished: original, applied: false });
      const polished = await polishPrompt(original, controller.signal);
      if (!isCurrent()) return;
      if (polished.trim() === original.trim()) {
        setNotice('无需润色');
        return;
      }
      save({ original, polished, applied: true });
      setPrompt(polished);
    } catch (error) {
      if (isCurrent()) {
        setNotice(getApiError(error)?.message ?? '润色未完成，原文已保留，请重试');
      }
    } finally {
      if (isCurrent()) {
        requestRef.current = null;
        setIsPolishing(false);
      }
    }
  }

  function toggle() {
    if (!revision || requestRef.current) return;
    const next = { ...revision, applied: !revision.applied };
    save(next);
    setPrompt(next.applied ? next.polished : next.original);
  }

  return { isPolishing, isPending: () => requestRef.current !== null, notice,
    revision: revision && revision.original !== revision.polished ? revision : null, edit, polish, toggle, clear };
}
