/**
 * Markdown 解析器输出的最小 AST。
 *
 * Block 节点对应 React 中可独立 memo 的渲染单元；Inline 节点只描述
 * Paragraph、Heading、ListItem 和 Blockquote 内部的文本样式。
 */

/** Block 的稳定标识；活动块变成稳定块后继续复用同一个 ID。 */
export type MarkdownBlockId = string;

/** 当前只支持 ATX 风格的 1～6 级标题。 */
export type MarkdownHeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

/** 没有任何特殊语义的普通文本。 */
export interface MarkdownTextNode {
  readonly type: 'text';
  readonly value: string;
}

/** 使用一对反引号包裹的行内代码。 */
export interface MarkdownInlineCodeNode {
  readonly type: 'inlineCode';
  readonly value: string;
}

/** 使用成对 ** 包裹的加粗内容。 */
export interface MarkdownStrongNode {
  readonly type: 'strong';
  readonly children: readonly MarkdownInlineNode[];
}

/** `[label](url)` 形式的链接。 */
export interface MarkdownLinkNode {
  readonly type: 'link';
  readonly href: string;
  readonly children: readonly MarkdownInlineNode[];
}

/** 行内解析器能够产生的全部节点。 */
export type MarkdownInlineNode =
  MarkdownTextNode | MarkdownInlineCodeNode | MarkdownStrongNode | MarkdownLinkNode;

/** 所有块级节点都具备的稳定身份。 */
interface MarkdownBlockBase {
  readonly id: MarkdownBlockId;
}

/** 普通段落；换行和空行由后续 Block Parser 决定如何合并。 */
export interface MarkdownParagraphNode extends MarkdownBlockBase {
  readonly type: 'paragraph';
  readonly children: readonly MarkdownInlineNode[];
}

/** `#` 到 `######` 形式的标题。 */
export interface MarkdownHeadingNode extends MarkdownBlockBase {
  readonly type: 'heading';
  readonly level: MarkdownHeadingLevel;
  readonly children: readonly MarkdownInlineNode[];
}

/** 使用反引号或波浪号围栏包裹的代码块。 */
export interface MarkdownFencedCodeNode extends MarkdownBlockBase {
  readonly type: 'code';
  readonly language: string | null;
  readonly value: string;
}

/** 第一版列表项只包含一段行内内容，不支持嵌套 Block。 */
export interface MarkdownListItem {
  readonly children: readonly MarkdownInlineNode[];
}

/** 连续的扁平有序或无序列表。 */
export interface MarkdownListNode extends MarkdownBlockBase {
  readonly type: 'list';
  readonly ordered: boolean;
  readonly start: number | null;
  readonly items: readonly MarkdownListItem[];
}

/** 连续 `>` 行组成的一层引用，不支持嵌套引用。 */
export interface MarkdownBlockquoteNode extends MarkdownBlockBase {
  readonly type: 'blockquote';
  readonly children: readonly MarkdownInlineNode[];
}

/** 流式 Markdown Parser 能够交给 React 渲染的全部块级节点。 */
export type MarkdownBlockNode =
  | MarkdownParagraphNode
  | MarkdownHeadingNode
  | MarkdownFencedCodeNode
  | MarkdownListNode
  | MarkdownBlockquoteNode;
