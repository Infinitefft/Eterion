import { AxiosError } from 'axios';
import { expect, it, vi } from 'vitest';

it('replays the same multipart file after refreshing an expired login token', async () => {
  vi.resetModules();
  const { apiClient, publicApiClient } = await import('./client');
  const { uploadKnowledgeFile } = await import('./knowledge');
  const { useAuthStore } = await import('@/store/auth-store');
  const user = { id: 'alice', phone: '13800000000', nickname: 'alice' };
  useAuthStore
    .getState()
    .setSession({ access_token: 'old', token_type: 'Bearer', expires_in: 900, user });
  publicApiClient.defaults.adapter = (config) =>
    Promise.resolve({
      config,
      status: 200,
      statusText: 'OK',
      headers: {},
      data: { data: { access_token: 'new', token_type: 'Bearer', expires_in: 900, user } },
    });
  const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
  let calls = 0;
  let originalForm: FormData | undefined;
  apiClient.defaults.adapter = async (config) => {
    calls++;
    expect(config.url).toBe('/knowledge-bases/base/files');
    expect(config.timeout).toBe(190_000);
    const form = config.data as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(await (form.get('file') as File).text()).toBe('hello');
    if (calls === 1) {
      originalForm = form;
      expect(config.headers.get('Authorization')).toBe('Bearer old');
      throw new AxiosError('expired', 'ERR_BAD_RESPONSE', config, undefined, {
        config,
        status: 401,
        statusText: 'Unauthorized',
        headers: {},
        data: { error: { code: 'AUTH_ACCESS_EXPIRED' } },
      });
    }
    expect(form).toBe(originalForm);
    expect(config.headers.get('Authorization')).toBe('Bearer new');
    return {
      config,
      status: 201,
      statusText: 'Created',
      headers: {},
      data: { data: { id: 'file-id' } },
    };
  };
  expect(await uploadKnowledgeFile('base', file)).toEqual({ id: 'file-id' });
  expect(calls).toBe(2);
});
