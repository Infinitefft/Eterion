import { Check, ChevronDown, CircleAlert, Globe, LoaderCircle, Wrench } from 'lucide-react';
import { useState } from 'react';

import type { JsonValue, ToolCallBlockState } from '@/service/im/types';

interface Website {
  url: string;
  hostname: string;
  title: string;
}

function isObject(value: JsonValue | null): value is Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getWebsites(block: ToolCallBlockState): Website[] {
  const result = isObject(block.result) ? block.result : null;
  const args = isObject(block.args) ? block.args : null;
  const entries = block.name === 'web_search'
    ? (Array.isArray(result?.results) ? result.results : [])
    : [result ?? args];
  const websites: Website[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (!isObject(entry) || typeof entry.url !== 'string') continue;

    let url: URL;
    try {
      url = new URL(entry.url);
    } catch {
      continue;
    }
    // 工具结果属于外部输入，只将正常网页地址渲染为可点击链接。
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue;
    if (seen.has(url.hostname)) continue;
    seen.add(url.hostname);
    websites.push({
      url: url.href,
      hostname: url.hostname,
      title: typeof entry.title === 'string' ? entry.title : '',
    });
  }

  return websites;
}

export function ToolCallItem({ block }: { block: ToolCallBlockState }) {
  const [expanded, setExpanded] = useState(true);
  const isWebTool = block.name === 'web_search' || block.name === 'web_fetch';
  const websites = isWebTool ? getWebsites(block) : [];
  const isRunning = block.status === 'running';
  const isFailed = block.status === 'failed';
  let label = block.displayName || block.name;

  if (block.name === 'web_search') {
    label = isRunning ? '正在搜索网页' : isFailed ? '网页搜索失败'
      : websites.length > 0 ? `已搜索 ${websites.length} 个网站` : '网页搜索已完成';
  } else if (block.name === 'web_fetch') {
    label = isRunning ? '正在读取网页' : isFailed ? '网页读取失败' : '已读取网页';
  } else {
    label += isRunning ? ' · 调用中' : isFailed ? ' · 调用失败' : ' · 已完成';
  }

  const heading = (
    <>
      {isWebTool ? <Globe size={15} aria-hidden='true' /> : <Wrench size={15} aria-hidden='true' />}
      <span>{label}</span>
      {isRunning ? <LoaderCircle className='chat-run-spinner' size={14} aria-hidden='true' />
        : isFailed ? <CircleAlert size={14} aria-hidden='true' />
          : <Check size={14} aria-hidden='true' />}
      {websites.length > 0 ? (
        <ChevronDown className={expanded ? 'chat-tool-chevron is-expanded' : 'chat-tool-chevron'} size={14} aria-hidden='true' />
      ) : null}
    </>
  );

  return (
    <li className='chat-tool-call' data-status={block.status}>
      {websites.length > 0 ? (
        <button className='chat-tool-heading' type='button' aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {heading}
        </button>
      ) : <div className='chat-tool-heading'>{heading}</div>}
      {expanded && websites.length > 0 ? (
        <ul className='chat-tool-websites' aria-label='相关网站'>
          {websites.map((website) => (
            <li key={website.hostname}>
              <a href={website.url} target='_blank' rel='noopener noreferrer' title={website.title ? `${website.title}\n${website.url}` : website.url}>
                <Globe size={14} aria-hidden='true' />
                <span>{website.hostname}</span>
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      {isFailed && block.error?.message ? <p className='chat-tool-error'>{block.error.message}</p> : null}
    </li>
  );
}
