import { MarkdownBlockParser } from './blockParser';

import type { MarkdownBlockNode } from './ast';

/** React 每次只需要观察稳定数组和一个活动尾块。 */
export interface StreamingMarkdownSnapshot {
  readonly stableBlocks: readonly MarkdownBlockNode[];
  readonly activeBlock: MarkdownBlockNode | null;
}

/**
 * 把任意大小的 message.delta 组装成完整逻辑行，再交给块级解析器。
 *
 * stableBlocks 采用 append-only：没有新稳定块时沿用同一个数组引用；
 * activeBlock 独立更新，因此后续 React.memo 可以跳过全部历史稳定块。
 */
export class StreamingMarkdownParser {
  private readonly blockParser = new MarkdownBlockParser();

  private stableBlocks: readonly MarkdownBlockNode[] = [];

  /** 尚未遇到 \n 的尾行，也是唯一会随 chunk 增长的字符串缓存。 */
  private buffer = '';

  /** buffer 第一个 UTF-16 code unit 在完整原始 Markdown 中的 offset。 */
  private bufferStartOffset = 0;

  private finished = false;

  private snapshot: StreamingMarkdownSnapshot = {
    stableBlocks: this.stableBlocks,
    activeBlock: null,
  };

  /** 返回最近一次 push/finish 生成的只读快照。 */
  getSnapshot(): StreamingMarkdownSnapshot {
    return this.snapshot;
  }

  /**
   * 追加一段任意分片位置的 Markdown。
   * 空 chunk 是无操作；反引号、**、链接和换行都允许跨 chunk。
   */
  push(chunk: string): StreamingMarkdownSnapshot {
    if (this.finished) {
      throw new Error('StreamingMarkdownParser 已经 finish，不能继续 push');
    }

    if (!chunk) {
      return this.snapshot;
    }

    this.buffer += chunk;
    this.consumeCompleteLines();
    this.refreshSnapshot();
    return this.snapshot;
  }

  /**
   * 消息流结束时消费最后一条未换行文本，并强制稳定所有活动内容。
   * 重复调用 finish 是安全的，并返回同一个最终快照。
   */
  finish(): StreamingMarkdownSnapshot {
    if (this.finished) {
      return this.snapshot;
    }

    const finalBlocks: MarkdownBlockNode[] = [];

    if (this.buffer.length > 0) {
      finalBlocks.push(
        ...this.blockParser.pushLine(normalizeLogicalLine(this.buffer), this.bufferStartOffset),
      );
      this.bufferStartOffset += this.buffer.length;
      this.buffer = '';
    }

    finalBlocks.push(...this.blockParser.finish());
    this.appendStableBlocks(finalBlocks);
    this.finished = true;
    this.snapshot = {
      stableBlocks: this.stableBlocks,
      activeBlock: null,
    };
    return this.snapshot;
  }

  /** 一次扫描当前 buffer，避免对包含很多行的大 chunk 反复从头 split/slice。 */
  private consumeCompleteLines(): void {
    const newStableBlocks: MarkdownBlockNode[] = [];
    let lineStartIndex = 0;
    let newlineIndex = this.buffer.indexOf('\n');

    while (newlineIndex !== -1) {
      const rawLine = this.buffer.slice(lineStartIndex, newlineIndex);
      const lineStartOffset = this.bufferStartOffset + lineStartIndex;

      newStableBlocks.push(
        ...this.blockParser.pushLine(normalizeLogicalLine(rawLine), lineStartOffset),
      );

      lineStartIndex = newlineIndex + 1;
      newlineIndex = this.buffer.indexOf('\n', lineStartIndex);
    }

    if (lineStartIndex > 0) {
      this.buffer = this.buffer.slice(lineStartIndex);
      this.bufferStartOffset += lineStartIndex;
    }

    this.appendStableBlocks(newStableBlocks);
  }

  /** 只有真正新增稳定块时才创建新数组，旧 Block 对象引用永远不变。 */
  private appendStableBlocks(blocks: readonly MarkdownBlockNode[]): void {
    if (blocks.length > 0) {
      this.stableBlocks = [...this.stableBlocks, ...blocks];
    }
  }

  /** buffer 虽未形成完整行，也必须参与活动预览，保证长段落能够逐 chunk 显示。 */
  private refreshSnapshot(): void {
    const activeBlock =
      this.buffer.length > 0
        ? this.blockParser.previewLine(normalizeLogicalLine(this.buffer), this.bufferStartOffset)
        : this.blockParser.getActiveBlock();

    this.snapshot = {
      stableBlocks: this.stableBlocks,
      activeBlock,
    };
  }
}

/** CRLF 的 \r 不属于行内容，但 offset 仍由上层按原始两个 code unit 计算。 */
function normalizeLogicalLine(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}
