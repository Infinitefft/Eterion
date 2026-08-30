/** IM 领域的 HTTP 数据访问接口。 */
import { apiClient } from '@/api/client';
import type {
  ModelId,
  ThreadId,
  ThreadRecord,
  ThreadSnapshot,
  UnixTimestamp,
} from '@/service/im/types';
import type { ApiResponse } from '@/types/api';

/** REST 会话列表和标题更新当前返回的原始结构。 */
interface ThreadResponse {
  id: ThreadId;
  title: string;
  created_at: string;
  updated_at: string;
}

/** 模型目录中单个模型的原始响应。 */
interface ChatModelResponse {
  id: ModelId;
  modelName: string;
  provider: string;
  providerName: string;
  icon_url: string;
}

/** 模型目录的原始响应。 */
interface ChatModelCatalogResponse {
  default_model_id: ModelId;
  models: ChatModelResponse[];
}

/** 一次性 WebSocket Ticket 的原始响应。 */
interface IMTicketResponse {
  ticket: string;
  expires_at: UnixTimestamp;
}

/** 页面模型选择器使用的模型信息。 */
export interface ChatModel {
  id: ModelId;
  modelName: string;
  provider: string;
  providerName: string;
  iconUrl: string | null;
}

/** 当前可用模型及服务端默认模型。 */
export interface ChatModelCatalog {
  /** 服务端没有配置默认模型时为 null。 */
  defaultModelId: ModelId | null;
  models: ChatModel[];
}

/** Transport 建立一次 WebSocket 连接所需的短期凭证。 */
export interface IMTicket {
  ticket: string;
  expiresAt: UnixTimestamp;
}

/** 把 REST 使用的 RFC3339 时间转换成前端统一使用的 Unix 毫秒。 */
function toUnixTimestamp(value: string): UnixTimestamp {
  return Date.parse(value);
}

/** 把后端列表 DTO 转换成不包含纯前端状态的 ThreadRecord。 */
function mapThreadResponse(thread: ThreadResponse): ThreadRecord {
  return {
    id: thread.id,
    title: thread.title,
    createdAt: toUnixTimestamp(thread.created_at),
    updatedAt: toUnixTimestamp(thread.updated_at),
  };
}

/** 把后端模型 DTO 转换成页面使用的 camelCase 结构。 */
function mapChatModelResponse(model: ChatModelResponse): ChatModel {
  return {
    id: model.id,
    modelName: model.modelName,
    provider: model.provider,
    providerName: model.providerName,
    iconUrl: model.icon_url || null,
  };
}

/** 获取服务端当前可用的模型目录。 */
export async function fetchChatModels(): Promise<ChatModelCatalog> {
  const response = await apiClient.get<ApiResponse<ChatModelCatalogResponse>>('/chat/models');
  const catalog = response.data.data;

  return {
    defaultModelId: catalog.default_model_id || null,
    models: catalog.models.map(mapChatModelResponse),
  };
}

/**
 * 获取当前用户的全部 Thread。
 *
 * 后端目前按 updated_at 从新到旧返回，REST 层保持该顺序，
 * 是否重新排序由后续 Store 或页面决定。
 */
export async function fetchThreads(): Promise<ThreadRecord[]> {
  const response = await apiClient.get<ApiResponse<ThreadResponse[]>>('/chat');

  return response.data.data.map(mapThreadResponse);
}

/** 修改一个 Thread 的标题，并返回服务端更新后的完整元数据。 */
export async function updateThreadTitle(threadId: ThreadId, title: string): Promise<ThreadRecord> {
  const response = await apiClient.patch<ApiResponse<ThreadResponse>>(
    `/chat/${encodeURIComponent(threadId)}`,
    { title },
  );

  return mapThreadResponse(response.data.data);
}

/** 删除一个 Thread；成功响应为 204，因此没有业务响应体。 */
export async function deleteThread(threadId: ThreadId): Promise<void> {
  await apiClient.delete(`/chat/${encodeURIComponent(threadId)}`);
}

/**
 * 获取一个 Thread 的权威 Snapshot。
 *
 * 这里描述的是新版契约：thread/messages/runs/blocks/lastSeqId。
 * 旧后端的 chat/steps/cursor 和 Run.lastSeq 不能在前端伪造成该结构。
 */
export async function fetchThreadSnapshot(threadId: ThreadId): Promise<ThreadSnapshot> {
  const response = await apiClient.get<ApiResponse<ThreadSnapshot>>(
    `/chat/${encodeURIComponent(threadId)}/snapshot`,
  );

  return response.data.data;
}

/**
 * 申请一次性的短期 WebSocket Ticket。
 *
 * Transport 每次新连接或自动重连都必须重新调用，不能复用旧 Ticket。
 */
export async function createIMTicket(): Promise<IMTicket> {
  const response = await apiClient.post<ApiResponse<IMTicketResponse>>('/chat/ticket');
  const ticket = response.data.data;

  return {
    ticket: ticket.ticket,
    expiresAt: ticket.expires_at,
  };
}
