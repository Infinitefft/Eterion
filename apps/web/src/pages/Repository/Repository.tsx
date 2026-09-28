import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowUp, ArrowUpRight, FileText, Folder, Search, X } from 'lucide-react';
import { Toast } from 'radix-ui';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useSearchParams } from 'react-router-dom';

import type { KnowledgeBase, KnowledgeFile } from '@/api/knowledge';
import { listKnowledgeBases, listKnowledgeFiles } from '@/api/knowledge';
import { routePaths } from '@/app/routePaths';
import { CreateKnowledgeBaseDialog } from '@/features/knowledge/components/CreateKnowledgeBaseDialog';
import { FileActions } from '@/features/knowledge/components/FileActions';
import { FilePreview } from '@/features/knowledge/components/FilePreview';
import { LibraryActions } from '@/features/knowledge/components/LibraryActions';
import { UploadFilesDialog } from '@/features/knowledge/components/UploadFilesDialog';
import { useAuthStore } from '@/store/auth-store';

import './Repository.less';

type LibraryFile = {
  id: string;
  name: string;
  extension: string;
  size: string;
  date: string;
};

type Library = {
  id: string;
  name: string;
  description: string;
  updated: string;
  fileCount: number;
};

export function Repository() {
  const sessionVersion = useAuthStore((state) => state.sessionVersion);
  return <RepositoryWorkspace key={sessionVersion} />;
}

function RepositoryWorkspace() {
  const user = useAuthStore((state) => state.user);
  const sessionVersion = useAuthStore((state) => state.sessionVersion);
  const bootstrapStatus = useAuthStore((state) => state.bootstrapStatus);
  const queryClient = useQueryClient();
  const queryKey = ['knowledge-bases', sessionVersion];
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => listKnowledgeBases(signal),
    enabled: Boolean(user),
    gcTime: 0,
    retry: false,
  });
  const libraries: Library[] = (query.data ?? []).map((base) => ({
    id: base.id,
    name: base.title,
    description: base.description,
    updated: new Date(base.updated_at).toLocaleDateString('zh-CN'),
    fileCount: base.file_count,
  }));
  const [searchParams] = useSearchParams();
  const library = libraries.find((item) => item.id === searchParams.get('library'));

  function handleCreated() {
    void queryClient.invalidateQueries({ queryKey });
  }

  let statusMessage = '';
  if (bootstrapStatus === 'pending' || (user && query.isPending)) {
    statusMessage = '正在加载知识库…';
  } else if (!user) {
    statusMessage = '请先通过左侧账户入口登录，以查看你的知识库。';
  } else if (query.isError) {
    statusMessage = '知识库加载失败，请重试。';
  }

  return (
    <section className='repository-page' aria-labelledby='repository-title'>
      {library && !statusMessage ? (
        <LibraryDetail key={library.id} library={library} />
      ) : (
        <LibraryOverview
          libraries={libraries}
          onCreated={handleCreated}
          statusMessage={statusMessage}
          onRetry={
            query.isError
              ? () => {
                  void query.refetch();
                }
              : undefined
          }
        />
      )}
    </section>
  );
}

