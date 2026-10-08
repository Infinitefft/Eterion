import { common, createLowlight } from 'lowlight';
import { Fragment, memo, useState, type ReactNode } from 'react';

import type { MarkdownBlockNode, MarkdownInlineNode } from '../markdown/ast';
import { updateMarkdownRenderState } from '../markdown/renderState';

const highlighter = createLowlight(common);

function renderInline(nodes: readonly MarkdownInlineNode[]): ReactNode {
  return nodes.map((node, index) => {
    switch (node.type) {
      case 'text': return node.value;
      case 'inlineCode': return <code key={index}>{node.value}</code>;
      case 'strong': return <strong key={index}>{renderInline(node.children)}</strong>;
      case 'link': return <a key={index} href={node.href}>{renderInline(node.children)}</a>;
    }
  });
}

function renderHighlight(nodes: ReturnType<typeof highlighter.highlight>['children']): ReactNode {
  return nodes.map((node, index) => {
    if (node.type === 'text') return node.value;
    if (node.type !== 'element') return null;
    const classes = node.properties.className;
    return <span key={index} className={Array.isArray(classes) ? classes.join(' ') : undefined}>
      {renderHighlight(node.children)}
    </span>;
  });
}

const MarkdownBlock = memo(function MarkdownBlock({ block }: { block: MarkdownBlockNode }) {
  switch (block.type) {
    case 'paragraph': return <p>{renderInline(block.children)}</p>;
    case 'heading': {
      const Tag = `h${block.level}` as const;
      return <Tag>{renderInline(block.children)}</Tag>;
    }
    case 'blockquote': return <blockquote><p>{renderInline(block.children)}</p></blockquote>;
    case 'list': {
      const items = block.items.map((item, index) => <li key={index}>{renderInline(item.children)}</li>);
      return block.ordered ? <ol start={block.start ?? undefined}>{items}</ol> : <ul>{items}</ul>;
    }
    case 'code': {
      const language = block.language?.toLowerCase();
      const highlighted = language && highlighter.registered(language);
      const className = [highlighted ? 'hljs' : '', block.language ? `language-${block.language}` : '']
        .filter(Boolean).join(' ') || undefined;
      return <pre><code className={className}>
        {highlighted ? renderHighlight(highlighter.highlight(language, block.value).children) : block.value}
      </code></pre>;
    }
  }
});

const StableBlocks = memo(function StableBlocks({ blocks }: { blocks: readonly MarkdownBlockNode[] }) {
  return blocks.map((block) => <MarkdownBlock key={block.id} block={block} />);
});

/** 每个正文片段独立持有解析状态；稳定块不重新解析，也不重复执行语法高亮。 */
export const StreamingMarkdown = memo(function StreamingMarkdown({ content, streaming = false }: {
  content: string;
  streaming?: boolean;
}) {
  const [state, setState] = useState(() => updateMarkdownRenderState(null, content, streaming));
  let current = state;
  if (state.content !== content || state.streaming !== streaming) {
    // 同组件派生状态在本次提交前更新；clone 保证被丢弃的渲染不会污染前一个版本。
    current = updateMarkdownRenderState(state, content, streaming);
    setState(current);
  }
  const snapshot = current.parser.getSnapshot();
  return <Fragment>
    <StableBlocks blocks={snapshot.stableBlocks} />
    {snapshot.activeBlock && <MarkdownBlock key={snapshot.activeBlock.id} block={snapshot.activeBlock} />}
  </Fragment>;
});
