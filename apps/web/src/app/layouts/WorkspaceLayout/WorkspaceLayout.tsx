import { ChevronRight, UserRound } from 'lucide-react';
import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';

import { createConversationPath, routePaths } from '@/app/routePaths';
import { AuthDialog } from '@/components/AuthDialog/AuthDialog';

import './WorkspaceLayout.less';

const recentConversations = [
  { id: 'agent-runtime', title: 'Agent 运行时架构' },
  { id: 'ui-layout', title: '工作台界面布局' },
  { id: 'rag-design', title: '知识库检索设计' },
  { id: 'realtime-events', title: '实时事件协议梳理' },
];

function getInitialSidebarState() {
  return !window.matchMedia('(max-width: 800px)').matches;
}

function RoundedComposeIcon() {
  return (
    <svg
      className='rounded-nav-svg'
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='2'
      strokeLinecap='round'
      strokeLinejoin='round'
      aria-hidden='true'
      focusable='false'
    >
      <path d='M11.1 4H7.25A3.25 3.25 0 0 0 4 7.25v9.5A3.25 3.25 0 0 0 7.25 20h9.5A3.25 3.25 0 0 0 20 16.75V13' />
      <path d='m10.3 14.6.6-3.2 6.45-6.45a1.85 1.85 0 0 1 2.7 2.55l-.08.08-6.45 6.45-3.22.57Z' />
      <path d='m16.1 6.2 2.65 2.65' />
    </svg>
  );
}

function RoundedBookIcon() {
  return (
    <svg
      className='rounded-nav-svg'
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='2'
      strokeLinecap='round'
      strokeLinejoin='round'
      aria-hidden='true'
      focusable='false'
    >
      <rect x='2.75' y='3.5' width='5.5' height='17' rx='1.55' />
      <rect x='9.25' y='3.5' width='5.5' height='17' rx='1.55' />
      <rect x='16.1' y='3.5' width='5.15' height='17' rx='1.55' transform='rotate(-8 18.675 12)' />
    </svg>
  );
}

export function WorkspaceLayout() {
  const [isSidebarOpen, setIsSidebarOpen] = useState(getInitialSidebarState);
  const [isAuthOpen, setIsAuthOpen] = useState(false);

  const closeSidebarOnMobile = () => {
    if (window.matchMedia('(max-width: 800px)').matches) {
      setIsSidebarOpen(false);
    }
  };

  return (
    <div className={`workspace-shell ${isSidebarOpen ? 'sidebar-open' : 'sidebar-collapsed'}`}>
      <aside className='workspace-sidebar' aria-label='主导航' aria-hidden={!isSidebarOpen}>
        <header className='sidebar-header'>
          <NavLink
            className='product-mark'
            to={routePaths.chat}
            aria-label='返回新会话'
            onClick={closeSidebarOnMobile}
          >
            <img className='product-logo' src='/eterion-logo-black-transparent.png' alt='' />
          </NavLink>
          <div className='sidebar-header-actions'>
            <button
              className='icon-button sidebar-toggle-button'
              type='button'
              aria-label='隐藏侧边栏'
              onClick={() => setIsSidebarOpen(false)}
            >
              <span className='sidebar-panel-icon' aria-hidden='true' />
            </button>
          </div>
        </header>

        <div className='sidebar-scroll-area'>
          <nav className='sidebar-primary-nav' aria-label='工作区导航'>
            <NavLink
              className={({ isActive }) => `sidebar-link ${isActive ? 'is-active' : ''}`}
              to={routePaths.chat}
              end
              onClick={closeSidebarOnMobile}
            >
              <span className='sidebar-nav-icon' aria-hidden='true'>
                <RoundedComposeIcon />
              </span>
              <span>新会话</span>
            </NavLink>
            <NavLink
              className={({ isActive }) => `sidebar-link ${isActive ? 'is-active' : ''}`}
              to={routePaths.repository}
              onClick={closeSidebarOnMobile}
            >
              <span className='sidebar-nav-icon' aria-hidden='true'>
                <RoundedBookIcon />
              </span>
              <span>知识库</span>
            </NavLink>
          </nav>

          <section className='recent-section' aria-labelledby='recent-title'>
            <div className='section-heading-row'>
              <h2 id='recent-title'>最近会话</h2>
            </div>
            <nav className='conversation-nav' aria-label='最近会话'>
              {recentConversations.map((conversation) => (
                <NavLink
                  key={conversation.id}
                  className={({ isActive }) => `conversation-link ${isActive ? 'is-active' : ''}`}
                  to={createConversationPath(conversation.id)}
                  onClick={closeSidebarOnMobile}
                >
                  <span>{conversation.title}</span>
                </NavLink>
              ))}
            </nav>
          </section>
        </div>

        <footer className='sidebar-footer'>
          <button
            className='account-button'
            type='button'
            aria-label='登录或注册'
            onClick={() => setIsAuthOpen(true)}
          >
            <span className='account-avatar' aria-hidden='true'>
              <UserRound size={17} />
            </span>
            <span className='account-copy'>
              <strong>登录 / 注册</strong>
              <small>同步你的个人工作区</small>
            </span>
            <ChevronRight size={16} aria-hidden='true' />
          </button>
        </footer>
      </aside>

      <button
        className='sidebar-backdrop'
        type='button'
        aria-label='关闭侧边栏'
        onClick={() => setIsSidebarOpen(false)}
      />

      <main className='workspace-main'>
        {!isSidebarOpen ? (
          <button
            className='sidebar-open-button'
            type='button'
            aria-label='显示侧边栏'
            onClick={() => setIsSidebarOpen(true)}
          >
            <span className='sidebar-panel-icon' aria-hidden='true' />
          </button>
        ) : null}
        <Outlet />
      </main>

      <AuthDialog open={isAuthOpen} onClose={() => setIsAuthOpen(false)} />
    </div>
  );
}
