import { z } from 'zod';

import type { LoginRequest, RegisterRequest } from '@/types/auth';

const phonePattern = /^1[3-9][0-9]{9}$/;
const controlCharacterPattern = /\p{Cc}/u;
const textEncoder = new TextEncoder();

/** 登录和注册共用的中国大陆手机号校验。 */
const phoneSchema = z
  .string()
  .refine((value) => phonePattern.test(value.trim()), '请输入有效的中国大陆手机号');

/** 与后端保持一致，密码长度按 UTF-8 字节数而不是 JavaScript 字符数计算。 */
const passwordSchema = z.string().refine((value) => {
  const byteLength = textEncoder.encode(value).byteLength;
  return byteLength >= 8 && byteLength <= 72;
}, '密码长度须为 8-72 字节');

/** 昵称规范化后校验 Unicode 字符数量，并拒绝控制字符。 */
const nicknameSchema = z.string().refine((value) => {
  const normalized = normalizeNickname(value);
  const characterCount = Array.from(normalized).length;
  return characterCount >= 2 && characterCount <= 32 && !controlCharacterPattern.test(normalized);
}, '昵称须为 2-32 个字符且不能包含控制字符');

/** 登录表单的运行时校验规则，并作为 LoginFormValues 的类型来源。 */
export const loginSchema = z.object({
  phone: phoneSchema,
  password: passwordSchema,
});

/** 注册表单在登录规则基础上追加昵称校验。 */
export const registerSchema = loginSchema.extend({
  nickname: nicknameSchema,
});

/** 由登录校验规则推导出的表单值类型。 */
export type LoginFormValues = z.infer<typeof loginSchema>;
/** 由注册校验规则推导出的表单值类型。 */
export type RegisterFormValues = z.infer<typeof registerSchema>;

/** 将登录表单值整理成后端 LoginRequest，避免把输入空格带入请求。 */
export function normalizeLoginPayload(values: LoginFormValues): LoginRequest {
  return {
    phone: values.phone.trim(),
    password: values.password,
  };
}

/** 将注册表单值整理成后端 RegisterRequest，并统一昵称的 Unicode 表示。 */
export function normalizeRegisterPayload(values: RegisterFormValues): RegisterRequest {
  return {
    ...normalizeLoginPayload(values),
    nickname: normalizeNickname(values.nickname),
  };
}

/** 生成与后端昵称判重规则一致的 NFKC 标准形式。 */
function normalizeNickname(value: string) {
  return value.trim().normalize('NFKC');
}
