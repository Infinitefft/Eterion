import { AIMessage, ToolMessage } from '@langchain/core/messages';

import { loadSettings } from '../src/config.js';
import { createWebAgent } from '../src/agent.js';
import { buildModelClients } from '../src/models.js';
import { createWebSearchTool } from '../src/tools/web-search.js';
import { webFetch } from '../src/tools/web-fetch.js';

const DEFAULT_QUESTION =
  '搜索 LangChain Agent 的官方资料，阅读最相关的网页并总结，并附上来源 URL。';

async function main(): Promise<void> {
  const settings = loadSettings();
  const model = buildModelClients(settings).get(settings.defaultModelId);

  if (!model) {
    throw new Error(`默认模型 ${settings.defaultModelId} 不可用`);
  }

  const tools = [
    createWebSearchTool(settings.qianfanApiKey),
    webFetch,
  ] as const;

  const agent = createWebAgent({
    model,
    prompt: settings.systemPrompt,
    tools,
  });

  const question = process.argv.slice(2).join(' ').trim() || DEFAULT_QUESTION;

  /**
   * invoke() 会等待整个 ReAct 循环结束后，一次性返回完整消息历史。
   * 它适合先验证 Tool 选择与调用顺序，不适合生产环境的流式聊天展示。
   */
  const result = await agent.invoke({
    messages: [{ role: 'user', content: question }],
  });

  printAgentMessages(result.messages);
}

/** 只打印 Tool 名称、参数和最终回答，避免把整篇 web_fetch 正文输出到终端。 */
function printAgentMessages(messages: unknown[]): void {
  for (const message of messages) {
    if (AIMessage.isInstance(message)) {
      const toolCalls = message.tool_calls ?? [];

      if (toolCalls.length > 0) {
        for (const call of toolCalls) {
          console.log('[tool call]', call.name, call.args);
        }
        continue;
      }

      console.log('[assistant]', message.text);
      continue;
    }

    if (ToolMessage.isInstance(message)) {
      console.log('[tool result]', message.name, message.status);
    }
  }
}

main().catch((error: unknown) => {
  console.error('Agent eval failed', error);
  process.exitCode = 1;
});
