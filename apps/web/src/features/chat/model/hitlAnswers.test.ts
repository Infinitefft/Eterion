import { describe, expect, it } from 'vitest';

import { getHITLAnswerValue } from './hitlAnswers';

describe('HITL answer values', () => {
  const question = { questionId: 'topic', prompt: '选择方向', options: ['A', 'B'], required: true };

  it('uses custom text as the single answer and preserves the existing string protocol', () => {
    expect(getHITLAnswerValue(question, { selected: ['A'], custom: ' 自己的方向 ' })).toBe('自己的方向');
    expect(getHITLAnswerValue(question, { selected: ['B'], custom: '' })).toBe('B');
    expect(getHITLAnswerValue(question)).toBe('');
  });

  it('combines multiple selections with one custom answer without duplicates', () => {
    expect(getHITLAnswerValue({ ...question, multiple: true }, { selected: ['A'], custom: '补充方向' }))
      .toEqual(['A', '补充方向']);
    expect(getHITLAnswerValue({ ...question, multiple: true }, { selected: ['A'], custom: ' A ' }))
      .toEqual(['A']);
    expect(getHITLAnswerValue({ ...question, multiple: true }, { selected: [], custom: '独立想法' }))
      .toEqual(['独立想法']);
  });
});
