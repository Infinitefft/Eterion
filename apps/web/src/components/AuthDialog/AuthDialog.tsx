import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useCallback, useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { useForm } from 'react-hook-form';

import { login, register as registerAccount } from '@/api/auth';
import { commitAuthSession } from '@/api/client';
import { getApiError } from '@/api/errors';
import {
  loginSchema,
  normalizeLoginPayload,
  normalizeRegisterPayload,
  registerSchema,
} from '@/features/auth/authSchemas';
import type { LoginFormValues, RegisterFormValues } from '@/features/auth/authSchemas';

import './AuthDialog.less';

type AuthMode = 'login' | 'register';

const greetingPhrases = [
  '欢迎来到 Eterion',
  '灵感，从一次对话开始',
  '让复杂的事情变得简单',
] as const;

type TypewriterState = {
  phraseIndex: number;
  visibleLength: number;
  phase: 'typing' | 'deleting';
};

const authModeCopy = {
  login: {
    title: '登录 Eterion',
    submit: '登录',
    switchPrompt: '还没有账号？',
    switchAction: '立即注册',
  },
  register: {
    title: '注册 Eterion 账号',
    submit: '注册并登录',
    switchPrompt: '已经有账号？',
    switchAction: '返回登录',
  },
} as const satisfies Record<AuthMode, Record<string, string>>;

/** 控制认证弹窗显示和关闭行为的外部参数。 */
type AuthDialogProps = {
  open: boolean;
  onClose: () => void;
};

/** 登录和注册共用的模态弹窗外壳，具体表单根据 mode 切换。 */
export function AuthDialog({ open, onClose }: AuthDialogProps) {
  const [mode, setMode] = useState<AuthMode>('login');
  const phoneId = useId();
  const nicknameId = useId();
  const passwordId = useId();
  const titleId = useId();
  const copy = authModeCopy[mode];
  const closeDialog = useCallback(() => {
    setMode('login');
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeDialog();
      }
    };

    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [closeDialog, open]);

  if (!open) {
    return null;
  }

  return createPortal(
    <div
      className='auth-overlay'
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          closeDialog();
        }
      }}
    >
      <section className='auth-dialog' role='dialog' aria-modal='true' aria-labelledby={titleId}>
        <button
          className='auth-close-button'
          type='button'
          aria-label='关闭登录窗口'
          onClick={closeDialog}
        >
          <X size={20} strokeWidth={2} />
        </button>

        <div className='auth-brand' aria-hidden='true'>
          <img src='/eterion-logo-black-transparent.png' alt='' />
        </div>
        <TypewriterGreeting />
        <h2 className='sr-only' id={titleId}>
          {copy.title}
        </h2>

        <AuthForm
          key={mode}
          mode={mode}
          phoneId={phoneId}
          nicknameId={nicknameId}
          passwordId={passwordId}
          onSuccess={closeDialog}
        />

        <button
          className='auth-switch-button'
          type='button'
          onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
        >
          <span>{copy.switchPrompt}</span>
          <strong>{copy.switchAction}</strong>
        </button>
      </section>
    </div>,
    document.body,
  );
}

type AuthFormProps = {
  /** 当前需要渲染和提交的认证模式。 */
  mode: AuthMode;
  /** 由弹窗统一生成的字段 ID，保证 label 与 input 正确关联。 */
  phoneId: string;
  nicknameId: string;
  passwordId: string;
  /** 登录或注册成功后关闭并重置弹窗。 */
  onSuccess: () => void;
};

/** 根据认证模式分发到类型独立的登录或注册表单。 */
function AuthForm(props: AuthFormProps) {
  return props.mode === 'login' ? <LoginForm {...props} /> : <RegisterForm {...props} />;
}

