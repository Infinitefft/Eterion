import type { BaseMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';
import { z } from 'zod';

// 回调只通过本次调用的 context 传递，不存入消息状态，也不交给模型。
export const captureContextSchema = z.object({
  captureMessages: z.custom<(messages: BaseMessage[]) => void>(
    (value) => typeof value === 'function',
    { message: 'captureMessages must be a function' },
  ).optional(),
  onContextTruncated: z.custom<() => void>(
    (value) => typeof value === 'function',
  ).optional(),
});

export const captureContextMiddleware = createMiddleware({
  name: 'CaptureFinalContext',
  contextSchema: captureContextSchema,
  afterAgent(state, runtime) {
    // 只交付框架已经合并的最终状态；是否成功仍由 Runtime 检查。
    // 独立脚本可以不提供接收函数，继续正常执行。
    runtime.context?.captureMessages?.(state.messages);
  },
});
