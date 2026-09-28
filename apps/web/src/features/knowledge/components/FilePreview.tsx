import { useQuery } from '@tanstack/react-query';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { getApiError } from '@/api/errors';
import { getKnowledgeFileContent } from '@/api/knowledge';
import { useAuthStore } from '@/store/auth-store';

import './FilePreview.less';

export function FilePreview({ baseId, fileId }: { baseId: string; fileId: string }) {
  const sessionVersion = useAuthStore((state) => state.sessionVersion);
  const query = useQuery({
    queryKey: ['knowledge-file-content', sessionVersion, baseId, fileId],
    queryFn: ({ signal }) => getKnowledgeFileContent(baseId, fileId, signal),
    retry: false,
    gcTime: 0,
  });
  if (query.isPending) return <p role='status'>正在读取文件内容…</p>;
  if (query.isError)
    return (
      <div role='alert'>
        <p>{getApiError(query.error)?.message ?? '内容加载失败，请重试。'}</p>
        <button
          className='repository-button'
          type='button'
          onClick={() => {
            void query.refetch();
          }}
        >
          重试
        </button>
      </div>
    );
  if (!query.data.content) return <p>文件内容为空。</p>;
  if (query.data.format === 'txt')
    return <pre className='knowledge-text-preview'>{query.data.content}</pre>;
  return (
    <div className='knowledge-markdown-preview'>
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{ img: ({ alt }) => <span>[图片：{alt || '未加载'}]</span> }}
      >
        {query.data.content}
      </Markdown>
    </div>
  );
}
