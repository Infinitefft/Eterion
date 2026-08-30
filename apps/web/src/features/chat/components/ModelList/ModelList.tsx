import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, LoaderCircle, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { fetchChatModels, type ChatModel, type ChatModelCatalog } from '@/api/im';
import type { ModelId } from '@/service/im/types';
import { useAuthStore } from '@/store/authStore';

import './ModelList.less';

interface ModelListProps {
  /** 当前 Composer 选中的模型；null 表示使用服务端默认模型。 */
  value: ModelId | null;
  /** 用户选择模型时，只把稳定的模型 ID 交给 Composer。 */
  onChange: (modelId: ModelId) => void;
  /** 当前 Run 正在执行等场景下，可以暂时禁止切换模型。 */
  disabled?: boolean;
  /** 指定展开方向；不传时桌面端向下、移动端向上。 */
  side?: 'top' | 'bottom';
}

interface ModelIconProps {
  model: ChatModel;
}

const EMPTY_MODELS: ChatModel[] = [];

const MOBILE_MODEL_LIST_QUERY = '(max-width: 640px)';

function getIsMobileModelList(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(MOBILE_MODEL_LIST_QUERY).matches
    : false;
}

function useMobileModelList(): boolean {
  const [isMobile, setIsMobile] = useState(getIsMobileModelList);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;

    const mediaQuery = window.matchMedia(MOBILE_MODEL_LIST_QUERY);
    const handleChange = (event: MediaQueryListEvent) => setIsMobile(event.matches);

    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  return isMobile;
}

/**
 * 模型图标。
 * 后端提供 iconUrl 时显示图片；没有图标或图片加载失败时显示模型名称首字。
 */
function ModelIcon({ model }: ModelIconProps) {
  const [failedIconUrl, setFailedIconUrl] = useState<string | null>(null);

  if (model.iconUrl && failedIconUrl !== model.iconUrl) {
    return (
      <img
        className='model-list-icon-image'
        src={model.iconUrl}
        alt=''
        onError={() => setFailedIconUrl(model.iconUrl)}
      />
    );
  }

  return (
    <span className='model-list-icon-fallback' aria-hidden='true'>
      {model.modelName.trim().charAt(0).toUpperCase() || 'AI'}
    </span>
  );
}

function resolveSelectedModel(
  models: ChatModel[],
  value: ModelId | null,
  defaultModelId: ModelId | null,
) {
  return (
    models.find((model) => model.id === value) ??
    models.find((model) => model.id === defaultModelId) ??
    models.at(0) ??
    null
  );
}

function getTriggerLabel(
  isAuthenticated: boolean,
  selectedModel: ChatModel | null,
  isLoading: boolean,
  isError: boolean,
) {
  if (!isAuthenticated) return '登录后选择模型';
  if (selectedModel) return selectedModel.modelName;
  if (isLoading) return '正在加载模型';
  if (isError) return '模型加载失败';
  return '暂无可用模型';
}

function ModelTriggerIcon({ model, isLoading }: { model: ChatModel | null; isLoading: boolean }) {
  if (model) return <ModelIcon model={model} />;
  if (isLoading) return <LoaderCircle className='model-list-spinner' size={15} />;
  return (
    <span className='model-list-icon-fallback' aria-hidden='true'>
      AI
    </span>
  );
}

interface ModelMenuContentProps {
  models: ChatModel[];
  selectedModelId: ModelId | null;
  isLoading: boolean;
  errorMessage: string | null;
  onChange: (modelId: ModelId) => void;
  onRetry: () => void;
}

function ModelMenuContent({
  models,
  selectedModelId,
  isLoading,
  errorMessage,
  onChange,
  onRetry,
}: ModelMenuContentProps) {
  if (isLoading) {
    return (
      <div className='model-list-state' aria-live='polite'>
        <LoaderCircle className='model-list-spinner' size={17} />
        正在加载可用模型
      </div>
    );
  }
  if (errorMessage && models.length === 0) {
    return (
      <div className='model-list-state is-error' role='alert'>
        <span>{errorMessage}</span>
        <button className='model-list-retry' type='button' onClick={onRetry}>
          <RefreshCw size={14} />
          重新加载
        </button>
      </div>
    );
  }
  if (models.length === 0) {
    return <div className='model-list-state'>服务端暂未配置可用模型</div>;
  }
  return (
    <DropdownMenu.RadioGroup
      className='model-list-options'
      value={selectedModelId ?? ''}
      aria-label='可用模型'
      onValueChange={onChange}
    >
      {models.map((model) => (
        <DropdownMenu.RadioItem className='model-list-option' key={model.id} value={model.id}>
          <ModelIcon model={model} />
          <span className='model-list-option-name' title={model.modelName}>
            {model.modelName}
          </span>
        </DropdownMenu.RadioItem>
      ))}
    </DropdownMenu.RadioGroup>
  );
}

