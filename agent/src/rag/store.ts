import { Pool } from 'pg';
import { buildEmbeddingText } from './embedding.js';
import type { EmbeddedChunk, SearchHit } from './types.js';

const INSERT_BATCH_SIZE = 100;
export const SEARCH_LIMIT = 20;

type SearchRow = Omit<SearchHit, 'startOffset' | 'endOffset'> & {
  startOffset: number | null;
  endOffset: number | null;
};

// PostgreSQL 的 detail 可能包含整行正文；只保留可安全诊断的 SQLSTATE。
function databaseError(error: unknown): Error {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const suffix = typeof code === 'string' && /^[A-Z0-9]{5}$/.test(code) ? ` (${code})` : '';
  return new Error(`RAG database operation failed${suffix}`);
}

export function createRagStore(databaseUrl: string) {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 5,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 30_000,
  });
  // 空闲连接断开时 pg 会发出 error 事件；避免未处理事件终止 Agent。
  pool.on('error', (error) => console.error(databaseError(error).message));

  return {
    async searchChunks(userId: string, embedding: number[], signal?: AbortSignal): Promise<SearchHit[]> {
      signal?.throwIfAborted();
      let rows: SearchRow[];
      try {
        const result = await pool.query<SearchRow>(`
          SELECT c.id AS "chunkId", c.file_id AS "fileId",
            f.knowledge_base_id AS "knowledgeBaseId", f.original_name AS "fileName",
            c.section_id AS "sectionId", c.chunk_index AS "chunkIndex",
            c.content, c.heading_path AS "headingPath",
            c.start_offset AS "startOffset", c.end_offset AS "endOffset",
            c.embedding <=> $2::vector AS "cosineDistance"
          FROM rag_chunks c
          JOIN knowledge_files f ON f.id = c.file_id
          JOIN knowledge_bases b ON b.id = f.knowledge_base_id
          WHERE b.user_id = $1
          ORDER BY "cosineDistance" ASC, c.id ASC
          LIMIT ${SEARCH_LIMIT}`, [userId, JSON.stringify(embedding)]);
        rows = result.rows;
      } catch (error) {
        signal?.throwIfAborted();
        throw databaseError(error);
      }
      // pg 不直接消费 AbortSignal；进行中的 SQL 由语句超时限制，取消后不交付结果。
      signal?.throwIfAborted();
      return rows.map(({ startOffset, endOffset, ...hit }) => {
        if (!Number.isFinite(hit.cosineDistance)) {
          throw new Error('RAG search returned an invalid cosine distance');
        }
        return startOffset !== null && endOffset !== null
          ? { ...hit, startOffset, endOffset }
          : hit;
      });
    },

    async searchKeywordChunks(userId: string, query: string, signal?: AbortSignal): Promise<SearchHit[]> {
      signal?.throwIfAborted();
      let rows: SearchRow[];
      try {
        // ||| 按索引分词器处理普通文本，不把用户文本当成搜索语法。
        // 必须先限定归属再取 Top K，不能先取全库候选再过滤用户。
        const result = await pool.query<SearchRow>(`
          SELECT c.id AS "chunkId", c.file_id AS "fileId",
            f.knowledge_base_id AS "knowledgeBaseId", f.original_name AS "fileName",
            c.section_id AS "sectionId", c.chunk_index AS "chunkIndex",
            c.content, c.heading_path AS "headingPath",
            c.start_offset AS "startOffset", c.end_offset AS "endOffset",
            pdb.score(c.id) AS "bm25Score"
          FROM rag_chunks c
          JOIN knowledge_files f ON f.id = c.file_id
          JOIN knowledge_bases b ON b.id = f.knowledge_base_id
          WHERE b.user_id = $1 AND c.search_text ||| $2::text
          ORDER BY "bm25Score" DESC, c.id ASC
          LIMIT ${SEARCH_LIMIT}`, [userId, query]);
        rows = result.rows;
      } catch (error) {
        signal?.throwIfAborted();
        throw databaseError(error);
      }
      signal?.throwIfAborted();
      return rows.map(({ startOffset, endOffset, ...hit }) => {
        if (!Number.isFinite(hit.bm25Score)) throw new Error('RAG search returned an invalid BM25 score');
        return startOffset !== null && endOffset !== null
          ? { ...hit, startOffset, endOffset }
          : hit;
      });
    },

    async assertFileExists(fileId: string): Promise<void> {
      let result;
      try {
        result = await pool.query('SELECT id FROM knowledge_files WHERE id = $1', [fileId]);
      } catch (error) {
        throw databaseError(error);
      }
      if (!result.rowCount) throw new Error('RAG source file does not exist');
    },

    async replaceFileChunks(fileId: string, chunks: EmbeddedChunk[], signal?: AbortSignal): Promise<void> {
      signal?.throwIfAborted();
      if (chunks.some((chunk) => chunk.fileId !== fileId)) {
        throw new Error('RAG chunk fileId does not match the source file');
      }
      const client = await pool.connect().catch((error: unknown) => { throw databaseError(error); });
      let discardConnection = false;
      try {
        signal?.throwIfAborted();
        await client.query('BEGIN');
        // 同一文件的替换串行执行，并再次检查 Embedding 期间文件是否已被删除。
        const file = await client.query('SELECT id FROM knowledge_files WHERE id = $1 FOR UPDATE', [fileId]);
        if (!file.rowCount) throw new Error('RAG source file does not exist');
        signal?.throwIfAborted();
        await client.query('DELETE FROM rag_chunks WHERE file_id = $1', [fileId]);

        for (let start = 0; start < chunks.length; start += INSERT_BATCH_SIZE) {
          signal?.throwIfAborted();
          const values: unknown[] = [];
          const rows = chunks.slice(start, start + INSERT_BATCH_SIZE).map((chunk) => {
            const offset = values.length;
            values.push(chunk.id, fileId, chunk.sectionId, chunk.content, chunk.headingPath,
              chunk.chunkIndex, chunk.startOffset ?? null, chunk.endOffset ?? null,
              JSON.stringify(chunk.embedding), buildEmbeddingText(chunk));
            return `(${Array.from({ length: 10 }, (_, index) =>
              `$${offset + index + 1}${index === 8 ? '::vector' : ''}`).join(', ')})`;
          });
          await client.query(`INSERT INTO rag_chunks
            (id, file_id, section_id, content, heading_path, chunk_index, start_offset, end_offset, embedding, search_text)
            VALUES ${rows.join(', ')}`, values);
        }
        signal?.throwIfAborted();
        await client.query('COMMIT');
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // 回滚失败的连接不能放回池中复用。
          discardConnection = true;
        }
        throw databaseError(error);
      } finally {
        client.release(discardConnection);
      }
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };
}
