import { Ban, Check, CircleAlert, LoaderCircle, Search, Sparkles, Wrench } from 'lucide-react';
import { useStore } from 'zustand';

import { imStore } from '@/service/im';
import type { AgentRun, AgentRunStatus, AgentStep, RunId, StepId } from '@/service/im/types';

import { ThinkingIndicator } from './ThinkingIndicator';

interface AgentRunTraceProps {
  runId: RunId;
  hideThinkingIndicator?: boolean;
}

interface AgentStepItemProps {
  stepId: StepId;
}

const ACTIVE_RUN_STATUSES = new Set<AgentRunStatus>([
  'created',
  'queued',
  'running',
  'calling_tool',
  'calling_skill',
  'retrieving',
  'streaming',
  'waiting_user',
]);

function getRunStatusLabel(run: AgentRun): string {
  switch (run.status) {
    case 'created':
    case 'queued':
      return '正在准备';
    case 'running':
      return '正在思考';
    case 'calling_tool':
      return '正在调用工具';
    case 'calling_skill':
      return '正在使用 Skill';
    case 'retrieving':
      return '正在检索资料';
    case 'streaming':
      return '正在生成回答';
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

function getStepLabel(step: AgentStep): string {
  switch (step.kind) {
    case 'reasoning':
      return step.summary || step.title || '正在分析问题';
    case 'tool':
      return `调用工具 · ${step.tool.name}`;
    case 'skill':
      return `使用 Skill · ${step.skill.name}`;
    case 'retrieval':
      return step.query ? `检索资料 · ${step.query}` : '检索相关资料';
  }
}

function StepKindIcon({ step }: { step: AgentStep }) {
  switch (step.kind) {
    case 'tool':
      return <Wrench size={13} />;
    case 'skill':
      return <Sparkles size={13} />;
    case 'retrieval':
      return <Search size={13} />;
    case 'reasoning':
      return <Sparkles size={13} />;
  }
}

function StepStatusIcon({ step }: { step: AgentStep }) {
  switch (step.status) {
    case 'pending':
    case 'running':
      return <LoaderCircle className='chat-run-spinner' size={13} />;
    case 'completed':
      return <Check size={13} />;
    case 'failed':
      return <CircleAlert size={13} />;
    case 'cancelled':
      return <Ban size={13} />;
  }
}

/** 每个 Step 独立订阅，工具进度变化不会重渲染其他步骤。 */
function AgentStepItem({ stepId }: AgentStepItemProps) {
  const step = useStore(imStore, (state) => state.stepsById[stepId]);

  if (!step) return null;

  return (
    <li className='chat-run-step' data-status={step.status}>
      <span className='chat-run-step-kind' aria-hidden='true'>
        <StepKindIcon step={step} />
      </span>
      <span className='chat-run-step-label'>{getStepLabel(step)}</span>
      <span className='chat-run-step-status' aria-hidden='true'>
        <StepStatusIcon step={step} />
      </span>
    </li>
  );
}

function AgentStepList({ stepIds }: { stepIds: StepId[] }) {
  if (stepIds.length === 0) return null;

  return (
    <ul className='chat-run-steps'>
      {stepIds.map((stepId) => (
        <AgentStepItem key={stepId} stepId={stepId} />
      ))}
    </ul>
  );
}

/**
 * Agent Run 的轻量过程视图。
 * 当前只展示公开摘要、工具名、Skill 名和检索关键词，不展示隐藏思维链。
 */
export function AgentRunTrace({ runId, hideThinkingIndicator = false }: AgentRunTraceProps) {
  const run = useStore(imStore, (state) => state.runsById[runId]);

  if (!run) return null;

  const isActive = ACTIVE_RUN_STATUSES.has(run.status);
  const statusLabel = getRunStatusLabel(run);

  if (hideThinkingIndicator && (run.status === 'running' || run.status === 'streaming')) {
    return null;
  }

  if (run.status === 'streaming') {
    return (
      <div className='chat-assistant-thinking'>
        <ThinkingIndicator />
      </div>
    );
  }

  if (!isActive && run.status === 'completed' && run.stepIds.length === 0) {
    return null;
  }

  if (!isActive && run.status === 'completed') {
    return (
      <details className='chat-run-trace chat-run-trace-completed'>
        <summary>
          <span>{statusLabel}</span>
          <small>{run.stepIds.length} 个步骤</small>
        </summary>
        <AgentStepList stepIds={run.stepIds} />
      </details>
    );
  }

  return (
    <div className='chat-run-trace' data-status={run.status}>
      <div className='chat-run-heading'>
        {run.status === 'running' ? null : isActive ? (
          <LoaderCircle className='chat-run-spinner' size={14} aria-hidden='true' />
        ) : (
          <CircleAlert size={14} aria-hidden='true' />
        )}
        {run.status === 'running' ? <ThinkingIndicator /> : <span>{statusLabel}</span>}
      </div>
      <AgentStepList stepIds={run.stepIds} />
    </div>
  );
}
