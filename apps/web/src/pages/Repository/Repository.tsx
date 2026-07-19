import { BookOpen, FileText, Plus, Search, Sparkles } from 'lucide-react';

import './Repository.less';

const repositoryItems = [
  { title: '产品与技术规划', meta: '12 个文档 · 刚刚更新' },
  { title: 'Agent 架构资料', meta: '8 个文档 · 2 天前更新' },
  { title: '交互设计参考', meta: '5 个文档 · 7 天前更新' },
];

export function Repository() {
  return (
    <section className='repository-page'>
      <header className='repository-header'>
        <div>
          <p className='page-kicker'>Knowledge</p>
          <h1>知识库</h1>
          <p>集中管理 Agent 可以检索和引用的资料。</p>
        </div>
        <button className='repository-create-button' type='button'>
          <Plus size={17} />
          新建知识库
        </button>
      </header>

      <div className='repository-search'>
        <Search size={18} />
        <input aria-label='搜索知识库' placeholder='搜索知识库' />
      </div>

      <div className='repository-grid'>
        {repositoryItems.map((item, index) => (
          <button className='repository-card' key={item.title} type='button'>
            <span className='repository-card-icon'>
              {index === 0 ? <Sparkles size={20} /> : <BookOpen size={20} />}
            </span>
            <span className='repository-card-copy'>
              <strong>{item.title}</strong>
              <small>{item.meta}</small>
            </span>
            <FileText size={17} />
          </button>
        ))}
      </div>
    </section>
  );
}