function getModelErrorMessage(isError: boolean, error: Error | null) {
  if (!isError) return null;
  const message = error?.message.trim();
  return message ? message : '模型列表加载失败';
}

function createModelListViewState({
  catalog,
  value,
  isAuthenticated,
  isPending,
  isError,
  error,
  disabled,
}: {
  catalog: ChatModelCatalog | undefined;
  value: ModelId | null;
  isAuthenticated: boolean;
  isPending: boolean;
  isError: boolean;
  error: Error | null;
  disabled: boolean;
}) {
  const models = catalog?.models ?? EMPTY_MODELS;
  const defaultModelId = catalog?.defaultModelId ?? null;
  const selectedModel = resolveSelectedModel(models, value, defaultModelId);
  const isLoading = isAuthenticated && isPending;

  return {
    models,
    selectedModel,
    selectedModelId: selectedModel?.id ?? null,
    isLoading,
    isDisabled: disabled || !isAuthenticated,
    triggerLabel: getTriggerLabel(isAuthenticated, selectedModel, isLoading, isError),
    errorMessage: getModelErrorMessage(isError, error),
  };
}

/**
 * 模型选择器。
 * 模型目录属于服务端状态，由 TanStack Query 缓存；当前选择属于 Composer 的本地状态，
 * 通过 value/onChange 传递。组件本身不参与 WebSocket 通信。
 */
export default function ModelList({ value, onChange, disabled = false, side }: ModelListProps) {
  const [open, setOpen] = useState(false);
  const dismissedByPointerRef = useRef(false);
  const isMobile = useMobileModelList();
  const menuSide = side ?? (isMobile ? 'top' : 'bottom');

  const isAuthenticated = useAuthStore((state) => state.user !== null);
  const modelQuery = useQuery({
    queryKey: ['chat', 'models'],
    queryFn: () => fetchChatModels(),
    enabled: isAuthenticated,
    /** 模型目录很少变化，路由切换时直接复用缓存。 */
    staleTime: 5 * 60 * 1_000,
    retry: 1,
  });

  const {
    models,
    selectedModel,
    selectedModelId,
    isLoading,
    isDisabled,
    triggerLabel,
    errorMessage,
  } = createModelListViewState({
    catalog: modelQuery.data,
    value,
    isAuthenticated,
    isPending: modelQuery.isPending,
    isError: modelQuery.isError,
    error: modelQuery.error,
    disabled,
  });

  return (
    <DropdownMenu.Root open={open && !isDisabled} onOpenChange={setOpen}>
      <div className='model-list'>
        <DropdownMenu.Trigger asChild>
          <button
            className='model-list-trigger'
            type='button'
            disabled={isDisabled}
            aria-label={`当前模型：${triggerLabel}`}
          >
            <ModelTriggerIcon model={selectedModel} isLoading={isLoading} />
            <span className='model-list-trigger-label'>{triggerLabel}</span>
            <ChevronDown
              className='model-list-chevron'
              data-open={open}
              data-side={menuSide}
              size={14}
              aria-hidden='true'
            />
          </button>
        </DropdownMenu.Trigger>

        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className='model-list-panel'
            side={menuSide}
            align='end'
            sideOffset={6}
            avoidCollisions={false}
            onPointerDownCapture={() => {
              dismissedByPointerRef.current = true;
            }}
            onKeyDownCapture={() => {
              dismissedByPointerRef.current = false;
            }}
            onPointerDownOutside={() => {
              dismissedByPointerRef.current = true;
            }}
            onCloseAutoFocus={(event) => {
              if (!dismissedByPointerRef.current) return;

              event.preventDefault();
              dismissedByPointerRef.current = false;
            }}
          >
            <ModelMenuContent
              models={models}
              selectedModelId={selectedModelId}
              isLoading={isLoading}
              errorMessage={errorMessage}
              onChange={onChange}
              onRetry={() => void modelQuery.refetch()}
            />
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </div>
    </DropdownMenu.Root>
  );
}
