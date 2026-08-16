import type { IMStore } from '@/service/im/store';
import type {
  AgentRunStatus,
  ChatId,
  MessageId,
  RunId,
} from '@/service/im/types';

const EMPTY_MESSAGE_IDS: MessageId[] = [];
const EMPTY_RUN_IDS: RunId[] = [];

/** PendingAssistant 使用的稳定占位值，不会与 UUID 格式的 RunId 冲突。 */
export const PENDING_ASSISTANT_WAITING_FOR_RUN = '__waiting_for_agent_run__';

const ACTIVE_RUN_STATUSES = new Set<AgentRunStatus>([
  'created',
  'queued',
  'running',
  'calling_tool',
  'calling_skill',
  'retrieving',
  'streaming',
  'waiting_user',
]);

export function isRunActive(status: AgentRunStatus): boolean {
  return ACTIVE_RUN_STATUSES.has(status);
}

/** 查找当前会话最近一个尚未进入终态的 Agent Run。 */
export function selectActiveRunId(
  state: IMStore,
  chatId: ChatId,
): RunId | null {
  const runIds = state.runIdsByChatId[chatId] ?? EMPTY_RUN_IDS;

  for (let index = runIds.length - 1; index >= 0; index -= 1) {
    const runId = runIds[index];
    const run = runId ? state.runsById[runId] : undefined;

    if (run && isRunActive(run.status)) {
      return run.id;
    }
  }

  return null;
}

/**
 * 用户消息已发送、但 run.created 尚未到达的阶段也视为忙碌，
 * 防止连续按 Enter 意外创建多个并行 Run。
 */
export function selectIsChatBusy(state: IMStore, chatId: ChatId): boolean {
  if (selectActiveRunId(state, chatId)) return true;

  const messageIds = state.messageIdsByChatId[chatId] ?? EMPTY_MESSAGE_IDS;
  const latestMessageId = messageIds[messageIds.length - 1];
  const latestMessage = latestMessageId
    ? state.messagesById[latestMessageId]
    : undefined;

  if (!latestMessage) return false;

  if (latestMessage.status === 'pending' || latestMessage.status === 'streaming') {
    return true;
  }

  if (latestMessage.role !== 'user' || latestMessage.status !== 'completed') {
    return false;
  }

  const runIds = state.runIdsByChatId[chatId] ?? EMPTY_RUN_IDS;

  for (let index = runIds.length - 1; index >= 0; index -= 1) {
    const runId = runIds[index];
    const run = runId ? state.runsById[runId] : undefined;

    if (run?.inputMessageId === latestMessage.id) {
      return isRunActive(run.status);
    }
  }

  return true;
}

/** 决定是否需要在用户消息后展示等待 Agent 的临时 Assistant 区域。 */
export function selectPendingAssistantKey(
  state: IMStore,
  chatId: ChatId,
): string | null {
  const messageIds = state.messageIdsByChatId[chatId] ?? EMPTY_MESSAGE_IDS;
  const latestMessageId = messageIds[messageIds.length - 1];
  const latestMessage = latestMessageId
    ? state.messagesById[latestMessageId]
    : undefined;

  if (!latestMessage || latestMessage.role !== 'user') return null;

  if (
    latestMessage.status !== 'pending' &&
    latestMessage.status !== 'completed'
  ) {
    return null;
  }

  const runIds = state.runIdsByChatId[chatId] ?? EMPTY_RUN_IDS;

  for (let index = runIds.length - 1; index >= 0; index -= 1) {
    const runId = runIds[index];
    const run = runId ? state.runsById[runId] : undefined;

    if (!run || run.inputMessageId !== latestMessage.id) continue;

    return state.messagesById[run.outputMessageId] ? null : run.id;
  }

  return PENDING_ASSISTANT_WAITING_FOR_RUN;
}
