import assert from 'node:assert/strict';
import test from 'node:test';

import { createWebSearchTool } from '../dist/tools/web-search.js';
import { webFetch } from '../dist/tools/web-fetch.js';

const cases = [
  { tool: createWebSearchTool('offline-search-key'), args: { query: 'Example' } },
  // 数字 IP 不需要向 DNS 服务器查询；下面仍完全替换 fetch，不访问这个地址。
  { tool: webFetch, args: { url: 'https://93.184.216.34/' } },
];

for (const { tool, args } of cases) {
  for (const reason of ['Run 取消', 'Tool 超时', '独立调用超时']) {
    test(`${tool.name}：${reason} 会取消实际网页请求`, { timeout: 2000 }, async (t) => {
      const runController = new AbortController();
      const timeoutController = new AbortController();
      let requestSignal;

      // 用可控信号代替真实十秒计时器，验证信号连接，而不是等待真实超时。
      const timeoutMock = t.mock.method(AbortSignal, 'timeout', (milliseconds) => {
        assert.equal(milliseconds, 10_000);
        return timeoutController.signal;
      });
      const fetchMock = t.mock.method(globalThis, 'fetch', (_url, { signal }) => {
        requestSignal = signal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          // 请求开始后再触发取消，确保验证的是进行中的 fetch。
          const controller = reason === 'Run 取消' ? runController : timeoutController;
          controller.abort();
        });
      });

      const config = reason === '独立调用超时' ? undefined : { signal: runController.signal };
      await assert.rejects(tool.invoke(args, config));

      assert.equal(fetchMock.mock.callCount(), 1);
      assert.equal(timeoutMock.mock.callCount(), 1);
      assert.equal(requestSignal.aborted, true);
      assert.equal(runController.signal.aborted, reason === 'Run 取消');
      assert.equal(timeoutController.signal.aborted, reason !== 'Run 取消');
    });
  }
}
