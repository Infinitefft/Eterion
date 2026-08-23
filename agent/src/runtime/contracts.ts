import { z } from 'zod';

import type { AgentEvent } from './events.js';

export const messageInputSchema = z.object({
  // System Prompt 由 Agent 自己构建，调用方只传用户和 Assistant 历史。
  role: z.enum(['user', 'assistant']),
  content: z.string(),
});

export const runInputSchema = z
  .object({
    run_id: z.string().min(1),
    thread_id: z.string().min(1),
    model_id: z.string().min(1),
    messages: z.array(messageInputSchema).min(1),
  })
  .refine((input) => input.messages.at(-1)?.role === 'user', {
    message: 'the last message must be a user message',
    path: ['messages'],
  });

export type MessageInput = z.infer<typeof messageInputSchema>;
export type RunInput = z.infer<typeof runInputSchema>;

export interface PublicModel {
  id: string;
  modelName: string;
  provider: string;
  providerName: string;
  icon_url: string;
}

/** Runtime 是框架隔离层，未来 Direct 和 DeepAgents 都实现这个接口。 */
export interface AgentRuntime {
  readonly defaultModelId: string;
  readonly models: PublicModel[];

  stream(input: RunInput): AsyncGenerator<AgentEvent>;
  close(): Promise<void>;
}
