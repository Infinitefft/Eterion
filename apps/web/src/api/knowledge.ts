import { apiClient } from '@/api/client';
import type { ApiResponse } from '@/types/api';

export type KnowledgeBase = {
  file_count: number;
  id: string;
  title: string;
  description: string;
  created_at: string;
  updated_at: string;
};

export async function listKnowledgeBases(signal?: AbortSignal) {
  const response = await apiClient.get<ApiResponse<KnowledgeBase[]>>('/knowledge-bases', {
    signal,
  });
  return response.data.data;
}

export async function createKnowledgeBase(payload: { title: string; description: string }) {
  const response = await apiClient.post<ApiResponse<KnowledgeBase>>('/knowledge-bases', payload);
  return response.data.data;
}

export type KnowledgeFile = {
  id: string;
  knowledge_base_id: string;
  original_name: string;
  object_key: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
  updated_at: string;
};

export async function getKnowledgeFileContent(
  baseId: string,
  fileId: string,
  signal?: AbortSignal,
) {
  const response = await apiClient.get<ApiResponse<{ content: string; format: 'txt' | 'md' }>>(
    `/knowledge-bases/${baseId}/files/${fileId}/content`,
    { signal },
  );
  return response.data.data;
}

export async function listKnowledgeFiles(baseId: string, signal?: AbortSignal) {
  const response = await apiClient.get<ApiResponse<KnowledgeFile[]>>(
    `/knowledge-bases/${baseId}/files`,
    { signal },
  );
  return response.data.data;
}

export async function deleteKnowledgeFile(baseId: string, fileId: string) {
  await apiClient.delete(`/knowledge-bases/${baseId}/files/${fileId}`);
}

export async function deleteKnowledgeBase(baseId: string) {
  await apiClient.delete(`/knowledge-bases/${baseId}`, { timeout: 190_000 });
}

export async function uploadKnowledgeFile(baseId: string, file: File, signal?: AbortSignal) {
  const form = new FormData();
  form.append('file', file);
  const response = await apiClient.post<ApiResponse<KnowledgeFile>>(
    `/knowledge-bases/${baseId}/files`,
    form,
    {
      signal,
      timeout: 190_000,
    },
  );
  return response.data.data;
}
