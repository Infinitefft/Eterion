import { z } from 'zod';
import { runInputSchema, type RunInput, type RunRequest } from './protocol.js';

const historyPageSchema = z.object({
  messages: z.array(z.object({
    id: z.string().uuid(),
    role: z.enum(['user', 'assistant', 'system']),
    status: z.enum(['pending', 'streaming', 'completed', 'failed', 'cancelled']),
    content: z.string(),
  })),
  next_cursor: z.string().uuid().nullable(),
});

/**
 * 当前只迁移原有历史选择规则，不做摘要或长期记忆。
 * Go 返回原始消息；哪些内容进入模型，由 Agent 在这里决定。
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
  let cursor: string | null = null;
  let lastMessageId: string | undefined;
  const cursors = new Set<string>();
  do {
    const url = new URL(`/internal/agent/runs/${request.run_id}/messages`, apiBaseUrl);
    if (cursor) url.searchParams.set('after', cursor);
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${request.history_token}` },
      // 凭证只交给已配置的 Go 服务，不跟随跳转。
      redirect: 'error',
      signal,
    });
    if (!response.ok) throw new Error('Conversation history request failed');
    const page = historyPageSchema.parse(await response.json());
    for (const message of page.messages) {
      if (message.status !== 'completed' || !message.content || message.role === 'system') continue;
      messages.push({ role: message.role, content: message.content });
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
  return runInputSchema.parse({
    run_id: request.run_id, user_id: request.user_id,
    thread_id: request.thread_id, model_id: request.model_id, messages,
  });
}
