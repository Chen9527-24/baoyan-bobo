import { ApiError } from './api';

export const ACCOUNT_RECHECK_EVENT = 'baoyan:account-recheck';
export const ACCOUNT_CHECK_INTERVAL = 20_000;
export type AccountSession = { signedIn: true; pending: boolean; childName: string; hasPin: boolean };

/** One bounded foreground check at a time. A disposed or superseded read cannot revoke a newer login. */
export function createAccountSessionCheck({ read, isCurrent, onInvalidated }: {
 read: (signal: AbortSignal) => Promise<AccountSession>;
 isCurrent: () => boolean; onInvalidated: () => void;
}) {
 let stopped = false; let pending: AbortController | undefined; let generation = 0; let invalidated = false;
 return {
  async check() {
   if (stopped || invalidated || pending || !isCurrent()) return;
   const controller = new AbortController(); pending = controller; const token = generation;
   try {
    const value = await read(controller.signal);
    if (!value || value.signedIn !== true) throw new ApiError('账号登录已失效。', 401, 'ACCOUNT_REQUIRED');
   } catch (cause) {
    if (!stopped && !controller.signal.aborted && token === generation && isCurrent()
     && cause instanceof ApiError && [401, 403].includes(cause.status)) {
     invalidated = true; onInvalidated();
    }
   } finally { if (pending === controller) pending = undefined; }
  },
  stop() { stopped = true; generation++; pending?.abort(); pending = undefined; },
 };
}
