import { tool } from '@langchain/core/tools';
import { z } from 'zod';

const timeContextSchema = z.object({
  inputMessageCreatedAt: z.number().int().nonnegative().max(8.64e15),
});

export const getTurnTime = tool(
  (_input, runtime) => {
    // 时间由服务端通过运行上下文提供，不能让模型自己填写，也不在调用时重新取时钟。
    const { inputMessageCreatedAt } = timeContextSchema.parse(runtime.context);
    const date = new Date(inputMessageCreatedAt);
    const localTime = new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3,
      hourCycle: 'h23',
    }).format(date).replace(' ', 'T').replace(',', '.');
    return {
      timestampMs: inputMessageCreatedAt,
      utcTime: date.toISOString(),
      localTime: `${localTime}+08:00`,
      timeZone: 'Asia/Shanghai',
      source: '本轮用户消息的服务端创建时间，不是工具执行时刻或会话开始时间',
    };
  },
  {
    name: 'get_turn_time',
    description: '获取本轮用户消息的准确发起时间。需要确定用户本轮所说的今天、明天、现在对应的日期或时间时调用。每个新回合的时间不同；同一回合和暂停恢复后保持不变。直接返回结果，无需用户参与，不必向用户说明调用过程。',
    schema: z.object({}),
  },
);
