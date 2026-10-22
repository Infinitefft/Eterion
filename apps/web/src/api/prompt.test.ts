import { afterEach, expect, it, vi } from 'vitest';
import { apiClient } from './client';
import { polishPrompt } from './prompt';

afterEach(() => vi.restoreAllMocks());

it('posts only the prompt, preserving text and the cancellation signal', async () => {
  const post = vi.spyOn(apiClient, 'post').mockResolvedValue({ data: { data: { content: '润色结果' } } });
  const controller = new AbortController();
  expect(await polishPrompt('原文\n第二行', controller.signal)).toBe('润色结果');
  expect(post).toHaveBeenCalledWith('/chat/prompt/polish', { content: '原文\n第二行' }, { signal: controller.signal, timeout: 35_000 });
});

it('rejects an empty model result instead of replacing the draft', async () => {
  vi.spyOn(apiClient, 'post').mockResolvedValue({ data: { data: { content: '   ' } } });
  await expect(polishPrompt('原文', new AbortController().signal)).rejects.toThrow('润色返回内容为空');
});

it('propagates failure so the composer can retain the original', async () => {
  vi.spyOn(apiClient, 'post').mockRejectedValue(new Error('unavailable'));
  await expect(polishPrompt('原文', new AbortController().signal)).rejects.toThrow('unavailable');
});