function LibraryOverview({
  libraries,
  onCreated,
  statusMessage,
  onRetry,
}: {
  libraries: Library[];
  onCreated: (base: KnowledgeBase) => void;
  statusMessage: string;
  onRetry?: () => void;
}) {
  const queryClient = useQueryClient();
  const sessionVersion = useAuthStore((state) => state.sessionVersion);
  const [deletedId, setDeletedId] = useState<string | null>(null);
  function handleDeleted(id: string) {
    setDeletedId(id);
    const queryKey = ['knowledge-bases', sessionVersion];
    void queryClient.cancelQueries({ queryKey }).then(() => {
      queryClient.setQueryData<KnowledgeBase[]>(queryKey, (current = []) =>
        current.filter((base) => base.id !== id),
      );
      void queryClient.invalidateQueries({ queryKey });
    });
    queryClient.removeQueries({ queryKey: ['knowledge-files', sessionVersion, id] });
    queryClient.removeQueries({ queryKey: ['knowledge-file-content', sessionVersion, id] });
  }
  return (
    <div className='repository-content'>
      <header className='repository-header'>
        <div>
          <h1 id='repository-title'>知识库</h1>
          <p>把资料整理好，让每一次查找都有迹可循。</p>
        </div>
        <CreateKnowledgeBaseDialog onCreated={onCreated} />
      </header>
      <div className='repository-section-label'>
        <h2>我的知识库 {!statusMessage && <span>{libraries.length} 个</span>}</h2>
        <span>按主题整理，各自收纳</span>
      </div>
      {statusMessage ? (
        <div className='repository-empty' role='status'>
          <p>{statusMessage}</p>
          {onRetry && (
            <button className='repository-button' type='button' onClick={onRetry}>
              重试
            </button>
          )}
        </div>
      ) : libraries.length === 0 ? (
        <div className='repository-empty' role='status'>
          <Folder size={30} strokeWidth={1.2} aria-hidden='true' />
          <h2>还没有知识库</h2>
          <p>点击“新建知识库”，开始整理你的资料。</p>
        </div>
      ) : (
        <div className='repository-libraries'>
          {libraries.map((library) => (
            <div className='repository-library-item' key={library.id}>
              <Link
                className='repository-library'
                to={`${routePaths.repository}?library=${library.id}`}
              >
                <span className='repository-library-top'>
                  <Folder size={23} strokeWidth={1.35} aria-hidden='true' />
                </span>
                <strong>{library.name}</strong>
                <span className='repository-library-description'>{library.description}</span>
                <span className='repository-library-bottom'>
                  <span>
                    {library.fileCount} 个文件 <span className='repository-dot'>·</span>{' '}
                    {library.updated}
                  </span>
                  <ArrowUpRight size={16} aria-hidden='true' />
                </span>
              </Link>
              <LibraryActions
                baseId={library.id}
                baseName={library.name}
                onDeleted={handleDeleted}
              />
            </div>
          ))}
        </div>
      )}
      <DeletionToast deletedId={deletedId} setDeletedId={setDeletedId} />
    </div>
  );
}

