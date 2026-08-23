/**
 * 不同 Provider 的 chunk 形状可能不同，这里只抽取正式 Content。
 * reasoning/tool-call block 不能误混进前端正式回复。
 */
export function extractContentDelta(chunk: unknown): string {
  if (!isRecord(chunk)) return '';

  if (typeof chunk.text === 'string' && chunk.text) {
    return chunk.text;
  }

  const content = chunk.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .filter(isRecord)
    .filter((block) => block.type === 'text' || block.type === 'output_text')
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .join('');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
