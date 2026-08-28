import { lookup } from 'node:dns/promises';

import { tool } from '@langchain/core/tools';
import * as cheerio from 'cheerio';
import { maxSize, z } from 'zod';

const FETCH_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export const webFetch = tool(
  async ({ url, maxCharacters }) => {
    const targetUrl = new URL(url);
    /**
     * 发起请求前检查协议、域名和解析出来的 IP，
     * 避免 Tool 访问运行 Agent 的电脑或局域网服务。
     */
    await assertPublicUrl(targetUrl);

    let response: Response;

    try {
      response = await fetch(targetUrl, {
        /**
         * Accept 告诉网站我们只希望收到 HTML 或纯文本。
         * PDF、图片等内容不属于当前 web_fetch 的职责。
         */
        headers: {
          Accept: 'text/html,text/plain',
          'User-Agent': 'EterionAgent',
        },
        /**
         * manual 表示不允许 fetch 自动跟随 301/302 跳转。
         *
         * 如果自动跳转，攻击者可能先提供一个公开网址，
         * 再把请求跳转到 localhost 或局域网地址，绕过前面的检查。
         */
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (error) {
        throw new Error('web_fetch request failed', {
          cause: error,
        });
    }
    
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      
      /** 当前响应的正文不会被使用，主动取消读取可以尽早释放连接 */
      await response.body?.cancel();

      const redirectTarget = location
        ? new URL(location, targetUrl).toString()
        : 'unknown URL';
      throw new Error(
        `web_fetch does not follow redirects; target is ${redirectTarget}`,
      );
    }
    
    if (!response.ok) {
      throw new Error(`web_fetch request failed with HTTP ${response.status}`);
    }

    /**
     * Content-Type 用来判断服务端返回的是 HTML，文本，PDF 还是图片
     * toLowerCase() 可以避免大小写差异影响判断
     */
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';

    const isHtml = 
      contentType.includes('text/html') ||
      contentType.includes('application/xhtml+xml');

    const isPlainText = contentType.includes('text/plian');

    if (!isHtml && !isPlainText) {
      throw new Error(
        `web_fetch does not support content type "${
          contentType || 'unknown'
        }"`,
      );
    }
    
    /** 
     * Content-Length 是服务端声明的响应字节数
     * 如果网站提前声明内容超过 2MB，就不再继续下载
     */
    const contentLengthHeader = response.headers.get('content-length');

    if (contentLengthHeader !== null) {
      const contentLength = Number(contentLengthHeader);

      if (
        Number.isFinite(contentLength) &&
        contentLength > MAX_RESPONSE_BYTES
      ) {
        throw new Error('web_fetch response is too large');
      }
    }

    /**
     * reponse.text() 把 HTTP 响应正文读取为字符串
     * 
     * 当前项目只读取普通网页，因此不需要处理 ArrayBuffer Blob 或文件下载
     */
    const rawContent = await response.text();

    /**
     * 有些网站不会返回 Content-Length，所以读取完成后再检查一次
     * 
     * Buffer.byteLength() 计算的是 UTF-8 字节数
     * rawContent.length 计算的是 JS 字符串长度，两者含义不同
     */
    if (Buffer.byteLength(rawContent, 'utf-8') > MAX_RESPONSE_BYTES) {
      throw new Error('web_fetch response is too large');
    }
    let title = targetUrl.hostname;
    let content = rawContent;

    if (isHtml) {
      /**
       * cheerio.load() 把 HTML 字符串解析为可以通过 CSS 选择器
       * 查询的文档结构。
       *
       * Cheerio 只解析已有 HTML，不会执行 script 标签中的代码。
       */
      const $ = cheerio.load(rawContent);

      title = cleanText($('title').first().text()) || title;

      /**
       * 删除明显不属于文章正文的元素：
       * - script：JavaScript 代码
       * - style：CSS 样式
       * - nav：导航栏
       * - footer：页脚
       * - iframe：嵌入页面
       * - svg：矢量图代码
       * - form：表单
       *
       * 如果不删除，模型可能会收到大量菜单、样式或脚本内容。
       */
      $('script, style, noscript, nav, footer, iframe, svg, form',).remove();
      
    }
  }
)