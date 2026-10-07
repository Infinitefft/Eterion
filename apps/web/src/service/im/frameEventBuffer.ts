import type { ServerThreadEvent } from './protocol';

/** 协议层已验证顺序；这里只合并 Store 提交，不延迟边界事件或模拟打字。 */
export function createFrameEventBuffer(apply: (events: ServerThreadEvent[]) => void) {
  let pending: ServerThreadEvent[] = [];
  let frame: number | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;

  function clear() {
    if (frame !== null) cancelAnimationFrame(frame);
    if (timeout !== null) clearTimeout(timeout);
    frame = null;
    timeout = null;
    pending = [];
  }

  function flush() {
    const events = pending;
    clear();
    if (events.length > 0) apply(events);
  }

  function enqueue(event: ServerThreadEvent) {
    pending.push(event);
    if (
      (event.type !== 'message.delta' && event.type !== 'thinking.delta') ||
      pending.length >= 256 || typeof requestAnimationFrame !== 'function'
    ) {
      flush();
      return;
    }
    if (frame === null) {
      frame = requestAnimationFrame(flush);
      // 后台标签页可能暂停 rAF，仍定期提交，避免恢复时积压大量文本。
      timeout = setTimeout(flush, 100);
    }
  }

  return { enqueue, flush, clear };
}
