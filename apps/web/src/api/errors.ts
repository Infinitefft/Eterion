import axios from 'axios';

import type { ApiErrorBody, ApiErrorResponse } from '@/api/types';

export function getApiError(error: unknown): ApiErrorBody | null {
  if (!axios.isAxiosError<ApiErrorResponse>(error)) {
    return null;
  }

  return error.response?.data.error ?? null;
}

export function isApiErrorCode(error: unknown, codes: ReadonlySet<string>) {
  const apiError = getApiError(error);
  return apiError !== null && codes.has(apiError.code);
}
