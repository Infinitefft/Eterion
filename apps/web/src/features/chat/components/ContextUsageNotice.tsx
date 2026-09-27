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
  const usedPercent = usage ? usage.usedTokens / usage.contextWindow * 100 : 0;
  const format = (value: number) => `${(value / 1000).toFixed(1)}k`;

  return (
    <div id='chat-context-usage' className='chat-detail-compaction-notice chat-context-usage'>
      <div className='chat-context-usage-content' role='status' aria-live='polite'>
        {busy ? <span>等待更新…</span>
          : query.isFetching || query.isPending ? <span>读取中…</span>
            : query.isError ? (
              <span>
                {getApiError(query.error)?.message ?? '上下文余量读取失败'}
                <button className='chat-context-retry' type='button' onClick={() => { void query.refetch(); }}>重试</button>
              </span>
            ) : usage ? (
              <>
                <span>上下文窗口：约 {format(usage.usedTokens)} / {format(usage.contextWindow)}  · 已用 {usedPercent.toFixed(1)}%</span>
                <div
                  className='chat-context-usage-track'
                  role='progressbar'
                  aria-label='上下文已用量（估算）'
                  aria-valuemin={0}
                  aria-valuemax={usage.contextWindow}
                  aria-valuenow={Math.min(usage.usedTokens, usage.contextWindow)}
                  aria-valuetext={`约 ${format(usage.usedTokens)} / ${format(usage.contextWindow)} Token，已用 ${usedPercent.toFixed(1)}%`}
                >
                  <div
                    className='chat-context-usage-fill'
                    style={{ width: `${Math.min(100, usedPercent)}%` }}
                  />
                </div>
              </>
            ) : null}
      </div>
      <button className='chat-detail-tool-button' type='button' title='关闭上下文余量' aria-label='关闭上下文余量' onClick={onClose}>
        <X size={16} />
      </button>
    </div>
  );
}
