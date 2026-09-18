import { dispatchCustomEvent } from '@langchain/core/callbacks/dispatch/web';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { JsonValue } from '../protocol.js';

// 框架的 ToolStart 只提供原始参数。工具函数入口才能观察校验、默认值及转换后的输入。
export async function recordToolInput(args: JsonValue, config?: RunnableConfig): Promise<void> {
  if (!config?.callbacks) return;
  try {
    await dispatchCustomEvent('eterion.tool.input', args, config);
  } catch (error) {
    // 可选观察行为不能改变工具执行结果，也不输出可能含凭据的原始异常。
    console.warn('tool input recording unavailable', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
  }
}
