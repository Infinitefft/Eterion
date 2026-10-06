import { Ban, Check, ChevronDown, CircleAlert, LoaderCircle, Sparkles, Wrench } from 'lucide-react';
import { Fragment, useId, useState, type FormEvent } from 'react';

import thinkingProcessIcon from '@/assets/icons/thinking-process.png';
import { getIMService } from '@/service/im';
import type {
  AgentBlockState,
  HITLAnswer,
  HITLInteractionState,
  HITLQuestion,
  RunId,
  RunState,
  RunStatus,
  ThreadId,
} from '@/service/im/types';
import { useIMStore } from '@/store/im-store';

import { ThinkingBlock } from './ThinkingBlock';
import { ThinkingIndicator } from './ThinkingIndicator';
import { ToolCallItem } from './ToolCallItem';
import type { KnowledgeSource } from './KnowledgeSources';

interface AgentRunTraceProps {
  threadId: ThreadId;
  runId: RunId;
  hideThinkingIndicator?: boolean;
  content?: string;
  onOpenSource?: (source: KnowledgeSource) => void;
}

const ACTIVE_RUN_STATUSES = new Set<RunStatus>(['pending', 'running', 'waiting_user']);

function getRunStatusLabel(run: RunState): string {
  switch (run.status) {
    case 'pending':
      return '正在准备';
    case 'running':
      return '正在思考';
    case 'waiting_user':
      return '等待你的回答';
    case 'failed':
      return run.error?.message || '本次运行失败';
    case 'cancelled':
      return '本次运行已停止';
    case 'completed':
      return 'Agent 过程';
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
      return block.displayName || block.name;
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
function HITLResponseForm({ block, runStatus }: { block: HITLInteractionState; runStatus?: RunStatus }) {
  const [draft, setDraft] = useState<HITLDraft>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isClosed = runStatus !== undefined && !ACTIVE_RUN_STATUSES.has(runStatus);
  const isWaiting = runStatus === 'waiting_user';
  const canSubmit = block.questions.every(
    (question) => !question.required || hasHITLValue(draft[question.questionId]),
  );

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!isWaiting || !canSubmit || isSubmitting || isSubmitted) return;

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
        <fieldset disabled={!isWaiting || isSubmitting || isSubmitted} className='chat-hitl-fields'>
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
        </fieldset>

        <button type='submit' disabled={!isWaiting || !canSubmit || isSubmitting || isSubmitted}>
          {isClosed ? '本次交互已结束' : isSubmitted ? '已提交，等待继续执行' : isSubmitting ? '提交中…' : '提交回答'}
        </button>
        {error ? <p role='alert'>{error}</p> : null}
      </form>
    </li>
  );
}

