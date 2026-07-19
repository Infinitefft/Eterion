import { X } from 'lucide-react';
import { useCallback, useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';

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
    accountLabel: '账号或手机号',
    accountPlaceholder: '账号（手机号）',
    accountAutoComplete: 'username',
    passwordAutoComplete: 'current-password',
    title: '登录 Eterion',
    submit: '登录',
    switchPrompt: '还没有账号？',
    switchAction: '立即注册',
  },
  register: {
    accountLabel: '手机号',
    accountPlaceholder: '手机号',
    accountAutoComplete: 'tel',
    passwordAutoComplete: 'new-password',
    title: '注册 Eterion 账号',
    submit: '注册并登录',
  },
} as const satisfies Record<AuthMode, Record<string, string>>;

type AuthDialogProps = {
  open: boolean;
  onClose: () => void;
};

export function AuthDialog({ open, onClose }: AuthDialogProps) {
  const [mode, setMode] = useState<AuthMode>('login');
  const accountId = useId();
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
      <section
        className='auth-dialog'
        role='dialog'
        aria-modal='true'
        aria-labelledby={titleId}
      >
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

        <form className='auth-form' onSubmit={(event) => event.preventDefault()}>
          <AuthFields
            mode={mode}
            accountId={accountId}
            nicknameId={nicknameId}
            passwordId={passwordId}
          />

          <button className='auth-submit-button' type='submit'>
            {copy.submit}
          </button>
        </form>

        {mode === 'login' ? (
          <button
            className='auth-switch-button'
            type='button'
            onClick={() => setMode('register')}
          >
            <span>{authModeCopy.login.switchPrompt}</span>
            <strong>{authModeCopy.login.switchAction}</strong>
          </button>
        ) : null}
      </section>
    </div>,
    document.body,
  );
}

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

function usePrefersReducedMotion() {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(() =>
    window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updatePreference = () => setPrefersReducedMotion(mediaQuery.matches);

    mediaQuery.addEventListener('change', updatePreference);
    return () => mediaQuery.removeEventListener('change', updatePreference);
  }, []);

  return prefersReducedMotion;
}

type AuthFieldsProps = {
  mode: AuthMode;
  accountId: string;
  nicknameId: string;
  passwordId: string;
};

function AuthFields({ mode, accountId, nicknameId, passwordId }: AuthFieldsProps) {
  const copy = authModeCopy[mode];

  return (
    <div className='auth-fields'>
      <div className='auth-field'>
        <label className='sr-only' htmlFor={accountId}>
          {copy.accountLabel}
        </label>
        <input
          id={accountId}
          name='account'
          type='text'
          autoComplete={copy.accountAutoComplete}
          placeholder={copy.accountPlaceholder}
          autoFocus
        />
      </div>

      {mode === 'register' ? (
        <div className='auth-field'>
          <label className='sr-only' htmlFor={nicknameId}>
            昵称
          </label>
          <input
            id={nicknameId}
            name='nickname'
            type='text'
            autoComplete='nickname'
            placeholder='昵称'
          />
        </div>
      ) : null}

      <div className='auth-field'>
        <label className='sr-only' htmlFor={passwordId}>
          密码
        </label>
        <input
          id={passwordId}
          name='password'
          type='password'
          autoComplete={copy.passwordAutoComplete}
          placeholder='密码'
        />
      </div>
    </div>
  );
}
