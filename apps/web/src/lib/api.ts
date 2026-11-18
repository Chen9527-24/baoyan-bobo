import type { Bootstrap } from './types';

export class ApiError extends Error { constructor(message:string, public status:number, public code?:string) { super(message); } }

/** Read only public, bounded error fields; never show an HTML response or arbitrary objects. */
export async function responseApiError(response: Response, fallback: string): Promise<ApiError> {
  const body: unknown = await response.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return new ApiError(fallback, response.status);
  const value = body as { error?: unknown; code?: unknown };
  const safeText = typeof value.error === 'string' && value.error.trim().length > 0 && value.error.length <= 300
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.error);
  if (!safeText) return new ApiError(fallback, response.status);
  const code = typeof value.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value.code) ? value.code : undefined;
  return new ApiError(value.error as string, response.status, code);
}

export function isConfiguredBootstrap(value: Bootstrap | null | undefined): value is Bootstrap & { child: NonNullable<Bootstrap['child']> } {
  return value?.configured === true && !!value.child && typeof value.child.id === 'string' && typeof value.parentAuthorized === 'boolean';
}

/** Recover a possibly committed setup using only a read; the invitation is never resubmitted. */
export async function recoverSetupState(error: unknown, readBootstrap: () => Promise<Bootstrap> = () => api<Bootstrap>('/bootstrap')) {
  try {
    const data = await readBootstrap();
    if (isConfiguredBootstrap(data)) return { data, error: '' };
  } catch { /* A failed read cannot tell us whether the original setup committed. */ }
  const knownRejection = error instanceof ApiError && error.status >= 400 && error.status < 500;
  return { data: null, error: knownRejection ? messageOf(error) : '这次设置的结果暂时无法确认。请先刷新页面查看；如果仍显示设置页面，请联系分享人或通过“问题反馈”说明情况，不要反复提交。' };
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 35000);
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if(options.signal?.aborted)controller.abort();
  try {
    const response = await fetch(`/api${path}`, { ...options, credentials: 'same-origin', signal: controller.signal, headers: { ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...options.headers } });
    if (!response.ok) {
      const failure=await responseApiError(response, '这一步没有完成，请稍后再试。');
      if(response.status===401&&['ACCOUNT_REQUIRED','DEVICE_REQUIRED'].includes(failure.code??'')&&!path.startsWith('/admin')&&!path.startsWith('/debug'))window.dispatchEvent?.(new Event('baoyan:account-recheck'));
      throw failure;
    }
    const body = await response.json().catch(() => ({})) as T;
    return body;
  } finally { window.clearTimeout(timeout); options.signal?.removeEventListener('abort', abort); }
}
export const post = <T>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body: JSON.stringify(body) });
export const patch = <T>(path: string, body: unknown) => api<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
export const remove = (path: string) => api<{ok:true}>(path, { method: 'DELETE' });
export const operationId = () => crypto.randomUUID();
export const messageOf = (error: unknown) => error instanceof Error ? (error.name === 'AbortError' ? '等待有点久，这次操作未完成。请重新试试。' : error.message) : '这一步没有完成，请再试一次。';
export const timeLabel = (seconds: number) => `${Math.floor(Math.max(0,seconds)/60).toString().padStart(2,'0')}:${Math.floor(Math.max(0,seconds)%60).toString().padStart(2,'0')}`;
