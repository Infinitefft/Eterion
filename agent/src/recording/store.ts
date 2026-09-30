import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

import type { JsonValue } from '../protocol.js';

type TerminalStatus = 'completed' | 'failed' | 'cancelled';

export interface RunStart {
  runId: string;
  userId: string;
  threadId?: string;
  modelId: string;
  question: string;
  input: JsonValue;
  startedAt: number;
}

export interface StepStart {
  runId: string;
  stepId: string;
  kind: 'model' | 'tool' | 'skill';
  name: string;
  input: JsonValue;
  metadata?: JsonValue;
  startedAt: number;
}

export interface StepEnd {
  runId: string;
  stepId: string;
  status: TerminalStatus | 'skipped';
  output?: JsonValue;
  error?: JsonValue;
  metadata?: JsonValue;
  endedAt: number;
}

export interface RunEnd {
  runId: string;
  status: TerminalStatus;
  output?: string;
  error?: JsonValue;
  endedAt: number;
}

export interface IngestionStart {
  ingestionId: string; userId: string; fileId: string; knowledgeBaseId: string;
  fileName: string; format: string; sourceText: string; startedAt: number;
}

export interface IngestionChunkSnapshot {
  chunkId: string; sectionId: string; chunkIndex: number; content: string;
  headingPath: string[]; startOffset?: number; endOffset?: number;
  embeddingText: string; budgetTokens: number; metadata: JsonValue;
}

// 读取 SQLite 时验证实际字段，避免把未知行对象直接断言成业务类型。
const jsonColumn = z.string().transform((text) => z.json().parse(JSON.parse(text)));
// SQL NULL 表示未记录，JSON 文本 "null" 表示确实返回了 null，两者不能合并。
const optionalJsonColumn = z.union([jsonColumn, z.null().transform(() => undefined)]);
const statusSchema = z.enum(['running', 'completed', 'failed', 'cancelled']);
const runRowSchema = z.object({
  run_id: z.string(), user_id: z.string(), thread_id: z.string().nullable(),
  model_id: z.string(), question: z.string(), status: statusSchema,
  input: jsonColumn, output: z.string().nullable(), error: optionalJsonColumn,
  started_at: z.number(), ended_at: z.number().nullable(),
});
const stepRowSchema = z.object({
  run_id: z.string(), step_id: z.string(), sequence: z.number(),
  kind: z.enum(['model', 'tool', 'skill']), name: z.string(),
  status: z.enum(['running', 'completed', 'failed', 'cancelled', 'skipped']),
  input: jsonColumn, output: optionalJsonColumn,
  error: optionalJsonColumn, metadata: optionalJsonColumn,
  started_at: z.number(), ended_at: z.number().nullable(),
});

const sensitiveKeys = new Set([
  'apikey', 'authorization', 'proxyauthorization', 'password', 'passwd',
  'token', 'accesstoken', 'refreshtoken', 'cookie', 'setcookie',
  'secret', 'clientsecret', 'headers', 'env', 'environment',
  'databaseurl', 'connectionstring',
]);

/**
 * 只管理独立运行数据库，不读取配置、不连接业务数据库，也不启动平台。
 * 调用方显式提供文件路径；只有 Runtime 开启记录后才创建运行数据库。
 * 写入异常由采集边界隔离，不能在存储层静默伪装成记录成功。
 */
