/** Only this metadata is retained across a refresh. Never persist candidate text. */
export type MemoryAction = 'save' | 'forget';
export interface OperationMetadata {
  operationId: string;
  action: MemoryAction;
  createdAt: number;
}
export type OperationPhase = 'submitting' | 'checking' | 'unconfirmed' | 'committed' | 'superseded' | 'failed' | 'expired';
export interface TrackedOperation extends OperationMetadata {
  phase: OperationPhase;
  needsVerification?: boolean;
  message: string;
}
export interface OperationQueryResult {
  operationId: string;
  action?: MemoryAction;
  status: 'committed' | 'superseded' | 'not_found';
  effect?: 'saved' | 'forgotten';
  message: string;
}
export interface MemoryMutationResult {
  saved?: boolean;
  forgotten?: boolean;
  message?: string;
}
export const OPERATION_STORAGE_KEY = 'bobo.memory-operations.v1';
export const OPERATION_TTL_MS = 24 * 60 * 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUnresolved(operation: TrackedOperation): boolean {
  return operation.phase === 'submitting' || operation.phase === 'checking' || operation.phase === 'unconfirmed';
}
export function isExpired(operation: OperationMetadata, now: number): boolean {
  return now - operation.createdAt >= OPERATION_TTL_MS;
}
export function expireOperation(operation: TrackedOperation, now: number): TrackedOperation {
  if (!isUnresolved(operation) || !isExpired(operation, now)) return operation;
  return { ...operation, phase: 'expired', message: '查询编号已超过 24 小时，不能继续核实结果。请让家长查看当前记忆；这里不推测是否完成。' };
}
export function requireRecheck(operation: TrackedOperation, now: number): TrackedOperation {
  if (operation.phase === 'failed' || operation.phase === 'expired' || operation.phase === 'superseded') return operation;
  if (isExpired(operation, now)) return expireOperation({ ...operation, phase: 'unconfirmed' }, now);
  return { ...operation, phase: 'unconfirmed', needsVerification: true, message: '记忆状态已有变化，正在重新核实这次操作，不会重新提交。' };
}
export function createOperation(operationId: string, action: MemoryAction, now: number): TrackedOperation {
  return { operationId, action, createdAt: now, phase: 'submitting', message: action === 'forget' ? '正在提交遗忘请求，请稍等。' : '正在提交记忆请求，请稍等。' };
}
export function recoverOperations(raw: string | null, now: number): TrackedOperation[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const result: TrackedOperation[] = [];
    for (const value of parsed.slice(0, 32)) {
      if (typeof value !== 'object' || value === null) continue;
      const record = value as Record<string, unknown>;
      if (typeof record.operationId !== 'string' || !UUID_PATTERN.test(record.operationId) || seen.has(record.operationId)) continue;
      if (record.action !== 'save' && record.action !== 'forget') continue;
      if (typeof record.createdAt !== 'number' || !Number.isFinite(record.createdAt) || record.createdAt < 0 || record.createdAt > now + 300_000) continue;
      seen.add(record.operationId);
      const operation: TrackedOperation = {
        operationId: record.operationId,
        action: record.action,
        createdAt: record.createdAt,
        phase: 'unconfirmed',
        needsVerification: true,
        message: '上次请求的结果待核实。正在使用原查询编号核对，不会重新提交。',
      };
      result.push(expireOperation(operation, now));
    }
    return result;
  } catch { return []; }
}
export function serializeOperations(operations: TrackedOperation[], now: number): string {
  return JSON.stringify(operations.filter(item => isUnresolved(item) && !isExpired(item, now)).map(({operationId, action, createdAt}) => ({operationId, action, createdAt})));
}
export function applyQueryResult(operation: TrackedOperation, result: OperationQueryResult, now: number): TrackedOperation {
  const current = expireOperation(operation, now);
  if (current.phase === 'expired' || current.phase === 'superseded') return current;
  if (result.operationId !== current.operationId || (result.action && result.action !== current.action)) {
    if (!isUnresolved(current)) return current;
    return { ...current, phase: 'unconfirmed', message: '查询回执与这次操作不一致，结果仍待核实。请让家长查看记忆小本。' };
  }
  if (result.status === 'not_found') {
    if (!isUnresolved(current)) return current;
    return { ...current, phase: 'unconfirmed', message: '暂未查到结果，仍待确认。请勿重复提交，可以稍后查询，或请家长查看记忆小本。' };
  }
  if (result.status === 'superseded') return { ...current, phase: 'superseded', needsVerification: false, message: result.message || '这次操作已被后续变更替代，请以当前记忆小本为准。' };
  if (result.status !== 'committed') return { ...current, phase: 'unconfirmed', message: '暂时无法确认这次操作的结果，请稍后查询。' };
  const expected = current.action === 'save' ? 'saved' : 'forgotten';
  if (result.effect && result.effect !== expected) return { ...current, phase: 'unconfirmed', message: '查询回执与操作类型不一致，结果仍待核实。请让家长查看记忆小本。' };
  return { ...current, phase: 'committed', needsVerification: false, message: result.message || (current.action === 'forget' ? '已确认：只忘记了选定的这一条。' : '已确认：这次记忆请求已完成。') };
}
export function applyMutationResult(operation: TrackedOperation, result: MemoryMutationResult, now: number): TrackedOperation {
  if (operation.phase === 'superseded' || operation.phase === 'committed') return operation;
  const current = expireOperation(operation, now);
  if (current.phase === 'expired' || current.needsVerification) return current;
  const flag = current.action === 'forget' ? result.forgotten : result.saved;
  if (typeof flag !== 'boolean') return { ...current, phase: 'unconfirmed', message: '没有收到可核实的完成回执，结果仍待确认。正在查询原操作，不会重新提交。' };
  const committed = flag;
  return { ...current, phase: committed ? 'committed' : 'failed', message: result.message || (committed ? '这次操作已完成。' : '这次操作未完成。') };
}
export function applyMutationFailure(operation: TrackedOperation, httpStatus?: number): TrackedOperation {
  if (!isUnresolved(operation)) return operation;
  if (httpStatus && httpStatus >= 400 && httpStatus < 500) {
    return { ...operation, phase: 'failed', message: '这次请求已被明确拒绝，操作未完成。请让家长检查设置后重新确认。' };
  }
  return { ...operation, phase: 'unconfirmed', message: '没有收到明确回执，结果待核实。正在查询原操作，不会重复提交。' };
}
