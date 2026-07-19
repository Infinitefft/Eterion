import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@/styles/index.css';
import '@/styles/theme.less';
// Keep global layers ahead of component-local Less in the generated cascade.
// eslint-disable-next-line import-x/order
import { App } from '@/app/App';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('无法找到应用挂载节点 #root');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
