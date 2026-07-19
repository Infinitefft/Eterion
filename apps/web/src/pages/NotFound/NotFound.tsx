import { ArrowLeft } from 'lucide-react';
import { Link } from 'react-router-dom';

import { routePaths } from '@/app/routePaths';

import './NotFound.less';

export function NotFound() {
  return (
    <main className='not-found'>
      <p className='section-label'>404 / Route not found</p>
      <h1>这里还没有页面。</h1>
      <p>当前地址尚未配置路由，请返回首页继续。</p>
      <Link className='primary-action' to={routePaths.root}>
        <ArrowLeft size={18} aria-hidden='true' />
        返回首页
      </Link>
    </main>
  );
}
