import { X } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';

import './AuthDialog.less';

type AuthMode = 'login' | 'register';

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
    nextMode: 'register',
  },
  register: {
    accountLabel: '手机号',
    accountPlaceholder: '手机号',
    accountAutoComplete: 'tel',
    passwordAutoComplete: 'new-password',
    title: '注册 Eterion 账号',
    submit: '注册并登录',
    switchPrompt: '已有账号？',
    switchAction: '返回登录',
    nextMode: 'login',
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

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [onClose, open]);

  if (!open) {
    return null;
  }

  return createPortal(
    <div
      className='auth-overlay'
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
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
          onClick={onClose}
        >
          <X size={20} strokeWidth={2} />
        </button>

        <div className='auth-brand' aria-hidden='true'>
          <img src='/eterion-logo-black-transparent.png' alt='' />
        </div>
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

        <button
          className='auth-switch-button'
          type='button'
          onClick={() => setMode(copy.nextMode)}
        >
          <span>{copy.switchPrompt}</span>
          <strong>{copy.switchAction}</strong>
        </button>
      </section>
    </div>,
    document.body,
  );
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
