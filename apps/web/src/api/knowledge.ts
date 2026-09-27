import { apiClient } from '@/api/client';
import type { ApiResponse } from '@/types/api';

export type KnowledgeBase = {
  id: string;
  title: string;
  description: string;
  created_at: string;
  updated_at: string;
};

export async function createKnowledgeBase(payload: { title: string; description: string }) {
  const response = await apiClient.post<ApiResponse<KnowledgeBase>>('/knowledge-bases', payload);
  return response.data.data;
}
