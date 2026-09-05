import { z } from 'zod';

const messageInputSchema = z.object({
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

export type RunInput = z.infer<typeof runInputSchema>;

export interface PublicModel {
  id: string;
  modelName: string;
  provider: string;
  providerName: string;
  icon_url: string;
}

/** HTTP 只依赖这份契约；普通对象就能满足它，不需要类或继承。 */
export interface AgentRuntime {
  readonly defaultModelId: string;
  readonly models: PublicModel[];

  stream(input: RunInput): AsyncGenerator<AgentEvent>;
}

/** JSON 能安全传输的数据类型，与前端 IM 的 JsonValue 含义一致。 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** 框架内部事件在 Runtime 中转换为这组领域事件，Go 再映射为前端 IM envelope。 */
export type AgentEventType =
  | 'run.started'
  | 'run.completed'
  | 'run.failed'
  | 'thinking.delta'
  | 'thinking.completed'
  | 'content.started'
  | 'content.delta'
  | 'content.completed'
  | 'tool.started'
  | 'tool.completed'
  | 'tool.failed';

export interface AgentEvent {
  type: AgentEventType;
  runId: string;
  payload: Record<string, JsonValue>;
}

export interface AgentError {
  code: string;
  message: string;
  retryable: boolean;
}

export function runFailed(
  runId: string,
  code: string,
  message: string,
  retryable: boolean,
): AgentEvent {
  return {
    type: 'run.failed',
    runId,
    payload: {
      error: { code, message, retryable },
    },
  };
}
