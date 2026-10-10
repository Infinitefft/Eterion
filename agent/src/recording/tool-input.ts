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

export type RagStageEvent = {
  name: 'query_embedding' | 'vector_search' | 'bm25_search' | 'rrf_fusion' | 'rerank' | 'filter'; status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: number; endedAt?: number; model?: string; dimensions?: number; limit?: number;
  resultCount?: number; error?: { name: string; message: string };
  threshold?: number; candidateCount?: number; qualifiedCount?: number;
  candidates?: { chunkId: string; rerankScore: number; selected: boolean }[];
  vectorCount?: number; bm25Count?: number; rankConstant?: number;
  fusionCandidates?: { chunkId: string; cosineDistance?: number; bm25Score?: number;
    vectorRank?: number; bm25Rank?: number; rrfScore: number; selected: boolean }[];
};

// 监控采集：沿用工具回调 ID 关联阶段；观察事件失败不影响检索。
export async function recordRagStage(event: RagStageEvent, config?: RunnableConfig): Promise<void> {
  if (!config?.callbacks) return;
  try {
    await dispatchCustomEvent('eterion.rag.stage', event, config);
  } catch (error) {
    console.warn('RAG stage recording unavailable', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
  }
}
