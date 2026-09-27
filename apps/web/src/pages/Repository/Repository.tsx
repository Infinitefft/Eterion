import { ArrowLeft, ArrowUpRight, FileText, Folder, Search, Upload, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import type { KnowledgeBase } from '@/api/knowledge';
import { routePaths } from '@/app/routePaths';
import { CreateKnowledgeBaseDialog } from '@/features/knowledge/components/CreateKnowledgeBaseDialog';
import { useAuthStore } from '@/store/auth-store';

import './Repository.less';

type LibraryFile = {
  name: string;
  extension: string;
  size: string;
  date: string;
  content: string;
};

type Library = {
  id: string;
  name: string;
  description: string;
  updated: string;
  files: LibraryFile[];
};

export function Repository() {
  const sessionVersion = useAuthStore((state) => state.sessionVersion);
  return <RepositoryWorkspace key={sessionVersion} />;
}

function RepositoryWorkspace() {
  const [libraries, setLibraries] = useState<Library[]>([]);
  const [searchParams] = useSearchParams();
  const library = libraries.find((item) => item.id === searchParams.get('library'));

  function handleCreated(base: KnowledgeBase) {
    setLibraries((current) => [
      {
        id: base.id,
        name: base.title,
        description: base.description,
        updated: new Date(base.updated_at).toLocaleDateString('zh-CN'),
        files: [],
      },
      ...current,
    ]);
  }

  return (
    <section className='repository-page' aria-labelledby='repository-title'>
      {library ? (
        <LibraryDetail key={library.id} library={library} />
      ) : (
        <LibraryOverview libraries={libraries} onCreated={handleCreated} />
      )}
    </section>
  );
}

function LibraryOverview({
  libraries,
  onCreated,
}: {
  libraries: Library[];
  onCreated: (base: KnowledgeBase) => void;
}) {
  return (
    <div className='repository-content'>
      <header className='repository-header'>
        <div>
          <div className='repository-eyebrow'>
            <span>个人空间</span>
          </div>
          <h1 id='repository-title'>知识库</h1>
          <p>把资料整理好，让每一次查找都有迹可循。</p>
        </div>
        <CreateKnowledgeBaseDialog onCreated={onCreated} />
      </header>
      <div className='repository-section-label'>
        <h2>
          我的知识库 <span>{libraries.length} 个</span>
        </h2>
        <span>按主题整理，各自收纳</span>
      </div>
      {libraries.length === 0 ? (
        <div className='repository-empty' role='status'>
          <Folder size={30} strokeWidth={1.2} aria-hidden='true' />
          <h2>还没有知识库</h2>
          <p>点击“新建知识库”，开始整理你的资料。</p>
        </div>
      ) : (
        <div className='repository-libraries'>
          {libraries.map((library, index) => (
            <Link
              className='repository-library'
              key={library.id}
              to={`${routePaths.repository}?library=${library.id}`}
            >
              <span className='repository-library-top'>
                <Folder size={23} strokeWidth={1.35} aria-hidden='true' />
                <span className='repository-library-number'>0{index + 1}</span>
              </span>
              <strong>{library.name}</strong>
              <span className='repository-library-description'>{library.description}</span>
              <span className='repository-library-bottom'>
                <span>
                  {library.files.length} 个文件 <span className='repository-dot'>·</span>{' '}
                  {library.updated}
                </span>
                <ArrowUpRight size={16} aria-hidden='true' />
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function LibraryDetail({ library }: { library: Library }) {
  const [search, setSearch] = useState('');
  const [selectedFile, setSelectedFile] = useState<LibraryFile | null>(null);
  const fileButtonRef = useRef<HTMLButtonElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const visibleFiles = library.files.filter((file) =>
    `${file.name}.${file.extension}`.toLowerCase().includes(search.trim().toLowerCase()),
  );

  useEffect(() => {
    if (selectedFile) {
      closeButtonRef.current?.focus();
    }
  }, [selectedFile]);

  function closeDetails() {
    setSelectedFile(null);
    fileButtonRef.current?.focus();
  }

  return (
    <div
      className={`repository-detail-layout${selectedFile ? ' has-details' : ''}`}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && selectedFile) {
          closeDetails();
        }
      }}
    >
      <div className='repository-content repository-detail-main'>
        <nav className='repository-breadcrumb' aria-label='知识库导航'>
          <Link to={routePaths.repository}>
            <ArrowLeft size={15} aria-hidden='true' />
            全部知识库
          </Link>
          <span>/</span>
          <span aria-current='page'>{library.name}</span>
        </nav>
        <header className='repository-header'>
          <div>
            <h1 id='repository-title'>{library.name}</h1>
            <p>{library.description}</p>
          </div>
          <button
            className='repository-button repository-button-primary'
            type='button'
            disabled
            title='文件上传将在后续接入'
          >
            <Upload size={15} aria-hidden='true' />
            添加文件
          </button>
        </header>
        <div className='repository-file-toolbar'>
          <label className='repository-search'>
            <Search size={16} aria-hidden='true' />
            <input
              type='search'
              aria-label='搜索当前知识库的文件'
              placeholder='搜索文件…'
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <span className='repository-file-count'>共 {visibleFiles.length} 个文件</span>
        </div>
        {visibleFiles.length > 0 ? (
          <div className='repository-file-grid' aria-label='知识库文件'>
            {visibleFiles.map((file) => (
              <button
                className={`repository-file-card${selectedFile === file ? ' is-selected' : ''}`}
                type='button'
                key={file.name}
                title={`${file.name}.${file.extension}`}
                aria-pressed={selectedFile === file}
                aria-controls={selectedFile ? 'repository-file-details' : undefined}
                onClick={(event) => {
                  fileButtonRef.current = event.currentTarget;
                  setSelectedFile(file);
                }}
              >
                <span className={`repository-file-cover is-${file.extension}`} aria-hidden='true'>
                  <FileText size={32} strokeWidth={1.25} />
                </span>
                <span className='repository-file-label'>
                  <span className='repository-file-basename'>{file.name}</span>
                  <span className='repository-file-extension'>.{file.extension}</span>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className='repository-empty' role='status'>
            <Folder size={30} strokeWidth={1.2} aria-hidden='true' />
            <h2>{search.trim() ? '没有找到相关文件' : '还没有文件'}</h2>
            <p>
              {search.trim() ? '换个关键词，再试试看。' : '从第一份资料开始，慢慢建立你的知识库。'}
            </p>
          </div>
        )}
      </div>
      {selectedFile && (
        <aside
          className='repository-file-details'
          id='repository-file-details'
          aria-labelledby='repository-details-title'
        >
          <header className='repository-details-header'>
            <h2 id='repository-details-title'>文件详情</h2>
            <button
              ref={closeButtonRef}
              className='repository-close'
              type='button'
              aria-label='关闭文件详情'
              onClick={closeDetails}
            >
              <X size={18} aria-hidden='true' />
            </button>
          </header>
          <div className='repository-file-summary'>
            <div className={`repository-detail-symbol is-${selectedFile.extension}`}>
              <FileText size={32} strokeWidth={1.2} aria-hidden='true' />
            </div>
            <h3 className='repository-details-name'>
              {selectedFile.name}.{selectedFile.extension}
            </h3>
            <dl className='repository-file-properties'>
              <div>
                <dt>格式</dt>
                <dd>{selectedFile.extension.toUpperCase()}</dd>
              </div>
              <div>
                <dt>大小</dt>
                <dd>{selectedFile.size}</dd>
              </div>
              <div>
                <dt>添加日期</dt>
                <dd>{selectedFile.date}</dd>
              </div>
              <div>
                <dt>所属知识库</dt>
                <dd>{library.name}</dd>
              </div>
            </dl>
          </div>
          <section className='repository-file-preview' aria-labelledby='repository-preview-title'>
            <div className='repository-preview-heading'>
              <h3 id='repository-preview-title'>内容预览</h3>
            </div>
            <p>{selectedFile.content}</p>
          </section>
        </aside>
      )}
    </div>
  );
}
