import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { getKnowledgeFileContent } from '@/api/knowledge';
import { useAuthStore } from '@/store/auth-store';

import type { KnowledgeSource } from './KnowledgeSources';

import '@/features/knowledge/components/FilePreview.less';

interface MarkdownNode {
  type: string;
  value?: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MarkdownNode[];
  data?: { hName?: string };
}

function highlightMarkdown(text: string, start: number, end: number) {
  return () => (tree: unknown) => {
    function walk(node: MarkdownNode) {
      if (!node.children) return;
      node.children = node.children.flatMap((child) => {
        if (child.type !== 'text' || child.value === undefined) {
          walk(child);
          return [child];
        }
        const from = child.position?.start.offset;
        const to = child.position?.end.offset;
        if (from === undefined || to === undefined || from >= end || to <= start) return [child];
        // 转义符或实体可能使源码长度与渲染文本不同；此时高亮整个文本节点。
        if (text.slice(from, to) !== child.value) {
          return [{ type: 'strong', data: { hName: 'mark' }, children: [child] }];
        }
        const hitStart = Math.max(start, from) - from;
        const hitEnd = Math.min(end, to) - from;
        return [
          ...(hitStart > 0 ? [{ type: 'text', value: child.value.slice(0, hitStart) }] : []),
          { type: 'strong', data: { hName: 'mark' }, children: [{ type: 'text', value: child.value.slice(hitStart, hitEnd) }] },
          ...(hitEnd < child.value.length ? [{ type: 'text', value: child.value.slice(hitEnd) }] : []),
        ];
      });
    }
    walk(tree as MarkdownNode);
  };
}

export function KnowledgeSourcePanel({ source, onClose }: {
  source: KnowledgeSource;
  onClose: () => void;
}) {
  const sessionVersion = useAuthStore((state) => state.sessionVersion);
  const highlightRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const query = useQuery({
    queryKey: ['knowledge-file-content', sessionVersion, source.knowledgeBaseId, source.fileId, true],
    queryFn: ({ signal }) => getKnowledgeFileContent(source.knowledgeBaseId, source.fileId, signal, true),
    retry: false,
    gcTime: 0,
  });

  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (query.isSuccess) highlightRef.current?.scrollIntoView({ block: 'center' });
  }, [query.isSuccess, query.data?.content, source.chunkId]);

  const content = query.data?.content;
  const start = source.startOffset;
  const end = source.endOffset;
  // 入库偏移量是原文 UTF-16 坐标；source=1 返回未经 BOM/换行归一化的原文。
  const hasRange = content !== undefined && start !== undefined && end !== undefined
    && Number.isSafeInteger(start) && Number.isSafeInteger(end)
    && start >= 0 && start < end && end <= content.length;
  const bomLength = content?.startsWith('\uFEFF') ? 1 : 0;
  const markdownContent = content?.slice(bomLength);
  const markdownStart = start === undefined ? undefined : Math.max(0, start - bomLength);
  const markdownEnd = end === undefined ? undefined : Math.max(0, end - bomLength);

  return (
    <aside className='chat-source-panel' aria-label={`文件来源：${source.fileName}`}>
      <div className='chat-source-panel-header'>
        <h2 title={source.fileName}>{source.fileName}</h2>
        <button ref={closeRef} type='button' aria-label='关闭文件来源' onClick={onClose}>
          <X size={20} aria-hidden='true' />
        </button>
      </div>
      <div className='chat-source-panel-content'>
        {query.isPending ? <p role='status'>正在读取文件内容…</p>
          : query.isError ? <p role='alert'>文件已删除或暂时无法读取，请稍后重试。</p>
            : content === '' ? <p>文件内容为空。</p>
              : <>
                {!hasRange && <p role='status'>此片段没有可靠的原文位置，无法精确高亮。</p>}
                {query.data?.format === 'md' ? (
                  <div className='knowledge-markdown-preview chat-source-markdown'>
                    <Markdown
                      remarkPlugins={hasRange ? [remarkGfm, highlightMarkdown(markdownContent!, markdownStart!, markdownEnd!)] : [remarkGfm]}
                      skipHtml
                      components={{
                        mark: ({ children }) => <mark ref={highlightRef}>{children}</mark>,
                        code: ({ node, children, ...props }) => {
                          const from = node?.position?.start.offset;
                          const to = node?.position?.end.offset;
                          const hit = hasRange && from !== undefined && to !== undefined
                            && from < markdownEnd! && to > markdownStart!;
                          return <code {...props}>{hit ? <mark ref={highlightRef}>{children}</mark> : children}</code>;
                        },
                        img: ({ alt }) => <span>[图片：{alt || '未加载'}]</span>,
                      }}
                    >{markdownContent}</Markdown>
                  </div>
                ) : <pre>{hasRange ? <>
                  {content?.slice(0, start)}
                  <mark ref={highlightRef}>{content?.slice(start, end)}</mark>
                  {content?.slice(end)}
                </> : content}</pre>}
              </>}
      </div>
    </aside>
  );
}
