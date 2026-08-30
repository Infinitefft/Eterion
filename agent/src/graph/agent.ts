import type { ChatOpenAI } from '@langchain/openai';
import {
  type AnyAgentMiddleware,
  type ReactAgent,
  createAgent,
  modelCallLimitMiddleware,
  toolCallLimitMiddleware,
  toolErrorMiddleware,
} from 'langchain';

import type { createWebSearchTool } from '../tools/web-search.js';
import type { webFetch } from '../tools/web-fetch.js';

const MAX_TOOL_CALLS = 4;
const MAX_MODEL_CALLS = 6;

interface ToolCallLimitOptions {
  runLimit: number;
  exitBehavior: 'continue' | 'error' | 'end';
}

interface ModelCallLimitOptions {
  runLimit: number;
  exitBehavior: 'error' | 'end';
}

/**
 * LangChain 1.5.10 的两个 Limit Middleware 类型声明与
 * exactOptionalPropertyTypes 不兼容，但运行时参数本身是官方支持的。
 * 把类型兼容集中在这里，避免为了第三方声明问题关闭全项目的严格检查。
 */
const createToolCallLimit = toolCallLimitMiddleware as unknown as (
  options: ToolCallLimitOptions,
) => AnyAgentMiddleware;

const createModelCallLimit = modelCallLimitMiddleware as unknown as (
  options: ModelCallLimitOptions,
) => AnyAgentMiddleware;

type WebSearchTool = ReturnType<typeof createWebSearchTool>;
type WebFetchTool = typeof webFetch;

export interface CreateWebAgentOptions {
  model: ChatOpenAI;
  prompt: string;
  tools: readonly [WebSearchTool, WebFetchTool];
}

/**
 * 这是你要亲手完成的第一段核心代码：组装 ReAct Agent。
 *
 * 需要使用上方已经导入的四个函数：
 * 1. toolCallLimitMiddleware()：单轮最多执行 MAX_TOOL_CALLS 次 Tool。
 * 2. modelCallLimitMiddleware()：单轮最多请求 MAX_MODEL_CALLS 次模型。
 * 3. toolErrorMiddleware()：把 Tool 异常转换成安全提示，让模型有机会收敛。
 * 4. createAgent()：把 model、prompt、tools、middleware 组合成工作流。
 *
 * Tool 错误提示不要包含原始 error.message，它可能带有内部网络信息。
 */
export function createWebAgent(options: CreateWebAgentOptions): ReactAgent {
  const tools = [...options.tools];

  const toolCallLimit = createToolCallLimit({
    runLimit: MAX_TOOL_CALLS,
    exitBehavior: 'continue',
  });

  const modelCallLimit = createModelCallLimit({
    runLimit: MAX_MODEL_CALLS,
    exitBehavior: 'end',
  });

  const toolError = toolErrorMiddleware({
    tools,
    onError: (_error, request) =>
      `工具 ${request.toolCall.name} 执行失败。请调整参数、改用其他信息来源，或如实向用户说明当前限制。`,
  });

  return createAgent({
    model: options.model,
    systemPrompt: options.prompt,
    tools,
    middleware: [toolCallLimit, modelCallLimit, toolError],
  });
}

/** 给 Runtime 使用的语义化别名，不把 LangChain 的具体泛型传播到其他模块。 */
export type WebAgent = ReactAgent;
