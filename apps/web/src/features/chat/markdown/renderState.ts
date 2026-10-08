import { StreamingMarkdownParser } from './streamingParser';

export interface MarkdownRenderState {
  readonly content: string;
  readonly streaming: boolean;
  readonly parser: StreamingMarkdownParser;
}

/** 普通追加只解析新后缀；快照改写、截短或终态后续写需要重建。 */
export function updateMarkdownRenderState(
  previous: MarkdownRenderState | null,
  content: string,
  streaming: boolean,
): MarkdownRenderState {
  if (previous?.content === content && previous.streaming === streaming) return previous;

  const canAppend = previous !== null && previous.streaming && content.startsWith(previous.content);
  const parser = canAppend ? previous.parser.clone() : new StreamingMarkdownParser();
  parser.push(canAppend ? content.slice(previous.content.length) : content);
  if (!streaming) parser.finish();

  return { content, streaming, parser };
}
