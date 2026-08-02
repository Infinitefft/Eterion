/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 全局 IM WebSocket 地址；未配置时 IM Transport 保持 disabled。 */
  readonly VITE_IM_WS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
