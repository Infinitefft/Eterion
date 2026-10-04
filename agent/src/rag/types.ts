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

export interface EmbeddedChunk extends RagChunk {
  embedding: number[];
}

export interface IngestionResult {
  fileId: string;
  chunkCount: number;
}

export interface RagConfig {
  rerank?: RerankConfig;
  apiKey: string;
  baseUrl: string;
  model: string;
  dimensions: number;
  databaseUrl: string;
}

export interface RerankConfig {
  apiKey: string;
  url: string;
  threshold: number;
}

export interface SearchInput {
  // 必须来自可信服务端身份，不能取自模型生成的工具参数。
  userId: string;
  query: string;
}

export interface SearchHit {
  chunkId: string;
  fileId: string;
  knowledgeBaseId: string;
  fileName: string;
  sectionId: string;
  chunkIndex: number;
  content: string;
  headingPath: string[];
  startOffset?: number;
  endOffset?: number;
  // 余弦距离越小越接近，不是置信度。
  cosineDistance: number;
  rerankScore?: number;
}
