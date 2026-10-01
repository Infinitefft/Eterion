import { tool } from '@langchain/core/tools';
import { interrupt } from '@langchain/langgraph';
import { z } from 'zod';

export const askUser = tool(
  async ({ questions }) => {
    // interrupt 前不做网络或写入操作：恢复时工具会从头执行。
    const response: unknown = interrupt({ questions });
    return answerSchema.parse(response);
  },
  {
    name: 'ask_user',
    description: '缺少影响任务结果的关键信息，且无法从上下文确定时向用户提问。将相关问题集中在一次调用中，等待真实回答后继续。已有明确答案或可采用合理默认值时不要反复询问。',
    schema: z.object({
      questions: z.array(z.object({
        questionId: z.string().trim().min(1).max(100).describe('本次提问中唯一的问题标识'),
        prompt: z.string().trim().min(1).max(2000).describe('向用户展示的问题'),
        options: z.array(z.string().trim().min(1).max(500)).min(1).max(20).optional()
          .describe('可选答案；省略时使用自由文本输入'),
        multiple: z.boolean().optional().describe('提供 options 时是否允许多选'),
        required: z.boolean().optional().describe('继续任务所必需的问题设为 true'),
      })).min(1).max(10),
    }).superRefine(({ questions }, ctx) => {
      const ids = new Set<string>();
      for (const question of questions) {
        if (ids.has(question.questionId) || (question.multiple && !question.options)
          || (question.options && new Set(question.options).size !== question.options.length)) {
          ctx.addIssue({ code: 'custom', message: '问题 ID、选项不得重复，多选题必须提供选项' });
        }
        ids.add(question.questionId);
      }
    }),
  },
);

// 恢复入口和工具共用校验，字段沿用前端的 interaction.respond 协议。
export const answerSchema = z.object({
  answers: z.array(z.object({
    questionId: z.string().trim().min(1).max(100),
    value: z.union([z.string().max(8000), z.array(z.string().max(500)).max(20)]),
  }).strict()).max(10),
}).strict();

export function validateAnswers(questions: z.infer<typeof askUser.schema>['questions'], value: unknown) {
  const response = answerSchema.parse(value);
  const answers = new Map(response.answers.map((answer) => [answer.questionId, answer.value]));
  if (answers.size !== response.answers.length
    || response.answers.some((answer) => !questions.some((q) => q.questionId === answer.questionId))) {
    throw new Error('答案包含重复或未知的问题');
  }
  for (const question of questions) {
    const answer = answers.get(question.questionId);
    if (answer === undefined) {
      if (question.required) throw new Error('请回答必填问题');
      continue;
    }
    if (question.multiple ? !Array.isArray(answer) : typeof answer !== 'string') {
      throw new Error('答案类型不符合问题要求');
    }
    const values = Array.isArray(answer) ? answer : [answer];
    if (question.required && (!values.length || values.some((item) => !item.trim()))) {
      throw new Error('请回答必填问题');
    }
    if (new Set(values).size !== values.length
      || (question.options && values.some((item) => !question.options?.includes(item)))) {
      throw new Error('答案不在可选范围内');
    }
  }
  return response;
}
