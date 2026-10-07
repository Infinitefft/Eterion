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
    description: '仅在缺少影响结果的关键信息时提问。默认只问一个核心问题，优先提供单选；确实允许组合才用多选。前端会为每道选择题自动提供自填输入框，不要再为同一问题追加多选题、其他选项或文本题。只有互不重复且都阻碍继续的独立问题才合并询问，最多三个。已有答案或能用合理默认值时直接继续，不要为了展示交互而提问。',
    schema: z.object({
      questions: z.array(z.object({
        questionId: z.string().trim().min(1).max(100).describe('本次提问中唯一的问题标识'),
        prompt: z.string().trim().min(1).max(2000).describe('向用户展示的问题'),
        options: z.array(z.string().trim().min(1).max(500)).min(2).max(6).optional()
          .describe('2～6 个简短候选答案，不包含“其他/自行填写”；仅无法提供有意义候选项时省略'),
        recommendedOption: z.string().trim().min(1).max(500).optional()
          .describe('有明确依据时填写一个推荐选项，必须与 options 中某项完全一致；前端置顶并标注推荐，不在选项文字中加标记。没有推荐则省略'),
        multiple: z.boolean().optional().describe('默认 false 单选；只有答案可组合时为 true，不要为同一问题同时生成单选和多选'),
        required: z.boolean().optional().describe('继续任务所必需的问题设为 true'),
      })).min(1).max(3),
    }).superRefine(({ questions }, ctx) => {
      const ids = new Set<string>();
      for (const question of questions) {
        if (ids.has(question.questionId) || (question.multiple && !question.options)
          || (question.options && new Set(question.options).size !== question.options.length)) {
          ctx.addIssue({ code: 'custom', message: '问题 ID、选项不得重复，多选题必须提供选项' });
        }
        ids.add(question.questionId);
        if (question.recommendedOption && !question.options?.includes(question.recommendedOption)) {
          ctx.addIssue({ code: 'custom', message: '推荐项必须属于候选选项' });
        }
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
    // 候选项是帮助用户表达偏好的建议，允许用户填写选项之外的真实答案。
    if (new Set(values).size !== values.length) {
      throw new Error('不能重复选择同一选项');
    }
  }
  return response;
}
