import { useQuery } from '@tanstack/react-query';
import {
  Check,
  ChevronDown,
  LoaderCircle,
  RefreshCw,
} from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

import { fetchChatModels, type ChatModel } from '@/service/im/rest';
import type { ModelId } from '@/service/im/types';
import { useAuthStore } from '@/store/authStore';

import './ModelList.less';

interface ModelListProps {
  /** 当前 Composer 选中的模型；null 表示使用服务端默认模型。 */
  value: ModelId | null;
  /** 用户选择模型时，只把稳定的模型 ID 交给 Composer。 */
  onChange(modelId: ModelId): void;
  /** 当前 Run 正在执行等场景下，可以暂时禁止切换模型。 */
  disabled?: boolean;
}

interface ModelIconProps {
  model: ChatModel;
}

/**
 * 模型图标。
 * 后端提供 iconUrl 时显示图片；没有图标或图片加载失败时显示模型名称首字。
 */
function ModelIcon({ model }: ModelIconProps) {
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    setImageFailed(false);
  }, [model.iconUrl]);

  if (model.iconUrl && !imageFailed) {
    return (
      <img
        className="model-list-icon-image"
        src={model.iconUrl}
        alt=""
        onError={() => setImageFailed(true)}
      />
    );
  }

  return (
    <span className="model-list-icon-fallback" aria-hidden="true">
      {model.name.trim().charAt(0).toUpperCase() || 'AI'}
    </span>
  );
}

/**
 * 模型选择器。
 * 模型目录属于服务端状态，由 TanStack Query 缓存；当前选择属于 Composer 的本地状态，
 * 通过 value/onChange 传递。组件本身不参与 WebSocket 通信。
 */
export default function ModelList({
  value,
  onChange,
  disabled = false,
}: ModelListProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const [open, setOpen] = useState(false);

  const isAuthenticated = useAuthStore((state) => state.user !== null);
  const modelQuery = useQuery({
    queryKey: ['chat', 'models'],
    queryFn: fetchChatModels,
    enabled: isAuthenticated,
    /** 模型目录很少变化，路由切换时直接复用缓存。 */
    staleTime: 5 * 60 * 1_000,
    retry: 1,
  });

  const models = modelQuery.data?.models ?? [];
  const defaultModelId = modelQuery.data?.defaultModelId ?? null;
  const selectedModel =
    models.find((model) => model.id === value) ??
    models.find((model) => model.id === defaultModelId) ??
    models[0] ??
    null;
  const isLoading = isAuthenticated && modelQuery.isPending;
  const isDisabled = disabled || !isAuthenticated;

  /** 点击组件外部或按下 Esc 时关闭浮层。 */
  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        !rootRef.current?.contains(event.target)
      ) {
        setOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  function handleSelect(modelId: ModelId) {
    onChange(modelId);
    setOpen(false);
  }

  function getTriggerLabel(): string {
    if (!isAuthenticated) return '登录后选择模型';
    if (selectedModel) return selectedModel.name;
    if (isLoading) return '正在加载模型';
    if (modelQuery.isError) return '模型加载失败';
    return '暂无可用模型';
  }

  return (
    <div className="model-list" ref={rootRef}>
      <button
        className="model-list-trigger"
        type="button"
        disabled={isDisabled}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={`当前模型：${getTriggerLabel()}`}
        onClick={() => setOpen((current) => !current)}
      >
        {selectedModel ? (
          <ModelIcon model={selectedModel} />
        ) : isLoading ? (
          <LoaderCircle className="model-list-spinner" size={15} />
        ) : (
          <span className="model-list-icon-fallback" aria-hidden="true">
            AI
          </span>
        )}

        <span className="model-list-trigger-label">{getTriggerLabel()}</span>
        <ChevronDown
          className="model-list-chevron"
          data-open={open}
          size={14}
          aria-hidden="true"
        />
      </button>

      {open ? (
        <div className="model-list-panel" id={panelId}>
          <div className="model-list-heading">
            <strong>选择模型</strong>
            <span>用于下一次回答</span>
          </div>

          {isLoading ? (
            <div className="model-list-state" aria-live="polite">
              <LoaderCircle className="model-list-spinner" size={17} />
              正在加载可用模型
            </div>
          ) : null}

          {modelQuery.isError && models.length === 0 ? (
            <div className="model-list-state is-error" role="alert">
              <span>{modelQuery.error.message || '模型列表加载失败'}</span>
              <button
                className="model-list-retry"
                type="button"
                onClick={() => void modelQuery.refetch()}
              >
                <RefreshCw size={14} />
                重新加载
              </button>
            </div>
          ) : null}

          {!isLoading && !modelQuery.isError && models.length === 0 ? (
            <div className="model-list-state">服务端暂未配置可用模型</div>
          ) : null}

          {models.length > 0 ? (
            <ul className="model-list-options" aria-label="可用模型">
              {models.map((model) => {
                const selected = model.id === selectedModel?.id;

                return (
                  <li key={model.id}>
                    <button
                      className="model-list-option"
                      type="button"
                      aria-pressed={selected}
                      data-selected={selected}
                      onClick={() => handleSelect(model.id)}
                    >
                      <ModelIcon model={model} />

                      <span className="model-list-option-copy">
                        <span className="model-list-option-name">
                          {model.name}
                          {model.id === defaultModelId ? (
                            <span className="model-list-default-badge">默认</span>
                          ) : null}
                        </span>
                        <span className="model-list-provider">
                          {model.provider || model.id}
                        </span>
                      </span>

                      <Check
                        className="model-list-check"
                        size={16}
                        aria-hidden="true"
                      />
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
