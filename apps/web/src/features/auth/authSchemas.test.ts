import { describe, expect, it } from 'vitest';

import { loginSchema, normalizeRegisterPayload, registerSchema } from '@/features/auth/authSchemas';

describe('auth form schemas', () => {
  it('accepts a valid login payload', () => {
    expect(loginSchema.safeParse({ phone: '13800138000', password: 'password-123' }).success).toBe(
      true,
    );
  });

  it('rejects an invalid phone number', () => {
    expect(loginSchema.safeParse({ phone: '12800138000', password: 'password-123' }).success).toBe(
      false,
    );
  });

  it('validates password length by UTF-8 bytes', () => {
    expect(loginSchema.safeParse({ phone: '13800138000', password: '密'.repeat(24) }).success).toBe(
      true,
    );
    expect(loginSchema.safeParse({ phone: '13800138000', password: '密'.repeat(25) }).success).toBe(
      false,
    );
  });

  it('normalizes nickname and phone before registration', () => {
    const values = {
      phone: ' 13800138000 ',
      nickname: ' Ｅterion ',
      password: 'password-123',
    };

    expect(registerSchema.safeParse(values).success).toBe(true);
    expect(normalizeRegisterPayload(values)).toEqual({
      phone: '13800138000',
      nickname: 'Eterion',
      password: 'password-123',
    });
  });
});
