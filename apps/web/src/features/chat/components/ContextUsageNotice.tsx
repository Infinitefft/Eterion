import { useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useEffect } from 'react';

import { getApiError } from '@/api/errors';
import { fetchContextUsage } from '@/api/im';
import type { ModelId, ThreadId } from '@/service/im/types';
import { useAuthStore } from '@/store/auth-store';

interface ContextUsageNoticeProps {
  threadId: ThreadId;
  modelId: ModelId | null;
  busy: boolean;
  visible: boolean;
  onClose: () => void;
}

export function ContextUsageNotice({ threadId, modelId, busy, visible, onClose }: ContextUsageNoticeProps) {
  const sessionVersion = useAuthStore((state) => state.sessionVersion);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['context-usage', sessionVersion, threadId, modelId],
    queryFn: ({ signal }) => fetchContextUsage(threadId, modelId, signal),
    enabled: !busy,
    staleTime: 0,
    retry: false,
  });
  useEffect(() => {
    if (busy) {
      // 生成或压缩开始时撤销未完成的统计，保留此前成功的数据。
      void queryClient.cancelQueries({
        queryKey: ['context-usage', sessionVersion, threadId, modelId],
        exact: true,
      });
    }
  }, [busy, queryClient, sessionVersion, threadId, modelId]);

  const usage = query.data;
  const usedPercent = usage ? usage.usedTokens / usage.contextWindow * 100 : 0;
  const format = (value: number) => `${(value / 1000).toFixed(1)}k`;

  // 隐藏时仍保留查询订阅；忙碌结束后自动刷新，打开面板不会丢失生成前的数据。
  if (!visible) return null;

  return (
    <div id='chat-context-usage' className='chat-detail-compaction-notice chat-context-usage'>
      <div className='chat-context-usage-content' role='status' aria-live='polite'>
        {usage ? (
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
        ) : busy ? <span>暂无生成前的统计，完成后更新…</span>
          : !query.isError ? <span>读取中…</span> : null}
        {usage && busy ? <span>当前显示上次统计，完成后更新</span> : null}
        {!busy && query.isError ? (
          <span>
            {getApiError(query.error)?.message ?? '上下文余量读取失败'}
            <button className='chat-context-retry' type='button' onClick={() => { void query.refetch(); }}>重试</button>
          </span>
        ) : null}
      </div>
      <button className='chat-detail-tool-button' type='button' title='关闭上下文余量' aria-label='关闭上下文余量' onClick={onClose}>
        <X size={16} />
      </button>
    </div>
  );
}
