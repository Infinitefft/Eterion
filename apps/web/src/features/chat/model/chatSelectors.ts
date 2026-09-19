import type {
  AgentBlockState,
  MessageId,
  MessageState,
  RunId,
  RunState,
  RunStatus,
  ThreadId,
} from '@/service/im/types';
import type { IMStore } from '@/store/im-store';

const ACTIVE_RUN_STATUSES = new Set<RunStatus>(['pending', 'running', 'waiting_user']);

type AssistantContentPart =
  | { kind: 'text'; key: string; content: string }
  | { kind: 'blocks'; key: string; blocks: AgentBlockState[] };

/** 正文只在工具开始的位置分段；同一位置的过程块仍使用原来的列表展示。 */
export function getAssistantContentParts(
  content: string,
  blocks: readonly AgentBlockState[],
): AssistantContentPart[] {
  const blocksByOffset = new Map<number, AgentBlockState[]>();
  for (const block of blocks) {
    const position = block.kind === 'tool' ? block.contentOffset : undefined;
    const offset = position !== undefined && Number.isInteger(position) && position >= 0
      ? Math.min(position, content.length)
      : 0;
    const group = blocksByOffset.get(offset);
    if (group) {
      group.push(block);
    } else {
      blocksByOffset.set(offset, [block]);
    }
  }

  const parts: AssistantContentPart[] = [];
  let cursor = 0;
  let textKey = 'start';
  for (const [offset, group] of [...blocksByOffset].sort(([left], [right]) => left - right)) {
    if (offset > cursor) {
      parts.push({ kind: 'text', key: textKey, content: content.slice(cursor, offset) });
    }
    const key = `${group[0].kind}:${group[0].id}`;
    parts.push({ kind: 'blocks', key, blocks: group });
    cursor = offset;
    textKey = key;
  }
  if (cursor < content.length) {
    parts.push({ kind: 'text', key: textKey, content: content.slice(cursor) });
  }
  return parts;
}

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

/** 当前会话各用户消息后的过程区域；值为 null 表示正在等待 Run，缺少 key 表示不展示。 */
export function getAssistantPlaceholders(
  messages: readonly MessageState[],
  runs: readonly RunState[],
  blocks: readonly AgentBlockState[],
): Map<MessageId, RunId | null> {
  const userMessageIds = new Set(
    messages.filter((message) => message.role === 'user').map((message) => message.id),
  );
  const outputMessageIds = new Set(
    messages.filter((message) => message.role === 'assistant').map((message) => message.id),
  );
  const runsByInput = new Map(runs.map((run) => [run.inputMessageId, run]));
  const runsWithBlocks = new Set(blocks.map((block) => block.runId));
  const placeholders = new Map<MessageId, RunId | null>();

  for (const [inputMessageId, run] of runsByInput) {
    if (!userMessageIds.has(inputMessageId) || outputMessageIds.has(run.outputMessageId)) {
      continue;
    }
    // 已完成且没有正文或过程的 Run 不应留下只有头像的空区域。
    if (run.status === 'completed' && !runsWithBlocks.has(run.id)) {
      continue;
    }
    placeholders.set(inputMessageId, run.id);
  }

  const latestMessage = messages.at(-1);
  if (
    latestMessage?.role === 'user' &&
    ['sending', 'completed'].includes(latestMessage.status) &&
    !runsByInput.has(latestMessage.id)
  ) {
    placeholders.set(latestMessage.id, null);
  }

  return placeholders;
}
