/** JSON 能安全传输的数据类型，与前端 IM 的 JsonValue 含义一致。 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Node、LangChain/Deep Agents 都不能改变这组领域事件。
 * Go 后续只需要把它们映射为前端 IM envelope。
 */
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
