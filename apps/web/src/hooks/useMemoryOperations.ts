import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, operationId } from '../lib/api';
import {
  applyMutationFailure, applyMutationResult, applyQueryResult, createOperation, expireOperation,
  isUnresolved, OPERATION_STORAGE_KEY, recoverOperations, requireRecheck, serializeOperations,
  type MemoryAction, type MemoryMutationResult, type OperationQueryResult, type TrackedOperation,
} from '../lib/memoryOperations';

export function useMemoryOperations(ready: boolean, scopeId: string | null) {
  const [operations, setOperations] = useState<TrackedOperation[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const records = useRef<TrackedOperation[]>([]);
  const mounted = useRef(true);
  const scopeEpoch = useRef(0);
  const previousScope = useRef<string | null | undefined>(undefined);
  const queries = useRef(new Set<string>());
  const queryAgain = useRef(new Set<string>());
  const queryVersions = useRef(new Map<string, number>());
  const mutationBusy = useRef(false);

  const persist = useCallback((next: TrackedOperation[], mustPersist = false) => {
    try {
      const serialized = serializeOperations(next, Date.now());
      if (serialized === '[]') sessionStorage.removeItem(OPERATION_STORAGE_KEY);
      else sessionStorage.setItem(OPERATION_STORAGE_KEY, serialized);
    } catch {
      if (mustPersist) throw new Error('无法保留查询编号，这次请求尚未提交。请允许本站使用浏览器存储后再试。');
    }
    records.current = next;
    if (mounted.current) setOperations(next);
  }, []);
  const update = useCallback((id: string, change: (value: TrackedOperation) => TrackedOperation) => {
    persist(records.current.map(value => value.operationId === id ? change(value) : value));
  }, [persist]);
  const clear = useCallback(() => {
    ++scopeEpoch.current;
    mutationBusy.current = false;
    setSubmitting(false);
    queries.current.clear();queryAgain.current.clear();queryVersions.current.clear();
    persist([]);
  }, [persist]);

  const query = useCallback(async (id: string): Promise<void> => {
    const current = records.current.find(value => value.operationId === id);
    if (!current || !isUnresolved(current)) return;
    if (queries.current.has(id)) { queryAgain.current.add(id); return; }
    const checked = expireOperation(current, Date.now());
    if (checked.phase === 'expired') { update(id, () => checked); return; }
    const generation = scopeEpoch.current;
    const version = queryVersions.current.get(id) ?? 0;
    queries.current.add(id);
    update(id, value => ({ ...value, phase: 'checking', message: '正在查询原操作的结果，不会重新提交。' }));
    try {
      const result = await api<OperationQueryResult>(`/memory/operations/${encodeURIComponent(id)}`);
      if (generation !== scopeEpoch.current || !mounted.current || version !== (queryVersions.current.get(id) ?? 0)) return;
      update(id, value => applyQueryResult(value, result, Date.now()));
    } catch {
      if (generation !== scopeEpoch.current || !mounted.current || version !== (queryVersions.current.get(id) ?? 0)) return;
      update(id, value => isUnresolved(value) ? expireOperation({ ...value, phase: 'unconfirmed', message: '暂时无法查询，结果仍待核实。请勿重复提交，可以稍后查询，或请家长查看记忆小本。' }, Date.now()) : value);
    } finally {
      queries.current.delete(id);
      if (queryAgain.current.delete(id) && generation === scopeEpoch.current && mounted.current) void query(id);
    }
  }, [update]);

  const invalidate = useCallback(() => {
    const next = records.current.map(value => requireRecheck(value, Date.now()));
    for (const value of next) if (isUnresolved(value)) queryVersions.current.set(value.operationId, (queryVersions.current.get(value.operationId) ?? 0) + 1);
    persist(next);
    for (const value of next) if (isUnresolved(value)) void query(value.operationId);
  }, [persist, query]);

  const submit = useCallback(async (action: MemoryAction, mutate: (id: string) => Promise<MemoryMutationResult>) => {
    if (mutationBusy.current || records.current.some(isUnresolved)) {
      return { submitted: false, message: '还有一项结果待核实。请先查询结果，或让家长查看记忆小本，不重复提交。' };
    }
    const created = createOperation(operationId(), action, Date.now());
    // Durable metadata must exist before the request can leave the browser.
    try { persist([...records.current.filter(value => !isUnresolved(value)).slice(-3), created], true); }
    catch (error) { return { submitted: false, message: error instanceof Error ? error.message : '这次请求尚未提交。' }; }
    const generation = scopeEpoch.current;
    mutationBusy.current = true;
    setSubmitting(true);
    try {
      const result = await mutate(created.operationId);
      if (generation !== scopeEpoch.current || !mounted.current) return { submitted: true };
      update(created.operationId, value => applyMutationResult(value, result, Date.now()));
      if (records.current.find(value => value.operationId === created.operationId)?.phase === 'unconfirmed') void query(created.operationId);
    } catch (error) {
      if (generation !== scopeEpoch.current || !mounted.current) return { submitted: true };
      const status = error instanceof ApiError ? error.status : undefined;
      update(created.operationId, value => applyMutationFailure(value, status));
      if (!status || status < 400 || status >= 500) void query(created.operationId);
    } finally { if (generation === scopeEpoch.current) { mutationBusy.current = false; if (mounted.current) setSubmitting(false); } }
    return { submitted: true };
  }, [persist, query, update]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; ++scopeEpoch.current; };
  }, []);
  useEffect(() => {
    if (!ready) return;
    const previous = previousScope.current;
    previousScope.current = scopeId;
    if (!scopeId || (previous !== undefined && previous !== scopeId)) {
      clear();
      return;
    }
    let restored: TrackedOperation[] = [];
    try { restored = recoverOperations(sessionStorage.getItem(OPERATION_STORAGE_KEY), Date.now()); } catch { /* Submission remains disabled if metadata cannot be stored. */ }
    persist(restored);
    for (const value of restored) if (isUnresolved(value)) void query(value.operationId);
  }, [ready, scopeId, clear, persist, query]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      const next = records.current.map(value => expireOperation(value, Date.now()));
      if (next.some((value, index) => value !== records.current[index])) persist(next);
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [persist]);

  return {
    operations, query, submit, clear, invalidate,
    pending: submitting,
    unresolved: operations.some(isUnresolved),
  };
}
