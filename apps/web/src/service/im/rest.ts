import { apiClient } from '@/api/client';
import type { ApiResponse } from '@/types/api';

import type { Chat, ChatId, ChatSnapshot } from './types';

interface ChatListItemResponse {
  id: ChatId;
  title: string;
  created_at: string;
  updated_at: string;
}

function parseServerTime(value: string, field: string): number {
  const timestamp = Date.parse(value);

  if (!Number.isFinite(timestamp)) {
    throw new Error(`服务端返回了无效的 ${field}`);
  }

  return timestamp;
}

function mapChatResponse(chat: ChatListItemResponse): Chat {
  return {
    id: chat.id,
    title: chat.title,
    createdAt: parseServerTime(chat.created_at, 'created_at'),
    updatedAt: parseServerTime(chat.updated_at, 'updated_at'),
  };
}

/** 加载当前用户的会话列表，并转换为 IM Store 使用的领域对象。 */
export async function fetchChats(): Promise<Chat[]> {
  const response = await apiClient.get<ApiResponse<ChatListItemResponse[]>>('/chat');

  /**
   * 后端按 updated_at 倒序返回，Store 内部保持旧到新的顺序，
   * 侧边栏展示时再反转为最近会话优先。
   */
  return response.data.data.map(mapChatResponse).reverse();
}

/** 修改当前用户拥有的会话标题。 */
export async function updateChatTitle(chatId: ChatId, title: string): Promise<Chat> {
  const response = await apiClient.patch<ApiResponse<ChatListItemResponse>>(
    `/chat/${encodeURIComponent(chatId)}`,
    { title },
  );

  return mapChatResponse(response.data.data);
}

/** 删除当前用户拥有的会话及其消息和运行记录。 */
export async function deleteChat(chatId: ChatId): Promise<void> {
  await apiClient.delete(`/chat/${encodeURIComponent(chatId)}`);
}

/** 加载一个历史会话的消息、Run 和 Step 权威快照。 */
export async function fetchChatSnapshot(chatId: ChatId): Promise<ChatSnapshot> {
  const response = await apiClient.get<ApiResponse<ChatSnapshot>>(
    `/chat/${encodeURIComponent(chatId)}/snapshot`,
  );

  return response.data.data;
}
