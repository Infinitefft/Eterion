import { Pool } from 'pg';
import type { EmbeddedChunk } from './types.js';

const INSERT_BATCH_SIZE = 100;

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
              JSON.stringify(chunk.embedding));
            return `(${Array.from({ length: 9 }, (_, index) =>
              `$${offset + index + 1}${index === 8 ? '::vector' : ''}`).join(', ')})`;
          });
          await client.query(`INSERT INTO rag_chunks
            (id, file_id, section_id, content, heading_path, chunk_index, start_offset, end_offset, embedding)
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
