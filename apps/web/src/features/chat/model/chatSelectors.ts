import type { RunId, RunStatus, ThreadId } from '@/service/im/types';
import type { IMStore } from '@/store/imStore';

/** PendingAssistant 使用的稳定占位值，不会与 UUID 格式的 RunId 冲突。 */
export const PENDING_ASSISTANT_WAITING_FOR_RUN = '__waiting_for_agent_run__';

const ACTIVE_RUN_STATUSES = new Set<RunStatus>(['pending', 'running', 'waiting_user']);

export function isRunActive(status: RunStatus): boolean {
  return ACTIVE_RUN_STATUSES.has(status);
}

/** 查找当前 Thread 最近一个尚未进入终态的 Run。 */
export function selectActiveRunId(state: IMStore, threadId: ThreadId): RunId | null {
  const runs = state.detailsByThread[threadId]?.runs;

  if (!runs) return null;

  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index];

    if (isRunActive(run.status)) {
      return run.id;
    }
  }

  return null;
}

/**
 * 用户消息正在发送、或它关联的 Run 仍未进入终态时，当前 Thread 视为忙碌。
 */
export function selectIsChatBusy(state: IMStore, threadId: ThreadId): boolean {
  if (selectActiveRunId(state, threadId)) return true;

  const detail = state.detailsByThread[threadId];
  const latestMessage = detail?.messages[detail.messages.length - 1];

  if (!detail || !latestMessage) return false;

  if (latestMessage.status === 'sending' || latestMessage.status === 'streaming') {
    return true;
  }

  if (latestMessage.role !== 'user' || latestMessage.status !== 'completed') {
    return false;
  }

  const matchingRun = detail.runs.find((run) => run.inputMessageId === latestMessage.id);

  return matchingRun ? isRunActive(matchingRun.status) : true;
}

/** 决定是否需要在用户消息后展示等待 Agent 的临时 Assistant 区域。 */
export function selectPendingAssistantKey(state: IMStore, threadId: ThreadId): string | null {
  const detail = state.detailsByThread[threadId];
  const latestMessage = detail?.messages[detail.messages.length - 1];

  if (!detail || !latestMessage || latestMessage.role !== 'user') return null;

  if (latestMessage.status !== 'sending' && latestMessage.status !== 'completed') {
    return null;
  }

  for (let index = detail.runs.length - 1; index >= 0; index -= 1) {
    const run = detail.runs[index];

    if (run.inputMessageId !== latestMessage.id) continue;

    const hasOutputMessage = detail.messages.some((message) => message.id === run.outputMessageId);

    return hasOutputMessage ? null : run.id;
  }

  return PENDING_ASSISTANT_WAITING_FOR_RUN;
}
