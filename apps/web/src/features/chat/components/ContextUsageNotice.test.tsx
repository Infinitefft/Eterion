import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';

import type { ContextUsage } from '@/api/im';
import { useAuthStore } from '@/store/auth-store';

import { ContextUsageNotice } from './ContextUsageNotice';

const usage: ContextUsage = {
  modelId: 'deepseek-v4-pro', contextWindow: 100_000,
  autoCompactTokenLimit: 80_000, usedTokens: 10_000, remainingTokens: 90_000,
};

function queryKey(threadId = 'thread') {
  return ['context-usage', useAuthStore.getState().sessionVersion, threadId, null];
}

function render(client: QueryClient, busy: boolean, threadId = 'thread', visible = true) {
  return renderToStaticMarkup(<QueryClientProvider client={client}>
    <ContextUsageNotice threadId={threadId} modelId={null} busy={busy} visible={visible} onClose={() => {}} />
  </QueryClientProvider>);
}

it('keeps the previous usage visible while generating, including after reopening', () => {
  const client = new QueryClient();
  client.setQueryData(queryKey(), usage);
  expect(render(client, true, 'thread', false)).toBe('');
  const html = render(client, true);
  expect(html).toContain('aria-valuenow="10000"');
  expect(html).toContain('当前显示上次统计');
  expect(html).not.toContain('读取中');
  client.clear();
});

it('keeps old usage during refresh and replaces it only after the new result arrives', async () => {
  const client = new QueryClient();
  client.setQueryData(queryKey(), usage);
  let complete!: (value: ContextUsage) => void;
  const refresh = client.fetchQuery({
    queryKey: queryKey(),
    queryFn: () => new Promise<ContextUsage>((resolve) => { complete = resolve; }),
  });
  expect(render(client, false)).toContain('aria-valuenow="10000"');
  complete({ ...usage, usedTokens: 20_000, remainingTokens: 80_000 });
  await refresh;
  expect(render(client, false)).toContain('aria-valuenow="20000"');
  client.clear();
});

it('retains the previous statistics and offers retry when refresh fails', async () => {
  const client = new QueryClient();
  client.setQueryData(queryKey(), usage);
  await client.fetchQuery({
    queryKey: queryKey(), retry: false,
    queryFn: () => Promise.reject(new Error('offline')),
  }).catch(() => {});
  const html = render(client, false);
  expect(html).toContain('aria-valuenow="10000"');
  expect(html).toContain('重试');
  client.clear();
});

it('does not reuse another conversation’s statistics when opened during generation', () => {
  const client = new QueryClient();
  client.setQueryData(queryKey(), usage);
  const html = render(client, true, 'other-thread');
  expect(html).not.toContain('role="progressbar"');
  expect(html).toContain('暂无生成前的统计');
  client.clear();
});
