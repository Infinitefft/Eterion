import type { HITLQuestion } from '@/service/im/types';

export interface HITLAnswerDraft {
  selected: string[];
  custom: string;
}

/** 保持现有答案协议：单选为文本，多选为数组，自填内容作为一个答案。 */
export function getHITLAnswerValue(question: HITLQuestion, draft?: HITLAnswerDraft): string | string[] {
  const custom = draft?.custom.trim() ?? '';
  const selected = draft?.selected ?? [];
  if (!question.multiple) return custom || selected[0] || '';
  return [...new Set([...selected, ...(custom ? [custom] : [])])];
}
