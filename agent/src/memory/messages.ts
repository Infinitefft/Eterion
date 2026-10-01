import {
  type BaseMessage,
  type StoredMessage,
  mapChatMessagesToStoredMessages,
  mapStoredMessagesToChatMessages,
} from '@langchain/core/messages';
import { z } from 'zod';

// 仅修改模型消息；固定会话时间随上下文持久化，压缩时通过元数据准确保留。
export function attachSessionStart(message: BaseMessage, startedAt: number): void {
  if (typeof message.content !== 'string') throw new Error('Session start requires a text message');
  const localTime = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(new Date(startedAt)).replace(' ', 'T');
  message.content = `[会话开始时间：${localTime}+08:00]\n[时区：Asia/Shanghai；此时间固定，不代表每轮对话的当前时间]\n\n${message.content}`;
  message.additional_kwargs.session_started_at = startedAt;
}

// 内容块由模型提供，保留图片等扩展字段，只检查基本结构和文本块正文。
const contentBlockSchema = z.looseObject({
  type: z.string().min(1),
}).refine(
  (block) => block.type !== 'text' || typeof block.text === 'string',
  { message: 'Text content blocks require text' },
);

// looseObject 保留框架元数据，避免恢复时丢掉摘要标记或模型扩展字段。
const messageDataSchema = z.looseObject({
  content: z.union([z.string(), z.array(contentBlockSchema)]),
  id: z.string().optional(),
  name: z.string().optional(),
  additional_kwargs: z.record(z.string(), z.unknown()).optional(),
  response_metadata: z.record(z.string(), z.unknown()).optional(),
});

const toolCallSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
  type: z.literal('tool_call').optional(),
});

// 只保存已合并的对话状态；System Prompt 和 RemoveMessage 不属于持久化历史。
const storedContextSchema = z.array(z.discriminatedUnion('type', [
  z.looseObject({
    type: z.literal('human'),
    data: messageDataSchema,
  }),
  z.looseObject({
    type: z.literal('ai'),
    data: messageDataSchema.extend({
      tool_calls: z.array(toolCallSchema).optional(),
    }),
  }),
  z.looseObject({
    type: z.literal('tool'),
    data: messageDataSchema.extend({
      tool_call_id: z.string().min(1),
      status: z.enum(['success', 'error']).optional(),
    }),
  }),
]));

function parseStoredContext(value: unknown): StoredMessage[] {
  const result = storedContextSchema.safeParse(value);
  if (!result.success) {
    // 不透传 Zod 的详细错误，避免错误对象携带对话或工具参数。
    throw new Error('Invalid agent context message format');
  }

  // @langchain/core 1.2.9 的 StoredMessageData 仍声明 content 为 string，
  // 且把若干可选字段声明为必填；实际转换函数支持这里校验过的内容块和可选字段。
  return result.data as unknown as StoredMessage[];
}

/** 返回可供 JSON 传输和 JSONB 保存的对象数组，不提前编码成字符串。 */
export function serializeContext(messages: BaseMessage[]): StoredMessage[] {
  return parseStoredContext(mapChatMessagesToStoredMessages(messages));
}

/** 恢复框架消息对象；数据库 null 应由加载方作为“尚无上下文”处理。 */
export function restoreContext(value: unknown): BaseMessage[] {
  const stored = parseStoredContext(value);
  try {
    return mapStoredMessagesToChatMessages(stored);
  } catch {
    // 框架构造消息失败也不附带原始数据，不静默丢弃无法恢复的消息。
    throw new Error('Unable to restore agent context messages');
  }
}
