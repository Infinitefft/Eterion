import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchThreadSnapshot } from '@/api/im';
import { useAuthStore } from '@/store/auth-store';
import { useIMStore } from '@/store/im-store';

import { destroyIMService, getIMService, synchronizeThread } from './index';

import type { ServerThreadEvent } from './protocol';
import type { IMConnectionState, IMTransportListener } from './transport';
import type { ThreadSnapshot } from './types';

const transport = vi.hoisted<{
  listener: IMTransportListener | null;
  state: IMConnectionState;
}>(() => ({
  listener: null,
  state: {
    status: 'connected',
    reconnectAttempts: 0,
    connectedAt: 1,
    disconnectedAt: null,
    lastError: null,
  },
}));

vi.mock('@/api/im', () => ({
  createIMTicket: vi.fn(),
  fetchThreadSnapshot: vi.fn(),
}));

vi.mock('./transport', () => ({
  WebSocketTransport: class {
    getState() {
      return transport.state;
    }

    subscribe(listener: IMTransportListener) {
      transport.listener = listener;
      return () => { transport.listener = null; };
    }

    connect() {
      return Promise.resolve();
    }

    disconnect() {
      transport.state = { ...transport.state, status: 'disconnected', disconnectedAt: 2 };
      transport.listener?.({ type: 'state.changed', state: transport.state });
    }

    send = vi.fn<(data: string) => void>();
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function snapshot(threadId = 'thread-a'): ThreadSnapshot {
  return {
    thread: { id: threadId, title: '会话', createdAt: 1, updatedAt: 2 },
    messages: [{
      id: 'assistant-a', threadId, runId: 'run-a', role: 'assistant',
      format: 'plain_text', content: 'AB', status: 'streaming',
      createdAt: 1, completedAt: null, error: null,
    }],
    runs: [],
    blocks: [],
    lastSeqId: 2,
  };
}

function emit(event: ServerThreadEvent) {
  transport.listener?.({ type: 'message.received', data: JSON.stringify(event) });
}

function emitDelta(seqId: number, delta: string) {
  emit({
    type: 'message.delta', threadId: 'thread-a', runId: 'run-a',
    messageId: 'assistant-a', seqId, timestamp: seqId, payload: { delta },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useIMStore.getState().reset();
  useAuthStore.getState().setSession({
    access_token: 'test-token', token_type: 'Bearer', expires_in: 900,
    user: { id: 'alice', nickname: 'Alice', phone: '13800000000' },
  });
  transport.state = {
    status: 'connected', reconnectAttempts: 0, connectedAt: 1,
    disconnectedAt: null, lastError: null,
  };
});

afterEach(() => {
  destroyIMService();
  useIMStore.getState().reset();
});

describe('thread snapshot synchronization', () => {
  it('drops covered events and applies later deltas once, preserving local messages and unread', async () => {
    const response = deferred<ThreadSnapshot>();
    vi.mocked(fetchThreadSnapshot).mockReturnValueOnce(response.promise);
    useIMStore.getState().addSendingMessage('thread-a', 'local-user', 'hello');
    useIMStore.getState().markThreadUnread('thread-a');

    const pending = synchronizeThread('thread-a');
    expect(useIMStore.getState().detailLoadStateByThread['thread-a']?.status).toBe('loading');
    await Promise.resolve();
    emit({
      type: 'message.started', threadId: 'thread-a', runId: 'run-a',
      messageId: 'assistant-a', seqId: 1, timestamp: 1,
      payload: { role: 'assistant', format: 'plain_text', createdAt: 1 },
    });
    emitDelta(2, 'B');
    emitDelta(3, 'C');
    response.resolve(snapshot());
    await pending;
    emitDelta(3, 'C');
    emitDelta(4, 'D');

    const state = useIMStore.getState();
    expect(state.detailsByThread['thread-a']?.messages.map((message) => message.content))
      .toEqual(['ABCD', 'hello']);
    expect(state.detailLoadStateByThread['thread-a']?.status).toBe('ready');
    expect(state.unreadByThread['thread-a']).toBe(true);
  });

  it('shares the same in-flight promise without blocking another thread', async () => {
    const response = deferred<ThreadSnapshot>();
    vi.mocked(fetchThreadSnapshot).mockReturnValueOnce(response.promise)
      .mockResolvedValueOnce(snapshot('thread-b'));

    const first = synchronizeThread('thread-a');
    expect(synchronizeThread('thread-a')).toBe(first);
    await synchronizeThread('thread-b');
    expect(fetchThreadSnapshot).toHaveBeenCalledTimes(2);
    expect(useIMStore.getState().detailLoadStateByThread['thread-b']?.status).toBe('ready');
    response.resolve(snapshot());
    await first;
  });

  it('keeps content and unread on failure, then resumes buffered events after retry', async () => {
    useIMStore.getState().applySnapshot(snapshot());
    useIMStore.getState().markThreadUnread('thread-a');
    vi.mocked(fetchThreadSnapshot).mockRejectedValueOnce(new Error('加载失败'));
    await synchronizeThread('thread-a');
    emitDelta(3, 'C');

    expect(useIMStore.getState().detailsByThread['thread-a']?.messages[0].content).toBe('AB');
    expect(useIMStore.getState().detailLoadStateByThread['thread-a'])
      .toEqual({ status: 'error', message: '加载失败' });
    expect(useIMStore.getState().unreadByThread['thread-a']).toBe(true);

    vi.mocked(fetchThreadSnapshot).mockResolvedValueOnce(snapshot());
    await synchronizeThread('thread-a');
    expect(useIMStore.getState().detailsByThread['thread-a']?.messages[0].content).toBe('ABC');
    expect(useIMStore.getState().detailLoadStateByThread['thread-a']?.status).toBe('ready');
  });

  it('finishes caching after navigation without clearing the previous thread unread', async () => {
    const response = deferred<ThreadSnapshot>();
    vi.mocked(fetchThreadSnapshot).mockReturnValueOnce(response.promise);
    useIMStore.getState().setActiveThread('thread-a');
    useIMStore.getState().markThreadUnread('thread-a');
    const pending = synchronizeThread('thread-a');
    await Promise.resolve();
    useIMStore.getState().setActiveThread('thread-b');
    response.resolve(snapshot());
    await pending;

    expect(useIMStore.getState().detailLoadStateByThread['thread-a']?.status).toBe('ready');
    expect(useIMStore.getState().activeThreadId).toBe('thread-b');
    expect(useIMStore.getState().unreadByThread['thread-a']).toBe(true);
  });

  it.each(['identity', 'reset', 'delete'] as const)('ignores a snapshot invalidated by %s', async (reason) => {
    const response = deferred<ThreadSnapshot>();
    vi.mocked(fetchThreadSnapshot).mockReturnValueOnce(response.promise);
    const pending = synchronizeThread('thread-a');
    await Promise.resolve();

    if (reason === 'identity') {
      useAuthStore.getState().clearSession();
    } else if (reason === 'reset') {
      useIMStore.getState().reset();
    } else {
      useIMStore.setState({ detailLoadStateByThread: {} });
    }
    const before = useIMStore.getState();
    response.resolve(snapshot());
    await pending;
    expect(useIMStore.getState()).toBe(before);
  });

  it('invalidates on disconnect and does not let the old task remove its replacement', async () => {
    const oldResponse = deferred<ThreadSnapshot>();
    const newResponse = deferred<ThreadSnapshot>();
    vi.mocked(fetchThreadSnapshot).mockReturnValueOnce(oldResponse.promise)
      .mockReturnValueOnce(newResponse.promise);
    const oldTask = synchronizeThread('thread-a');
    await Promise.resolve();
    getIMService().disconnect();
    expect(useIMStore.getState().detailLoadStateByThread['thread-a']?.status).toBe('error');

    const newTask = synchronizeThread('thread-a');
    await Promise.resolve();
    oldResponse.resolve(snapshot());
    await oldTask;
    expect(useIMStore.getState().detailsByThread['thread-a']).toBeUndefined();
    expect(synchronizeThread('thread-a')).toBe(newTask);
    newResponse.resolve(snapshot());
    await newTask;
    expect(useIMStore.getState().detailLoadStateByThread['thread-a']?.status).toBe('ready');
  });

  it('does not restore errors or data after reset and disconnect', async () => {
    const response = deferred<ThreadSnapshot>();
    vi.mocked(fetchThreadSnapshot).mockReturnValueOnce(response.promise);
    const pending = synchronizeThread('thread-a');
    await Promise.resolve();
    useIMStore.getState().reset();
    getIMService().disconnect();
    response.reject(new Error('旧请求失败'));
    await pending;
    expect(useIMStore.getState().detailLoadStateByThread).toEqual({});
    expect(useIMStore.getState().detailsByThread).toEqual({});
  });

  it('ignores requests from a destroyed runtime', async () => {
    const response = deferred<ThreadSnapshot>();
    vi.mocked(fetchThreadSnapshot).mockReturnValueOnce(response.promise);
    const pending = synchronizeThread('thread-a');
    await Promise.resolve();
    destroyIMService();
    getIMService();
    const before = useIMStore.getState();
    response.resolve(snapshot());
    await pending;
    expect(useIMStore.getState()).toBe(before);
  });
});
