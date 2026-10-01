import { z } from 'zod';
import { runInputSchema, type RunInput, type RunRequest } from '../protocol.js';
import { HumanMessage, AIMessage, type BaseMessage } from '@langchain/core/messages';
import { attachSessionStart, restoreContext } from './messages.js';

const historyPageSchema = z.object({
  session_started_at: z.number().int().nonnegative().optional(),
  input_message_created_at: z.number().int().nonnegative().max(8.64e15).optional(),
  messages: z.array(z.object({
    id: z.string().uuid(),
    role: z.enum(['user', 'assistant', 'system']),
    status: z.enum(['pending', 'streaming', 'completed', 'failed', 'cancelled']),
    content: z.string(),
  })),
  next_cursor: z.string().uuid().nullable(),
  agent_context: z.unknown().optional(),
});

/**
 * 恢复最近一份运行上下文，再按原有状态规则追加新的历史消息。
 * Go 返回业务数据；消息转换和是否进入模型由 Agent 决定。
 */
export async function buildRunInput(
  request: RunRequest,
  apiBaseUrl: string,
  externalSignal: AbortSignal,
): Promise<RunInput> {
  if ('messages' in request) return request;

  // 限制整个历史加载阶段，同时响应 Go 取消；失败不能静默降级为无历史回答。
  const signal = AbortSignal.any([externalSignal, AbortSignal.timeout(30_000)]);
  const messages: RunInput['messages'] = [];
  const contextMessages: BaseMessage[] = [];
  let cursor: string | null = null;
  let lastMessageId: string | undefined;
  const cursors = new Set<string>();
  let needsSessionStart = true;
  let inputMessageCreatedAt: number | undefined;
  do {
    const url = new URL(`/internal/agent/runs/${request.run_id}/messages`, apiBaseUrl);
    if (cursor) url.searchParams.set('after', cursor);
    else url.searchParams.set('context', '1');
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${request.history_token}` },
      // 凭证只交给已配置的 Go 服务，不跟随跳转。
      redirect: 'error',
      signal,
    });
    if (!response.ok) throw new Error('Conversation history request failed');
    const page = historyPageSchema.parse(await response.json());
    if (!cursor) inputMessageCreatedAt = page.input_message_created_at;
    if (!cursor && page.agent_context != null) {
      contextMessages.push(...restoreContext(page.agent_context));
      // 已保存的上下文保持原样，包括压缩后的摘要，不能给增量消息再次加时间。
      needsSessionStart = false;
    }
    for (const message of page.messages) {
      if (message.status !== 'completed' || !message.content || message.role === 'system') continue;
      messages.push({ role: message.role, content: message.content });
      const contextMessage = message.role === 'user'
        ? new HumanMessage({ content: message.content, id: message.id })
        : new AIMessage({ content: message.content, id: message.id });
      if (needsSessionStart && message.role === 'user') {
        if (page.session_started_at !== undefined) attachSessionStart(contextMessage, page.session_started_at);
        needsSessionStart = false;
      }
      contextMessages.push(contextMessage);
      lastMessageId = message.id;
    }
    cursor = page.next_cursor;
    if (cursor) {
      if (cursors.has(cursor)) throw new Error('Conversation history cursor repeated');
      cursors.add(cursor);
    }
  } while (cursor);

  // 本轮输入已包含在有界历史里，不能再追加一次，也不能接受缺少本轮输入的快照。
  if (lastMessageId !== request.input_message_id) throw new Error('Conversation history input mismatch');
  return { ...runInputSchema.parse({
    run_id: request.run_id, user_id: request.user_id,
    thread_id: request.thread_id, model_id: request.model_id, messages,
    ...(inputMessageCreatedAt === undefined ? {} : { input_message_created_at: inputMessageCreatedAt }),
  }), contextMessages };
}
