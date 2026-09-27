import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';

import { getApiError } from '@/api/errors';
import { fetchContextUsage } from '@/api/im';
import type { ModelId, ThreadId } from '@/service/im/types';
import { useAuthStore } from '@/store/auth-store';
import { useIMStore } from '@/store/im-store';

interface ContextUsageNoticeProps {
  threadId: ThreadId;
  modelId: ModelId | null;
  busy: boolean;
  revision: number;
  onClose: () => void;
}

export function ContextUsageNotice({ threadId, modelId, busy, revision, onClose }: ContextUsageNoticeProps) {
  const sessionVersion = useAuthStore((state) => state.sessionVersion);
  const latestRun = useIMStore((state) => {
    const run = state.detailsByThread[threadId]?.runs.at(-1);
    return run ? `${run.id}:${run.status}` : '';
  });
  const query = useQuery({
    queryKey: ['context-usage', sessionVersion, threadId, modelId, latestRun, revision],
    queryFn: ({ signal }) => fetchContextUsage(threadId, modelId, signal),
    enabled: !busy,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const usage = query.data;
  const remainingPercent = usage ? Math.round(usage.remainingTokens / usage.contextWindow * 100) : 0;
  const format = (value: number) => value.toLocaleString('zh-CN');

  return (
    <div id='chat-context-usage' className='chat-detail-compaction-notice chat-context-usage'>
      <div className='chat-context-usage-content' role='status' aria-live='polite'>
        {busy ? <span>会话正在更新，完成后将刷新上下文余量…</span>
          : query.isFetching || query.isPending ? <span>正在读取上下文余量…</span>
            : query.isError ? (
              <span>
                {getApiError(query.error)?.message ?? '上下文余量读取失败'}
                <button className='chat-context-retry' type='button' onClick={() => { void query.refetch(); }}>重试</button>
              </span>
            ) : usage ? (
              <>
                <strong>上下文剩余约 {remainingPercent}% · {format(usage.remainingTokens)} Token</strong>
                <progress aria-label='上下文已用比例（估算）' max={usage.contextWindow} value={Math.min(usage.usedTokens, usage.contextWindow)} />
                <span>已用约 {format(usage.usedTokens)} / 配置容量 {format(usage.contextWindow)} Token</span>
                <span className='chat-context-usage-hint'>包含历史、系统提示词和工具定义，不含未发送草稿；剩余空间也需用于模型输出。此为估算，非累计消耗。</span>
              </>
            ) : null}
      </div>
      <button className='chat-detail-tool-button' type='button' title='关闭上下文余量' aria-label='关闭上下文余量' onClick={onClose}>
        <X size={16} />
      </button>
    </div>
  );
}