/** 登录表单：负责本地校验、请求提交和会话写入。 */
function LoginForm({ phoneId, passwordId, onSuccess }: AuthFormProps) {
  const form = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { phone: '', password: '' },
  });
  const mutation = useMutation({
    mutationFn: login,
    onSuccess: (session) => {
      commitAuthSession(session);
      onSuccess();
    },
    onError: (error) => applyLoginError(error, form.setError),
  });
  const phoneError = form.formState.errors.phone;
  const passwordError = form.formState.errors.password;
  const serverError = form.formState.errors.root?.server;

  const submit = (values: LoginFormValues) => {
    mutation.mutate(normalizeLoginPayload(values));
  };

  return (
    <form
      className='auth-form'
      onSubmit={(event) => {
        void form.handleSubmit(submit)(event);
      }}
    >
      <div className='auth-fields'>
        <div className='auth-field'>
          <label className='sr-only' htmlFor={phoneId}>
            手机号
          </label>
          <input
            {...form.register('phone')}
            id={phoneId}
            type='tel'
            inputMode='numeric'
            autoComplete='tel'
            placeholder='手机号'
            aria-invalid={phoneError ? true : undefined}
            aria-describedby={phoneError ? `${phoneId}-error` : undefined}
            autoFocus
          />
          <ValidationMessage error={phoneError} id={`${phoneId}-error`} />
        </div>

        <div className='auth-field'>
          <label className='sr-only' htmlFor={passwordId}>
            密码
          </label>
          <input
            {...form.register('password')}
            id={passwordId}
            type='password'
            autoComplete='current-password'
            placeholder='密码'
            aria-invalid={passwordError ? true : undefined}
            aria-describedby={passwordError ? `${passwordId}-error` : undefined}
          />
          <ValidationMessage error={passwordError} id={`${passwordId}-error`} />
        </div>
      </div>

      <ValidationMessage className='auth-form-error' error={serverError} />

      <button className='auth-submit-button' type='submit' disabled={mutation.isPending}>
        {mutation.isPending ? '正在登录…' : authModeCopy.login.submit}
      </button>
    </form>
  );
}

/** 注册表单：提交成功后直接使用后端创建的会话完成登录。 */
function RegisterForm({ phoneId, nicknameId, passwordId, onSuccess }: AuthFormProps) {
  const form = useForm<RegisterFormValues>({
    resolver: zodResolver(registerSchema),
    defaultValues: { phone: '', nickname: '', password: '' },
  });
  const mutation = useMutation({
    mutationFn: registerAccount,
    onSuccess: (session) => {
      commitAuthSession(session);
      onSuccess();
    },
    onError: (error) => applyRegisterError(error, form.setError),
  });
  const phoneError = form.formState.errors.phone;
  const nicknameError = form.formState.errors.nickname;
  const passwordError = form.formState.errors.password;
  const serverError = form.formState.errors.root?.server;

  const submit = (values: RegisterFormValues) => {
    mutation.mutate(normalizeRegisterPayload(values));
  };

  return (
    <form
      className='auth-form'
      onSubmit={(event) => {
        void form.handleSubmit(submit)(event);
      }}
    >
      <div className='auth-fields'>
        <div className='auth-field'>
          <label className='sr-only' htmlFor={phoneId}>
            手机号
          </label>
          <input
            {...form.register('phone')}
            id={phoneId}
            type='tel'
            inputMode='numeric'
            autoComplete='tel'
            placeholder='手机号'
            aria-invalid={phoneError ? true : undefined}
            aria-describedby={phoneError ? `${phoneId}-error` : undefined}
            autoFocus
          />
          <ValidationMessage error={phoneError} id={`${phoneId}-error`} />
        </div>

        <div className='auth-field'>
          <label className='sr-only' htmlFor={nicknameId}>
            昵称
          </label>
          <input
            {...form.register('nickname')}
            id={nicknameId}
            type='text'
            autoComplete='nickname'
            placeholder='昵称'
            aria-invalid={nicknameError ? true : undefined}
            aria-describedby={nicknameError ? `${nicknameId}-error` : undefined}
          />
          <ValidationMessage error={nicknameError} id={`${nicknameId}-error`} />
        </div>

        <div className='auth-field'>
          <label className='sr-only' htmlFor={passwordId}>
            密码
          </label>
          <input
            {...form.register('password')}
            id={passwordId}
            type='password'
            autoComplete='new-password'
            placeholder='密码（8-72 字节）'
            aria-invalid={passwordError ? true : undefined}
            aria-describedby={passwordError ? `${passwordId}-error` : undefined}
          />
          <ValidationMessage error={passwordError} id={`${passwordId}-error`} />
        </div>
      </div>

      <ValidationMessage className='auth-form-error' error={serverError} />

      <button className='auth-submit-button' type='submit' disabled={mutation.isPending}>
        {mutation.isPending ? '正在注册…' : authModeCopy.register.submit}
      </button>
    </form>
  );
}

type LoginErrorSetter = ReturnType<typeof useForm<LoginFormValues>>['setError'];
type RegisterErrorSetter = ReturnType<typeof useForm<RegisterFormValues>>['setError'];

/** 将登录接口的字段错误或通用错误写回 React Hook Form。 */
function applyLoginError(error: unknown, setError: LoginErrorSetter) {
  const apiError = getApiError(error);
  const fieldErrors = collectFieldErrors(apiError?.fields, ['phone', 'password'] as const);
  for (const fieldError of fieldErrors) {
    setError(fieldError.name, { message: fieldError.message });
  }
  if (fieldErrors.length > 0) {
    return;
  }

  setError('root.server', {
    message: apiError?.message ?? '暂时无法连接认证服务，请稍后重试',
  });
}