function AgentBlockList({ blocks, onOpenSource, runStatus }: {
  blocks: AgentBlockState[];
  runStatus?: RunStatus;
  onOpenSource?: (source: KnowledgeSource) => void;
}) {
  if (blocks.length === 0) return null;

  return (
    <ul className='chat-run-steps'>
      {blocks.map((block) =>
        block.kind === 'thinking' ? (
          <ThinkingBlock key={`${block.kind}:${block.id}`} block={block} />
        ) : block.kind === 'tool' ? (
          <ToolCallItem key={`${block.kind}:${block.id}`} block={block} onOpenSource={onOpenSource} />
        ) : block.kind === 'hitl' && block.status === 'requested' ? (
          <HITLResponseForm key={`${block.kind}:${block.id}`} block={block} runStatus={runStatus} />
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

/** 正文首次出现时收起一次，后续正文增量不覆盖用户的手动展开选择。 */
function RunProcess({ blocks, run, hasContent, isCurrent, onOpenSource }: {
  blocks: AgentBlockState[];
  run: RunState;
  hasContent: boolean;
  isCurrent: boolean;
  onOpenSource?: (source: KnowledgeSource) => void;
}) {
  const [view, setView] = useState({ hasContent, expanded: !hasContent });
  const contentId = useId();
  if (view.hasContent !== hasContent) {
    setView({ hasContent, expanded: !hasContent });
  }
  const isWorking = isCurrent && (run.status === 'running' || run.status === 'pending');

  return (
    <div className='chat-run-process'>
      <button type='button' className='chat-run-process-heading'
        aria-expanded={view.expanded} aria-controls={contentId}
        onClick={() => setView({ hasContent, expanded: !view.expanded })}>
        <img src={thinkingProcessIcon} width={18} height={18} alt='' aria-hidden='true'
          className={isWorking ? 'chat-run-process-icon is-active' : 'chat-run-process-icon'} />
        <span>思考过程</span>
        <ChevronDown size={14} className={view.expanded ? 'chat-tool-chevron is-expanded' : 'chat-tool-chevron'} aria-hidden='true' />
      </button>
      <div id={contentId} hidden={!view.expanded}>
        <AgentBlockList blocks={blocks} onOpenSource={onOpenSource} runStatus={run.status} />
      </div>
    </div>
  );
}

function RunTraceContent({ run, blocks, hideThinkingIndicator, hasContent, isCurrent, onOpenSource }: {
  run: RunState;
  blocks: AgentBlockState[];
  hideThinkingIndicator: boolean;
  hasContent: boolean;
  isCurrent: boolean;
  onOpenSource?: (source: KnowledgeSource) => void;
}) {
  const isActive = ACTIVE_RUN_STATUSES.has(run.status);
  const processBlocks = blocks.filter((block) => block.kind !== 'hitl');
  const showHeading = isCurrent && run.status !== 'completed' &&
    !(isActive && (processBlocks.length > 0 || hideThinkingIndicator));

  if (blocks.length === 0 && !showHeading) return null;

  return (
    <div className='chat-run-trace' data-status={run.status}>
      {showHeading ? (
        <div className='chat-run-heading'>
          {run.status === 'running' ? <ThinkingIndicator /> : (
            <><RunStatusIcon run={run} /><span>{getRunStatusLabel(run)}</span></>
          )}
        </div>
      ) : null}
      {processBlocks.length > 0 ? (
        <RunProcess blocks={processBlocks} run={run} hasContent={hasContent} isCurrent={isCurrent} onOpenSource={onOpenSource} />
      ) : null}
    </div>
  );
}

/** Agent Run 的轻量过程视图，只展示协议明确公开的 Thinking、Tool 和 HITL。 */
export function AgentRunTrace({
  threadId,
  runId,
  hideThinkingIndicator = false,
  content,
  onOpenSource,
}: AgentRunTraceProps) {
  const detail = useIMStore((state) => state.detailsByThread[threadId]);
  const run = detail?.runs.find((current) => current.id === runId);

  if (!detail || !run) {
    return content ? <p className='chat-message-text'>{content}</p> : null;
  }

  const blocks = detail.blocks.filter((block) => block.runId === runId);
  // 块数组保留发生顺序，即使 HITL 和恢复后的思考处于同一正文位置，也能划分为两段。
  const text = content ?? '';
  const sections: { key: string; blocks: AgentBlockState[]; content: string; interaction?: HITLInteractionState }[] = [];
  let section: (typeof sections)[number] = { key: 'start', blocks: [], content: '' };
  let cursor = 0;
  for (const block of blocks) {
    if (block.kind !== 'hitl') {
      section.blocks.push(block);
      continue;
    }
    const offset = block.contentOffset;
    const end = offset !== undefined && Number.isInteger(offset) && offset >= 0
      ? Math.max(cursor, Math.min(offset, text.length))
      : text.length;
    section.content = text.slice(cursor, end);
    section.interaction = block;
    sections.push(section);
    section = { key: `after:${block.id}`, blocks: [], content: '' };
    cursor = end;
  }
  section.content = text.slice(cursor);
  sections.push(section);

  return (
    <>
      {sections.map((part, index) => (
        <Fragment key={part.key}>
          <RunTraceContent run={run} blocks={part.blocks} hideThinkingIndicator={hideThinkingIndicator || run.status === 'waiting_user'}
            isCurrent={index === sections.length - 1} hasContent={Boolean(part.content.trim())} onOpenSource={onOpenSource} />
          {part.content ? <p className='chat-message-text'>{part.content}</p> : null}
          {part.interaction ? (
            <AgentBlockList blocks={[part.interaction]} runStatus={run.status} onOpenSource={onOpenSource} />
          ) : null}
        </Fragment>
      ))}
    </>
  );
}
