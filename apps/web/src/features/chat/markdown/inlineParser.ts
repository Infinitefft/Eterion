import type { MarkdownInlineNode } from './ast';

/** 成功识别一个行内语法后，节点和下一个读取位置必须一起返回。 */
interface ParsedInlineToken {
  node: MarkdownInlineNode;
  nextIndex: number;
}

/**
 * 追加普通文本，并主动合并相邻 TextNode。
 * 这样长段落不会因为逐字符扫描而产生大量 React 子节点。
 */
function appendText(nodes: MarkdownInlineNode[], value: string): void {
  if (!value) {
    return;
  }

  const targetNodes = nodes;
  const previous = targetNodes.at(-1);

  if (previous?.type === 'text') {
    targetNodes[targetNodes.length - 1] = {
      type: 'text',
      value: previous.value + value,
    };
    return;
  }

  targetNodes.push({ type: 'text', value });
}

/** 找到下一个可能开始行内语法的位置，中间内容可以一次性输出为 TextNode。 */
function findNextTokenStart(source: string, startIndex: number, allowLinks: boolean): number {
  for (let index = startIndex; index < source.length; index += 1) {
    const character = source[index];

    if (
      character === '`' ||
      (character === '*' && source[index + 1] === '*') ||
      (allowLinks && character === '[')
    ) {
      return index;
    }
  }

  return source.length;
}

/** 第一版行内代码只支持一对单反引号，内部内容不再解析其他语法。 */
function tryParseInlineCode(source: string, startIndex: number): ParsedInlineToken | null {
  const closingIndex = source.indexOf('`', startIndex + 1);

  if (closingIndex <= startIndex + 1) {
    return null;
  }

  return {
    node: {
      type: 'inlineCode',
      value: source.slice(startIndex + 1, closingIndex),
    },
    nextIndex: closingIndex + 1,
  };
}

/** 查找加粗结束符时跳过完整的行内代码，避免把代码里的 ** 当成结束符。 */
function findStrongClosingIndex(source: string, startIndex: number): number {
  for (let index = startIndex; index < source.length; index += 1) {
    if (source[index] === '`') {
      const codeClosingIndex = source.indexOf('`', index + 1);

      if (codeClosingIndex !== -1) {
        index = codeClosingIndex;
        continue;
      }
    }

    if (source[index] === '*' && source[index + 1] === '*') {
      return index;
    }
  }

  return -1;
}

/** 只接受 http/https，危险协议和不完整 URL 最终都会回退成普通文本。 */
function isSafeLinkHref(href: string): boolean {
  try {
    const url = new URL(href);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** 解析成对 **；内容继续复用同一个行内解析器。 */
function tryParseStrong(
  source: string,
  startIndex: number,
  allowLinks: boolean,
): ParsedInlineToken | null {
  const closingIndex = findStrongClosingIndex(source, startIndex + 2);

  if (closingIndex <= startIndex + 2) {
    return null;
  }

  return {
    node: {
      type: 'strong',
      children: parseInlineRange(source.slice(startIndex + 2, closingIndex), allowLinks),
    },
    nextIndex: closingIndex + 2,
  };
}

/** 解析最小 `[label](url)`，链接标签中禁止继续生成嵌套链接。 */
function tryParseLink(source: string, startIndex: number): ParsedInlineToken | null {
  const labelClosingIndex = source.indexOf('](', startIndex + 1);
  const hrefClosingIndex =
    labelClosingIndex === -1 ? -1 : source.indexOf(')', labelClosingIndex + 2);

  if (labelClosingIndex <= startIndex + 1 || hrefClosingIndex === -1) {
    return null;
  }

  const label = source.slice(startIndex + 1, labelClosingIndex);
  const href = source.slice(labelClosingIndex + 2, hrefClosingIndex).trim();

  if (!isSafeLinkHref(href)) {
    return null;
  }

  return {
    node: {
      type: 'link',
      href,
      children: parseInlineRange(label, false),
    },
    nextIndex: hrefClosingIndex + 1,
  };
}

/** 按优先级尝试当前位置的行内语法；普通文本返回 null。 */
function tryParseTokenAt(
  source: string,
  startIndex: number,
  allowLinks: boolean,
): ParsedInlineToken | null {
  if (source[startIndex] === '`') {
    return tryParseInlineCode(source, startIndex);
  }

  if (source[startIndex] === '*' && source[startIndex + 1] === '*') {
    return tryParseStrong(source, startIndex, allowLinks);
  }

  if (allowLinks && source[startIndex] === '[') {
    return tryParseLink(source, startIndex);
  }

  return null;
}

/** 内部解析函数通过 allowLinks 阻止链接标签中继续生成嵌套链接。 */
function parseInlineRange(source: string, allowLinks: boolean): MarkdownInlineNode[] {
  const nodes: MarkdownInlineNode[] = [];
  let index = 0;

  while (index < source.length) {
    const parsedToken = tryParseTokenAt(source, index, allowLinks);

    if (parsedToken) {
      nodes.push(parsedToken.node);
      index = parsedToken.nextIndex;
      continue;
    }

    const nextIndex = findNextTokenStart(source, index + 1, allowLinks);
    appendText(nodes, source.slice(index, nextIndex));
    index = nextIndex;
  }

  return nodes;
}

/**
 * 把一个完整 Heading、Paragraph、ListItem 或 Blockquote 的文本解析成行内 AST。
 * 未闭合或不受支持的 Markdown 语法会保留为普通文本，不会吞掉用户内容。
 */
export function parseInlineMarkdown(source: string): readonly MarkdownInlineNode[] {
  return parseInlineRange(source, true);
}
