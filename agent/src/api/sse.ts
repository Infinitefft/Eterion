import type { ServerResponse } from 'node:http';

import { runFailed, type AgentEvent } from '../runtime/events.js';

export function encodeSse(event: AgentEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify({
    runId: event.runId,
    payload: event.payload,
  })}\n\n`;
}

/** 把 Runtime 的异步事件写入长连接，并定时发送 SSE 注释作为心跳。 */
export async function writeSseStream(
  response: ServerResponse,
  events: AsyncIterable<AgentEvent>,
  runId: string,
  heartbeatMs: number,
): Promise<void> {
  const heartbeat = setInterval(() => {
    if (!response.destroyed) response.write(': keepalive\n\n');
  }, heartbeatMs);

  try {
    for await (const event of events) {
      if (response.destroyed) break;
      response.write(encodeSse(event));
    }
  } catch (error) {
    console.error('Agent SSE stream failed', { runId, error });
    if (!response.destroyed) {
      response.write(
        encodeSse(runFailed(runId, 'AGENT_SERVICE_ERROR', 'Agent 服务执行失败', true)),
      );
    }
  } finally {
    clearInterval(heartbeat);
    if (!response.destroyed) response.end();
  }
}
