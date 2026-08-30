import { Ban, Check, CircleAlert, LoaderCircle, Sparkles, Wrench } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import { getIMService } from '@/service/im';
import type {
  AgentBlockState,
  HITLAnswer,
  HITLInteractionState,
  HITLQuestion,
  JsonValue,
  RunId,
  RunState,
  RunStatus,
  ThreadId,
  ToolCallBlockState,
} from '@/service/im/types';
import { useIMStore } from '@/store/imStore';

import { ThinkingIndicator } from './ThinkingIndicator';

interface AgentRunTraceProps {
  threadId: ThreadId;
  runId: RunId;
  hideThinkingIndicator?: boolean;
}

const ACTIVE_RUN_STATUSES = new Set<RunStatus>(['pending', 'running', 'waiting_user']);

function getRunStatusLabel(run: RunState): string {
  switch (run.status) {
    case 'pending':
      return '正在准备';
    case 'running':
      return '正在思考';
    case 'waiting_user':
      return '等待你的确认';
    case 'failed':
      return run.error?.message || '本次运行失败';
    case 'cancelled':
      return '本次运行已停止';
    case 'completed':
      return 'Agent 过程';
  }
}

function formatJsonValue(value: JsonValue | null): string | null {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function getToolLabel(block: ToolCallBlockState): string {
  const name = block.displayName || block.name;

  switch (block.status) {
    case 'running': {
      const args = formatJsonValue(block.args);
      return args ? `${name} · ${args}` : `${name} · 执行中`;
    }
    case 'completed': {
      const result = block.summary || formatJsonValue(block.result);
      return result ? `${name} · ${result}` : `${name} · 已完成`;
    }
    case 'failed':
      return `${name} · ${block.error?.message || '调用失败'}`;
  }
}

function getInteractionLabel(block: HITLInteractionState): string {
  const prompts = block.questions.map((question) => question.prompt).join('；');

  if (block.status === 'requested') {
    return prompts ? `等待回答 · ${prompts}` : '等待你的回答';
  }

  const answersByQuestion = new Map(
    (block.answers ?? []).map((answer) => [
      answer.questionId,
      Array.isArray(answer.value) ? answer.value.join('、') : answer.value,
    ]),
  );
  const resolved = block.questions
    .map((question) => {
      const answer = answersByQuestion.get(question.questionId);
      return answer ? `${question.prompt}：${answer}` : question.prompt;
    })
    .join('；');

  return resolved ? `已回答 · ${resolved}` : '已完成回答';
}

function getBlockLabel(block: AgentBlockState): string {
  switch (block.kind) {
    case 'thinking':
      return block.content || (block.status === 'streaming' ? '正在思考' : '思考完成');
    case 'tool':
      return getToolLabel(block);
    case 'hitl':
      return getInteractionLabel(block);
  }
}

function BlockKindIcon({ block }: { block: AgentBlockState }) {
  switch (block.kind) {
    case 'thinking':
      return <Sparkles size={13} />;
    case 'tool':
      return <Wrench size={13} />;
    case 'hitl':
      return <CircleAlert size={13} />;
  }
}

function BlockStatusIcon({ block }: { block: AgentBlockState }) {
  switch (block.kind) {
    case 'thinking':
      return block.status === 'streaming' ? (
        <LoaderCircle className='chat-run-spinner' size={13} />
      ) : (
        <Check size={13} />
      );
    case 'tool':
      if (block.status === 'running') {
        return <LoaderCircle className='chat-run-spinner' size={13} />;
      }
      return block.status === 'completed' ? <Check size={13} /> : <CircleAlert size={13} />;
    case 'hitl':
      return block.status === 'requested' ? (
        <LoaderCircle className='chat-run-spinner' size={13} />
      ) : (
        <Check size={13} />
      );
  }
}

function AgentBlockItem({ block }: { block: AgentBlockState }) {
  const label = getBlockLabel(block);

  return (
    <li className='chat-run-step' data-status={block.status}>
      <span className='chat-run-step-kind' aria-hidden='true'>
        <BlockKindIcon block={block} />
      </span>
      <span className='chat-run-step-label' title={label}>
        {label}
      </span>
      <span className='chat-run-step-status' aria-hidden='true'>
        <BlockStatusIcon block={block} />
      </span>
    </li>
  );
}

type HITLDraft = Partial<Record<string, string | string[]>>;

function hasHITLValue(value: string | string[] | undefined): boolean {
  return Array.isArray(value) ? value.length > 0 : Boolean(value?.trim());
}

function HITLQuestionField({
  question,
  value,
  onChange,
}: {
  question: HITLQuestion;
  value: string | string[] | undefined;
  onChange: (value: string | string[]) => void;
}) {
  if (question.options && question.multiple) {
    const selectedValues = Array.isArray(value) ? value : [];

    return (
      <fieldset className='chat-hitl-question'>
        <legend>{question.prompt}</legend>
        {question.options.map((option) => (
          <label key={option}>
            <input
              type='checkbox'
              checked={selectedValues.includes(option)}
              onChange={(event) => {
                onChange(
                  event.target.checked
                    ? [...selectedValues, option]
                    : selectedValues.filter((current) => current !== option),
                );
              }}
            />
            <span>{option}</span>
          </label>
        ))}
      </fieldset>
    );
  }

  if (question.options) {
    return (
      <label className='chat-hitl-question'>
        <span>{question.prompt}</span>
        <select
          value={typeof value === 'string' ? value : ''}
          required={question.required}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value=''>请选择</option>
          {question.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
    );
  }

  return (
    <label className='chat-hitl-question'>
      <span>{question.prompt}</span>
      <input
        type='text'
        value={typeof value === 'string' ? value : ''}
        required={question.required}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

/** requested 状态下提供一个最小可用表单，提交结果仍等待服务端 Envelope 确认。 */
function HITLResponseForm({ block }: { block: HITLInteractionState }) {
  const [draft, setDraft] = useState<HITLDraft>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSubmit = block.questions.every(
    (question) => !question.required || hasHITLValue(draft[question.questionId]),
  );

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!canSubmit || isSubmitting || isSubmitted) return;

    const answers: HITLAnswer[] = block.questions.flatMap((question) => {
      const value = draft[question.questionId];
      return hasHITLValue(value) && value !== undefined
        ? [{ questionId: question.questionId, value }]
        : [];
    });

    setIsSubmitting(true);
    setError(null);

    try {
      const dispatch = getIMService().respondToInteraction({
        threadId: block.threadId,
        runId: block.runId,
        interactionId: block.id,
        answers,
      });
      const ack = await dispatch.ack;

      if (!ack.ok) {
        throw new Error(ack.error.message);
      }

      setIsSubmitted(true);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '提交回答失败');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <li className='chat-hitl-step' data-status={block.status}>
      <form onSubmit={(event) => void handleSubmit(event)}>
        {block.questions.map((question) => (
          <HITLQuestionField
            key={question.questionId}
            question={question}
            value={draft[question.questionId]}
            onChange={(value) => {
              setDraft((current) => ({ ...current, [question.questionId]: value }));
              setError(null);
            }}
          />
        ))}

        <button type='submit' disabled={!canSubmit || isSubmitting || isSubmitted}>
          {isSubmitted ? '已提交，等待继续执行' : isSubmitting ? '提交中…' : '提交回答'}
        </button>
        {error ? <p role='alert'>{error}</p> : null}
      </form>
    </li>
  );
}

function AgentBlockList({ blocks }: { blocks: AgentBlockState[] }) {
  if (blocks.length === 0) return null;

  return (
    <ul className='chat-run-steps'>
      {blocks.map((block) =>
        block.kind === 'hitl' && block.status === 'requested' ? (
          <HITLResponseForm key={`${block.kind}:${block.id}`} block={block} />
        ) : (
          <AgentBlockItem key={`${block.kind}:${block.id}`} block={block} />
        ),
      )}
    </ul>
  );
}

function RunStatusIcon({ run }: { run: RunState }) {
  switch (run.status) {
    case 'pending':
    case 'running':
    case 'waiting_user':
      return <LoaderCircle className='chat-run-spinner' size={14} aria-hidden='true' />;
    case 'completed':
      return <Check size={14} aria-hidden='true' />;
    case 'failed':
      return <CircleAlert size={14} aria-hidden='true' />;
    case 'cancelled':
      return <Ban size={14} aria-hidden='true' />;
  }
}

function CompletedRunTrace({ blocks }: { blocks: AgentBlockState[] }) {
  if (blocks.length === 0) return null;

  return (
    <details className='chat-run-trace chat-run-trace-completed'>
      <summary>
        <span>Agent 过程</span>
        <small>{blocks.length} 个过程</small>
      </summary>
      <AgentBlockList blocks={blocks} />
    </details>
  );
}

function RunTraceContent({
  run,
  blocks,
  hideThinkingIndicator,
}: {
  run: RunState;
  blocks: AgentBlockState[];
  hideThinkingIndicator: boolean;
}) {
  const isActive = ACTIVE_RUN_STATUSES.has(run.status);
  const statusLabel = getRunStatusLabel(run);

  if (hideThinkingIndicator && isActive && blocks.length === 0) {
    return null;
  }

  if (run.status === 'completed') {
    return <CompletedRunTrace blocks={blocks} />;
  }

  return (
    <div className='chat-run-trace' data-status={run.status}>
      <div className='chat-run-heading'>
        {run.status === 'running' && !hideThinkingIndicator ? (
          <ThinkingIndicator />
        ) : (
          <>
            <RunStatusIcon run={run} />
            <span>{statusLabel}</span>
          </>
        )}
      </div>
      <AgentBlockList blocks={blocks} />
    </div>
  );
}

/** Agent Run 的轻量过程视图，只展示协议明确公开的 Thinking、Tool 和 HITL。 */
export function AgentRunTrace({
  threadId,
  runId,
  hideThinkingIndicator = false,
}: AgentRunTraceProps) {
  const detail = useIMStore((state) => state.detailsByThread[threadId]);
  const run = detail?.runs.find((current) => current.id === runId);

  if (!detail || !run) return null;

  const blocks = detail.blocks.filter((block) => block.runId === runId);

  return (
    <RunTraceContent run={run} blocks={blocks} hideThinkingIndicator={hideThinkingIndicator} />
  );
}
