export interface MarkdownSection {
  id: string;
  content: string;
  headingPath: string[];
  // 相对于输入原文的 UTF-16 左闭右开范围，content 与原文切片一致。
  startOffset: number;
  endOffset: number;
}

export interface RagChunk {
  id: string;
  fileId: string;
  sectionId: string;
  content: string;
  headingPath: string[];
  chunkIndex: number;
  // 仅在来源位置唯一时成对提供，不用猜测位置支持高亮。
  startOffset?: number;
  endOffset?: number;
}

export interface PrepareChunksInput {
  fileId: string;
  format: 'md' | 'txt';
  text: string;
}
