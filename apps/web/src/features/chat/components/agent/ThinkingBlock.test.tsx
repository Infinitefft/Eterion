import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { getAssistantContentParts } from '@/features/chat/model/chatSelectors';
import type { ThinkingBlockState } from '@/service/im/types';
import { useIMStore } from '@/store/im-store';

import { ThinkingBlock } from './ThinkingBlock';

const thought: ThinkingBlockState = {
  kind: 'thinking', id: 'thinking-1', runId: 'run-1', threadId: 'thread-1',
  status: 'streaming', content: 'first\nsecond', contentOffset: 3,
};

describe('thinking presentation', () => {
  it('opens active thinking and collapses history while retaining escaped content', () => {
    expect(renderToStaticMarkup(<ThinkingBlock block={thought} />)).toContain('aria-expanded="true"');
    const html = renderToStaticMarkup(<ThinkingBlock block={{ ...thought, status: 'cancelled', content: '<script>unsafe</script>' }} />);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('思考已停止');
    expect(html).toContain('&lt;script&gt;');
  });

  it('keeps UTF-16 positions and stable order shared by thinking and tools', () => {
    const parts = getAssistantContentParts('中😀回答', [thought, {
      kind: 'tool', id: 'tool-1', runId: 'run-1', threadId: 'thread-1',
      name: 'web_search', displayName: null, args: null, summary: null, result: null,
      error: null, status: 'completed', contentOffset: 3,
    }]);
    expect(parts.map((part) => part.kind === 'text' ? part.content : part.blocks.map((block) => block.id)))
      .toEqual(['中😀', ['thinking-1', 'tool-1'], '回答']);
  });

  it('merges terminal thinking without moving its original position', () => {
    useIMStore.getState().reset();
    const envelope = { threadId: 'thread-1', runId: 'run-1', thinkingId: 'thinking-1', timestamp: 1 };
    useIMStore.getState().applyEnvelope({ ...envelope, type: 'thinking.delta', seqId: 1, payload: { delta: 'partial', contentOffset: 3 } });
    useIMStore.getState().applyEnvelope({ ...envelope, type: 'thinking.completed', seqId: 2, payload: { content: 'partial', status: 'failed', contentOffset: 9 } });
    expect(useIMStore.getState().detailsByThread['thread-1']?.blocks[0])
      .toMatchObject({ status: 'failed', content: 'partial', contentOffset: 3 });
    useIMStore.getState().reset();
  });
});
