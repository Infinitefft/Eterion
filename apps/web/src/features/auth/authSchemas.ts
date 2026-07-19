import { z } from 'zod';

import type { LoginRequest, RegisterRequest } from '@/api/types';

const phonePattern = /^1[3-9][0-9]{9}$/;
const controlCharacterPattern = /\p{Cc}/u;
const textEncoder = new TextEncoder();

const phoneSchema = z
  .string()
  .refine((value) => phonePattern.test(value.trim()), '请输入有效的中国大陆手机号');

const passwordSchema = z.string().refine((value) => {
  const byteLength = textEncoder.encode(value).byteLength;
  return byteLength >= 8 && byteLength <= 72;
}, '密码长度须为 8-72 字节');

const nicknameSchema = z.string().refine((value) => {
  const normalized = normalizeNickname(value);
  const characterCount = Array.from(normalized).length;
  return characterCount >= 2 && characterCount <= 32 && !controlCharacterPattern.test(normalized);
}, '昵称须为 2-32 个字符且不能包含控制字符');

export const loginSchema = z.object({
  phone: phoneSchema,
  password: passwordSchema,
});

export const registerSchema = loginSchema.extend({
  nickname: nicknameSchema,
});

export type LoginFormValues = z.infer<typeof loginSchema>;
export type RegisterFormValues = z.infer<typeof registerSchema>;

export function normalizeLoginPayload(values: LoginFormValues): LoginRequest {
  return {
    phone: values.phone.trim(),
    password: values.password,
  };
}

export function normalizeRegisterPayload(values: RegisterFormValues): RegisterRequest {
  return {
    ...normalizeLoginPayload(values),
    nickname: normalizeNickname(values.nickname),
  };
}

function normalizeNickname(value: string) {
  return value.trim().normalize('NFKC');
}
