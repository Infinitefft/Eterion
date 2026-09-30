import { FileText } from 'lucide-react';
import { z } from 'zod';

import type { JsonValue } from '@/service/im/types';

const sourceSchema = z.object({
  chunkId: z.uuid(),
  fileId: z.uuid(),
  knowledgeBaseId: z.uuid(),
  fileName: z.string(),
  headingPath: z.array(z.string()),
  startOffset: z.number().int().nonnegative().optional(),
  endOffset: z.number().int().positive().optional(),
});

export function getKnowledgeSources(result: JsonValue | null) {
  const parsed = z.object({ results: z.array(sourceSchema) }).safeParse(result);
  return parsed.success ? parsed.data.results : [];
}

export type KnowledgeSource = ReturnType<typeof getKnowledgeSources>[number];

export function KnowledgeSources({ sources, onOpenSource }: {
  sources: KnowledgeSource[];
  onOpenSource?: (source: KnowledgeSource) => void;
}) {
  return <ul className='chat-tool-sources' aria-label='引用的文件片段'>
    {sources.map((source) => (
      <li key={source.chunkId}>
        <button type='button' onClick={() => onOpenSource?.(source)} disabled={!onOpenSource}>
          <FileText size={15} aria-hidden='true' />
          <span>
            <strong>{source.fileName}</strong>
            {source.headingPath.length > 0 && <small>{source.headingPath.join(' / ')}</small>}
            {(source.startOffset === undefined || source.endOffset === undefined)
              && <small>此片段暂无精确位置</small>}
          </span>
        </button>
      </li>
    ))}
  </ul>;
}
