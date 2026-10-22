import { apiClient } from './client';
import type { ApiResponse } from '@/types/api';

export async function polishPrompt(content: string, signal: AbortSignal): Promise<string> {
  const response = await apiClient.post<ApiResponse<{ content: string }>>(
    '/chat/prompt/polish', { content }, { signal, timeout: 35_000 },
  );
  const result = response.data.data.content;
  if (typeof result !== 'string' || !result.trim()) throw new Error('润色返回内容为空，请重试');
  return result;
}