export function openRecordStore(filePath: string, secrets: readonly string[] = []) {
  const absolutePath = resolve(filePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  const database = new DatabaseSync(absolutePath);

  try {
    database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 1000;');
    const version = database.prepare('PRAGMA user_version').get()?.['user_version'];
    if (version !== 0 && version !== 1 && version !== 2) {
      throw new Error('Unsupported run-record database version');
    }
    database.exec(`
      BEGIN;
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(run_id)) > 0),
        user_id TEXT NOT NULL CHECK (length(trim(user_id)) > 0),
        thread_id TEXT,
        model_id TEXT NOT NULL,
        question TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
        input TEXT NOT NULL,
        output TEXT,
        error TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER
      ) STRICT;
      CREATE TABLE IF NOT EXISTS steps (
        run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        step_id TEXT NOT NULL CHECK (length(trim(step_id)) > 0),
        sequence INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('model', 'tool', 'skill')),
        name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled', 'skipped')),
        input TEXT NOT NULL,
        output TEXT,
        error TEXT,
        metadata TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        PRIMARY KEY (run_id, step_id),
        UNIQUE (run_id, sequence)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS runs_user_time ON runs(user_id, started_at DESC, run_id);
      CREATE TABLE IF NOT EXISTS ingestions (
        ingestion_id TEXT PRIMARY KEY NOT NULL,
        user_id TEXT NOT NULL CHECK (length(trim(user_id)) > 0),
        file_id TEXT NOT NULL,
        knowledge_base_id TEXT NOT NULL,
        file_name TEXT NOT NULL,
        format TEXT NOT NULL CHECK (format IN ('md', 'txt')),
        source_text TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
        chunk_count INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER
      ) STRICT;
      CREATE TABLE IF NOT EXISTS ingestion_stages (
        ingestion_id TEXT NOT NULL REFERENCES ingestions(ingestion_id) ON DELETE CASCADE,
        stage_id TEXT NOT NULL,
        parent_stage TEXT,
        sequence INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
        input TEXT, output TEXT, error TEXT,
        started_at INTEGER NOT NULL, ended_at INTEGER,
        PRIMARY KEY (ingestion_id, stage_id),
        UNIQUE (ingestion_id, sequence)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS ingestion_chunks (
        ingestion_id TEXT NOT NULL REFERENCES ingestions(ingestion_id) ON DELETE CASCADE,
        chunk_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        section_id TEXT NOT NULL, chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL, heading_path TEXT NOT NULL,
        start_offset INTEGER, end_offset INTEGER,
        embedding_text TEXT NOT NULL, budget_tokens INTEGER NOT NULL, metadata TEXT NOT NULL,
        PRIMARY KEY (ingestion_id, chunk_id),
        UNIQUE (ingestion_id, sequence)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS ingestions_user_file_time
        ON ingestions(user_id, file_id, started_at DESC, ingestion_id DESC);
      PRAGMA user_version = 2;
      COMMIT;
    `);
  } catch (error) {
    database.close();
    throw error;
  }

  // 密钥只在内存用于替换，绝不作为配置快照写入文件；短前缀不能抢先遮掉长密钥。
  const knownSecrets = [...new Set(secrets.filter((value) => value.length > 0))]
    .sort((left, right) => right.length - left.length);
  function redactText(value: string): string {
    let result = value;
    for (const secret of knownSecrets) result = result.split(secret).join('[REDACTED]');
    return result.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]');
  }
  function redact(value: JsonValue): JsonValue {
    if (typeof value === 'string') return redactText(value);
    if (Array.isArray(value)) return value.map(redact);
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      sensitiveKeys.has(key.replace(/[-_\s]/g, '').toLowerCase()) ? '[REDACTED]' : redact(item),
    ]));
  }
  function encode(value: JsonValue | undefined): string | null {
    return value === undefined ? null : JSON.stringify(redact(value));
  }

  return {
    startIngestion(value: IngestionStart): void {
      database.prepare(`INSERT INTO ingestions
        (ingestion_id,user_id,file_id,knowledge_base_id,file_name,format,source_text,status,started_at)
        VALUES (?,?,?,?,?,?,?,'running',?)`).run(value.ingestionId, value.userId, value.fileId,
        value.knowledgeBaseId, redactText(value.fileName), value.format, redactText(value.sourceText), value.startedAt);
    },

    startIngestionStage(ingestionId: string, stageId: string, input: JsonValue, startedAt: number, parentStage?: string): void {
      const result = database.prepare(`INSERT INTO ingestion_stages
        (ingestion_id,stage_id,parent_stage,sequence,status,input,started_at)
        SELECT ?,?,?,COALESCE((SELECT MAX(sequence) FROM ingestion_stages WHERE ingestion_id=?),0)+1,'running',?,?
        FROM ingestions WHERE ingestion_id=? AND status='running'`).run(
        ingestionId, stageId, parentStage ?? null, ingestionId, encode(input), startedAt, ingestionId);
      if (result.changes !== 1) throw new Error('Ingestion is missing or already ended');
    },

    finishIngestionStage(ingestionId: string, stageId: string, status: TerminalStatus, endedAt: number, output?: JsonValue, error?: JsonValue): void {
      const result = database.prepare(`UPDATE ingestion_stages SET status=?,ended_at=?,output=?,error=?
        WHERE ingestion_id=? AND stage_id=? AND status='running'
        AND EXISTS (SELECT 1 FROM ingestions WHERE ingestion_id=? AND status='running')`).run(
        status, endedAt, encode(output), encode(error), ingestionId, stageId, ingestionId);
      if (result.changes !== 1) throw new Error('Ingestion stage is missing or already ended');
    },

    appendIngestionChunks(ingestionId: string, chunks: IngestionChunkSnapshot[]): void {
      database.exec('BEGIN');
      try {
        if (!database.prepare("SELECT 1 FROM ingestions WHERE ingestion_id=? AND status='running'").get(ingestionId)) {
          throw new Error('Ingestion is missing or already ended');
        }
        let sequence = Number(database.prepare('SELECT COALESCE(MAX(sequence),0) AS last FROM ingestion_chunks WHERE ingestion_id=?').get(ingestionId)?.['last']);
        const insert = database.prepare(`INSERT INTO ingestion_chunks
          (ingestion_id,chunk_id,sequence,section_id,chunk_index,content,heading_path,start_offset,end_offset,embedding_text,budget_tokens,metadata)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
        for (const chunk of chunks) {
          insert.run(ingestionId, chunk.chunkId, ++sequence, chunk.sectionId, chunk.chunkIndex,
            redactText(chunk.content), encode(chunk.headingPath), chunk.startOffset ?? null, chunk.endOffset ?? null,
            redactText(chunk.embeddingText), chunk.budgetTokens, encode(chunk.metadata));
        }
        database.prepare('UPDATE ingestions SET chunk_count=? WHERE ingestion_id=?').run(sequence, ingestionId);
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },

    finishIngestion(ingestionId: string, status: TerminalStatus, endedAt: number, error?: JsonValue): void {
      const result = database.prepare(`UPDATE ingestions SET status=?,ended_at=?,error=?
        WHERE ingestion_id=? AND status='running'`).run(status, endedAt, encode(error), ingestionId);
      if (result.changes !== 1) throw new Error('Ingestion is missing or already ended');
    },

    startRun(run: RunStart): void {
      database.prepare(`
        INSERT INTO runs (run_id, user_id, thread_id, model_id, question, status, input, started_at)
        VALUES (?, ?, ?, ?, ?, 'running', ?, ?)
      `).run(run.runId, run.userId, run.threadId ?? null, run.modelId,
        redactText(run.question), encode(run.input), run.startedAt);
    },

    startStep(step: StepStart): void {
      // 在同一条写入语句中分配顺序，只允许为仍在执行的 Run 增加步骤。
      const result = database.prepare(`
        INSERT INTO steps (run_id, step_id, sequence, kind, name, status, input, metadata, started_at)
        SELECT ?, ?, COALESCE((SELECT MAX(sequence) FROM steps WHERE run_id = ?), 0) + 1,
          ?, ?, 'running', ?, ?, ?
        FROM runs WHERE run_id = ? AND status = 'running'
      `).run(step.runId, step.stepId, step.runId, step.kind, step.name,
        encode(step.input), encode(step.metadata), step.startedAt, step.runId);
      if (result.changes !== 1) throw new Error('Run is missing or already ended');
    },

    updateStepMetadata(runId: string, stepId: string, metadata: JsonValue): void {
      const result = database.prepare(`
        UPDATE steps SET metadata = ? WHERE run_id = ? AND step_id = ? AND status = 'running'
          AND EXISTS (SELECT 1 FROM runs WHERE run_id = ? AND status = 'running')
      `).run(encode(metadata), runId, stepId, runId);
      if (result.changes !== 1) throw new Error('Step is missing or already ended');
    },

    finishStep(step: StepEnd): void {
      const result = database.prepare(`
        UPDATE steps SET status = ?, output = ?, error = ?,
          metadata = COALESCE(?, metadata), ended_at = ?
        WHERE run_id = ? AND step_id = ? AND status = 'running'
          AND EXISTS (SELECT 1 FROM runs WHERE run_id = ? AND status = 'running')
      `).run(step.status, encode(step.output), encode(step.error), encode(step.metadata),
        step.endedAt, step.runId, step.stepId, step.runId);
      if (result.changes !== 1) throw new Error('Step is missing or already ended');
    },

    finishRun(run: RunEnd): void {
      // 未收到终态的步骤继续保留 running + 空结束时间，不能凭 Run 终态猜测其成败。
      const result = database.prepare(`
        UPDATE runs SET status = ?, output = ?, error = ?, ended_at = ?
        WHERE run_id = ? AND status = 'running'
      `).run(run.status, run.output === undefined ? null : redactText(run.output),
        encode(run.error), run.endedAt, run.runId);
      if (result.changes !== 1) throw new Error('Run is missing or already ended');
    },

    getRun(runId: string) {
      // 两次读取使用同一个快照，避免并发写入导致 Run 和步骤来自不同时间点。
      database.exec('BEGIN');
      try {
        const row = database.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId);
        const result = row === undefined ? undefined : {
          ...runRowSchema.parse(row),
          steps: database.prepare('SELECT * FROM steps WHERE run_id = ? ORDER BY sequence')
            .all(runId).map((step) => stepRowSchema.parse(step)),
        };
        database.exec('COMMIT');
        return result;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },

    close(): void {
      database.close();
    },
  };
}
