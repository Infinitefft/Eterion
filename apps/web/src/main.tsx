import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { initializeIMService } from '@/service/im';
import '@/styles/index.css';
import '@/styles/theme.less';
// Keep global layers ahead of component-local Less in the generated cascade.
// eslint-disable-next-line import-x/order
import { App } from '@/app/App';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('无法找到应用挂载节点 #root');
}

/**
 * 在 React 页面渲染前初始化全局 IM Service。
 * 这里只注册监听器，不会在用户认证完成前连接后端。
 */
initializeIMService();

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
