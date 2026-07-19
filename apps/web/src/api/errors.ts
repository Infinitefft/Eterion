import axios from 'axios';

import type { ApiErrorBody, ApiErrorResponse } from '@/types/api';

/** 从任意异常中安全提取后端标准业务错误，非 Axios 错误返回 null。 */
export function getApiError(error: unknown): ApiErrorBody | null {
  if (!axios.isAxiosError<ApiErrorResponse>(error)) {
    return null;
  }

  return error.response?.data.error ?? null;
}

/** 判断异常是否命中给定的一组后端业务错误码。 */
export function isApiErrorCode(error: unknown, codes: ReadonlySet<string>) {
  const apiError = getApiError(error);
  return apiError !== null && codes.has(apiError.code);
}
