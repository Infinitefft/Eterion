import { RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useStore } from 'zustand';

import { getIMService, imStore } from '@/service/im';
import type { IMConnectionStatus } from '@/service/im/transport';

const CONNECTION_LABELS: Record<IMConnectionStatus, string> = {
  disabled: '连接未启用',
  idle: '等待连接',
  connecting: '正在连接',
  connected: '实时连接正常',
  reconnecting: '正在恢复连接',
  disconnected: '连接已断开',
  failed: '连接恢复失败',
};

/** 只订阅连接相关的几个原始字段，不读取整份 IM Store。 */
export function ConnectionStatus() {
  const [isRetrying, setIsRetrying] = useState(false);
  const status = useStore(imStore, (state) => state.connection.status);
  const reconnectAttempts = useStore(
    imStore,
    (state) => state.connection.reconnectAttempts,
  );
  const errorMessage = useStore(
    imStore,
    (state) => state.connection.lastError?.message ?? null,
  );

  const canReconnect = status === 'disconnected' || status === 'failed';
  const label =
    status === 'reconnecting' && reconnectAttempts > 0
      ? `${CONNECTION_LABELS[status]} · ${reconnectAttempts}`
      : CONNECTION_LABELS[status];

  async function handleReconnect() {
    if (!canReconnect || isRetrying) return;

    setIsRetrying(true);
    try {
      await getIMService().connect();
    } catch {
      /** 具体错误由 Transport 写回 connection.lastError。 */
    } finally {
      setIsRetrying(false);
    }
  }

  return (
    <div
      className="chat-connection-status"
      data-status={status}
      title={errorMessage || label}
    >
      <span className="chat-connection-dot" aria-hidden="true" />
      <span>{label}</span>

      {canReconnect ? (
        <button
          type="button"
          disabled={isRetrying}
          onClick={() => {
            void handleReconnect();
          }}
        >
          <RefreshCw
            className={isRetrying ? 'chat-run-spinner' : undefined}
            size={12}
            aria-hidden="true"
          />
          重连
        </button>
      ) : null}
    </div>
  );
}