/** 将注册字段错误和手机号、昵称冲突映射到对应输入框。 */
function applyRegisterError(error: unknown, setError: RegisterErrorSetter) {
  const apiError = getApiError(error);
  const fieldErrors = collectFieldErrors(apiError?.fields, [
    'phone',
    'nickname',
    'password',
  ] as const);
  for (const fieldError of fieldErrors) {
    setError(fieldError.name, { message: fieldError.message });
  }
  if (fieldErrors.length > 0) {
    return;
  }

  const conflictField = getRegistrationConflictField(apiError?.code);
  if (apiError !== null && conflictField !== null) {
    setError(conflictField, { message: apiError.message });
    return;
  }

  setError('root.server', {
    message: apiError?.message ?? '暂时无法连接认证服务，请稍后重试',
  });
}

type AuthFieldName = 'phone' | 'nickname' | 'password';

/** 从后端 fields 中筛出当前表单实际支持的字段错误。 */
function collectFieldErrors<T extends AuthFieldName>(
  fields: Record<string, string> | undefined,
  allowedFields: readonly T[],
) {
  if (!fields) {
    return [];
  }

  return allowedFields.flatMap((name) => {
    const message = fields[name];
    return message ? [{ name, message }] : [];
  });
}

function getRegistrationConflictField(code: string | undefined): 'phone' | 'nickname' | null {
  if (code === 'AUTH_PHONE_EXISTS') {
    return 'phone';
  }
  return code === 'AUTH_NICKNAME_EXISTS' ? 'nickname' : null;
}

type ValidationMessageProps = {
  /** React Hook Form 返回的单个字段错误。 */
  error?: { message?: string };
  id?: string;
  /** 表单级错误可传入独立样式，默认使用字段错误样式。 */
  className?: string;
};

/** 统一渲染字段级和表单级错误消息。 */
function ValidationMessage({ error, id, className = 'auth-field-error' }: ValidationMessageProps) {
  if (!error?.message) {
    return null;
  }

  return (
    <p className={className} id={id} role={className === 'auth-form-error' ? 'alert' : undefined}>
      {error.message}
    </p>
  );
}

/** 展示认证弹窗顶部的循环打字欢迎语。 */
function TypewriterGreeting() {
  const prefersReducedMotion = usePrefersReducedMotion();
  const [typewriter, setTypewriter] = useState<TypewriterState>({
    phraseIndex: 0,
    visibleLength: 0,
    phase: 'typing',
  });
  const phraseCharacters = Array.from(greetingPhrases[typewriter.phraseIndex]);
  const hasFinishedTyping = typewriter.visibleLength >= phraseCharacters.length;
  const hasFinishedDeleting = typewriter.visibleLength === 0;
  const visibleText = prefersReducedMotion
    ? greetingPhrases[0]
    : phraseCharacters.slice(0, typewriter.visibleLength).join('');

  useEffect(() => {
    if (prefersReducedMotion) {
      return undefined;
    }

    const delay =
      typewriter.phase === 'typing'
        ? hasFinishedTyping
          ? 1650
          : 105
        : hasFinishedDeleting
          ? 420
          : 58;

    const timer = window.setTimeout(() => {
      setTypewriter((current) => {
        if (current.phase === 'typing') {
          if (current.visibleLength >= phraseCharacters.length) {
            return { ...current, phase: 'deleting' };
          }

          return { ...current, visibleLength: current.visibleLength + 1 };
        }

        if (current.visibleLength > 0) {
          return { ...current, visibleLength: current.visibleLength - 1 };
        }

        return {
          phraseIndex: (current.phraseIndex + 1) % greetingPhrases.length,
          visibleLength: 0,
          phase: 'typing',
        };
      });
    }, delay);

    return () => window.clearTimeout(timer);
  }, [
    hasFinishedDeleting,
    hasFinishedTyping,
    phraseCharacters.length,
    prefersReducedMotion,
    typewriter.phase,
    typewriter.visibleLength,
  ]);

  return (
    <div className='auth-typewriter' aria-hidden='true'>
      <span className='auth-typewriter-text'>{visibleText}</span>
      <span className='auth-typewriter-cursor' />
    </div>
  );
}

/** 监听系统减少动画偏好，让欢迎动画符合无障碍设置。 */
function usePrefersReducedMotion() {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updatePreference = () => setPrefersReducedMotion(mediaQuery.matches);

    mediaQuery.addEventListener('change', updatePreference);
    return () => mediaQuery.removeEventListener('change', updatePreference);
  }, []);

  return prefersReducedMotion;
}