function LibraryDetail({ library }: { library: Library }) {
  const sessionVersion = useAuthStore((state) => state.sessionVersion);
  const queryClient = useQueryClient();
  const queryKey = ['knowledge-files', sessionVersion, library.id];
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => listKnowledgeFiles(library.id, signal),
    retry: false,
    gcTime: 0,
  });
  const files: LibraryFile[] = (query.data ?? []).map((file) => {
    const dot = file.original_name.lastIndexOf('.');
    return {
      id: file.id,
      name: file.original_name.slice(0, dot),
      extension: file.original_name.slice(dot + 1),
      size:
        file.size_bytes < 1024 * 1024
          ? `${Math.ceil(file.size_bytes / 1024)} KB`
          : `${(file.size_bytes / 1024 / 1024).toFixed(1)} MB`,
      date: new Date(file.created_at).toLocaleDateString('zh-CN'),
    };
  });
  function handleUploaded(file: KnowledgeFile) {
    void queryClient.cancelQueries({ queryKey }).then(() => {
      queryClient.setQueryData<KnowledgeFile[]>(queryKey, (current = []) => [
        file,
        ...current.filter((item) => item.id !== file.id),
      ]);
      void queryClient.invalidateQueries({ queryKey });
    });
    void queryClient.invalidateQueries({ queryKey: ['knowledge-bases', sessionVersion] });
  }
  const [search, setSearch] = useState('');
  const [deletedFileId, setDeletedFileId] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<LibraryFile | null>(null);
  const [scrolledFileId, setScrolledFileId] = useState<string | null>(null);
  const detailsRef = useRef<HTMLElement | null>(null);
  const fileButtonRef = useRef<HTMLButtonElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const visibleFiles = files.filter((file) =>
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

  function handleDeleted(fileId: string) {
    setDeletedFileId(fileId);
    if (selectedFile?.id === fileId) setSelectedFile(null);
    void queryClient.cancelQueries({ queryKey }).then(() => {
      queryClient.setQueryData<KnowledgeFile[]>(queryKey, (current = []) =>
        current.filter((file) => file.id !== fileId),
      );
      void queryClient.invalidateQueries({ queryKey });
    });
    queryClient.removeQueries({
      queryKey: ['knowledge-file-content', sessionVersion, library.id, fileId],
    });
    void queryClient.invalidateQueries({ queryKey: ['knowledge-bases', sessionVersion] });
    document.querySelector<HTMLInputElement>('.repository-search input')?.focus();
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
          <div className='repository-header-action'>
            <UploadFilesDialog
              libraryName={library.name}
              libraryId={library.id}
              onUploaded={handleUploaded}
            />
          </div>
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
          <span className='repository-file-count'>
            {query.isPending ? '加载中…' : `共 ${visibleFiles.length} 个文件`}
          </span>
        </div>
        {query.isPending || query.isError ? (
          <div className='repository-empty' role='status'>
            <p>{query.isPending ? '正在加载文件…' : '文件加载失败，请重试。'}</p>
            {query.isError && (
              <button
                className='repository-button'
                type='button'
                onClick={() => {
                  void query.refetch();
                }}
              >
                重试
              </button>
            )}
          </div>
        ) : visibleFiles.length > 0 ? (
          <div className='repository-file-grid' aria-label='知识库文件'>
            {visibleFiles.map((file) => (
              <div className='repository-file-item' key={file.id}>
                <button
                  className={`repository-file-card${selectedFile?.id === file.id ? ' is-selected' : ''}`}
                  type='button'
                  title={`${file.name}.${file.extension}`}
                  aria-pressed={selectedFile?.id === file.id}
                  aria-controls={selectedFile ? 'repository-file-details' : undefined}
                  onClick={(event) => {
                    fileButtonRef.current = event.currentTarget;
                    setScrolledFileId(null);
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
                <FileActions
                  baseId={library.id}
                  fileId={file.id}
                  fileName={`${file.name}.${file.extension}`}
                  onDeleted={handleDeleted}
                />
              </div>
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
          key={selectedFile.id}
          ref={detailsRef}
          className='repository-file-details'
          id='repository-file-details'
          aria-labelledby='repository-details-title'
          onScroll={(event) => {
            setScrolledFileId(event.currentTarget.scrollTop > 160 ? selectedFile.id : null);
          }}
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
            <FilePreview key={selectedFile.id} baseId={library.id} fileId={selectedFile.id} />
          </section>
          {scrolledFileId === selectedFile.id && (
            <button
              className='repository-back-to-top'
              type='button'
              aria-label='回到文件预览顶部'
              title='回到顶部'
              onClick={() => {
                detailsRef.current?.scrollTo({
                  top: 0,
                  behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
                    ? 'instant'
                    : 'smooth',
                });
              }}
            >
              <ArrowUp size={18} aria-hidden='true' />
            </button>
          )}
        </aside>
      )}
      <DeletionToast deletedId={deletedFileId} setDeletedId={setDeletedFileId} />
    </div>
  );
}

function DeletionToast({
  deletedId,
  setDeletedId,
}: {
  deletedId: string | null;
  setDeletedId: (id: string | null) => void;
}) {
  return (
    <Toast.Provider duration={3000}>
      {createPortal(
        <>
          <Toast.Root
            key={deletedId}
            className='knowledge-upload-toast'
            open={deletedId !== null}
            onOpenChange={(open) => {
              if (!open) setDeletedId(null);
            }}
          >
            <Toast.Description>删除成功</Toast.Description>
            <Toast.Close aria-label='关闭提示'>
              <X size={16} />
            </Toast.Close>
          </Toast.Root>
          <Toast.Viewport className='knowledge-upload-toast-viewport' />
        </>,
        document.body,
      )}
    </Toast.Provider>
  );
}
