import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { validateRagConfig } from '../config.js';
import { CHUNKING_RULES, prepareChunks } from './chunking.js';
import { embedChunks } from '../embedding.js';
import { createRagStore } from '../store.js';
import type { IngestionResult, PrepareChunksInput, RagConfig } from '../types.js';
import type { Settings } from '../../config.js';
// 监控采集：可选观察器由记录模块隔离异常；记录失败不影响业务执行。
import { beginIngestionRecording, type IngestionRecording } from '../../recording/ingestion.js';

const inputSchema = z.object({ fileId: z.uuid(), format: z.enum(['md', 'txt']), text: z.string() });

export function createRagIngestor(config: RagConfig | undefined) {
  const settings = validateRagConfig(config);
  const store = createRagStore(settings.databaseUrl);
  return {
    async ingestFile(input: PrepareChunksInput, parentSignal?: AbortSignal, recording?: IngestionRecording): Promise<IngestionResult> {
      const timeout = AbortSignal.timeout(10 * 60_000);
      const signal = parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout;
      // 监控采集：阶段调用仅观察现有业务顺序；记录失败不影响业务执行。
      try {
        recording?.startStage('file_check');
        signal.throwIfAborted();
        if (!z.uuid().safeParse(input.fileId).success) throw new Error('RAG fileId must be a UUID');
        await store.assertFileExists(input.fileId);
        signal.throwIfAborted();
        recording?.finishStage('file_check');
        recording?.startStage('chunking', { ...CHUNKING_RULES, format: input.format });
        const chunks = await prepareChunks(input, signal, recording);
        recording?.finishStage('chunking', { chunkCount: chunks.length });
        recording?.startStage('embedding', { model: settings.model, dimensions: settings.dimensions, chunkCount: chunks.length });
        // 所有外部请求完成后再开启写入事务，模型失败不会改变已有索引。
        const embedded = await embedChunks(chunks, settings, signal, recording);
        signal.throwIfAborted();
        recording?.finishStage('embedding', { chunkCount: embedded.length });
        recording?.startStage('storage', { operation: 'replace_file_chunks', chunkCount: embedded.length });
        await store.replaceFileChunks(input.fileId, embedded, signal);
        recording?.finishStage('storage', { committed: true, chunkCount: embedded.length });
        return { fileId: input.fileId, chunkCount: embedded.length };
      } catch (error) {
        // 监控采集：保存原业务错误并原样抛出；记录失败不影响业务执行。
        recording?.fail(error, signal.aborted);
        throw error;
      }
    },
    close: store.close,
  };
}

export function registerRagRoutes(app: FastifyInstance, config: RagConfig | undefined, recordingSettings?: Settings): void {
  let ingestor: ReturnType<typeof createRagIngestor> | undefined;
  app.addHook('onClose', async () => { await ingestor?.close(); });

  // 与 /runs 一样只供可信的 Go 服务调用，浏览器必须走 Go 的鉴权上传入口。
  app.post('/rag/ingest', { bodyLimit: 128 * 1024 * 1024 }, async (request, reply) => {
    const parsed = inputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'INVALID_RAG_INPUT', message: '入库参数不合法' } });
    }
    if (Buffer.byteLength(parsed.data.text, 'utf8') > 20 * 1024 * 1024) {
      return reply.code(413).send({ error: { code: 'RAG_TEXT_TOO_LARGE', message: '文件不能超过 20 MiB' } });
    }
    const controller = new AbortController();
    const onClose = () => { if (!reply.raw.writableEnded) controller.abort(); };
    reply.raw.once('close', onClose);
    // 监控采集：异步初始化前监听断连；元信息独立校验，记录失败不影响业务执行。
    const metadata = typeof request.body === 'object' && request.body !== null && 'monitoring' in request.body
      ? request.body.monitoring : undefined;
    const recording = await beginIngestionRecording(recordingSettings, parsed.data, metadata);
    try {
      ingestor ??= createRagIngestor(config);
    } catch (error) {
      // 监控采集：初始化失败也保留已接收文件的记录；记录失败不影响业务执行。
      recording?.fail(error);
      recording?.close();
      reply.raw.off('close', onClose);
      return reply.code(503).send({ error: { code: 'RAG_UNAVAILABLE', message: '索引服务尚未配置' } });
    }
    try {
      // 监控采集：只有业务函数确认提交后才结束任务；记录失败不影响业务执行。
      const result = await ingestor.ingestFile(parsed.data, controller.signal, recording);
      recording?.complete();
      return result;
    } catch (error) {
      // 监控采集：阶段内已结束的记录不会重复写入；记录失败不影响业务执行。
      recording?.fail(error, controller.signal.aborted);
      return reply.code(502).send({ error: { code: 'RAG_INGEST_FAILED', message: '文件索引未完成' } });
    } finally {
      reply.raw.off('close', onClose);
      recording?.close();
    }
  });
}
