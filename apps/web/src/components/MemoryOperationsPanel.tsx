import { Check, Clock3, RefreshCw, ShieldCheck } from 'lucide-react';
import { isUnresolved, type TrackedOperation } from '../lib/memoryOperations';
export function MemoryOperationsPanel({operations,onQuery}:{operations:TrackedOperation[];onQuery:(id:string)=>void}) {
  if (!operations.length) return null;
  return <div className="operation-results" aria-label="记忆操作结果">
    {operations.map(operation => {
      const pending = isUnresolved(operation);
      const busy = operation.phase === 'submitting' || operation.phase === 'checking';
      const done = operation.phase === 'committed';
      const actionLabel = operation.action === 'forget' ? '遗忘' : '保存';
      const title = operation.phase === 'submitting' ? `正在提交${actionLabel}请求`
        : operation.phase === 'checking' ? `正在核实${actionLabel}结果`
        : operation.phase === 'unconfirmed' ? `${actionLabel}结果待核实`
        : done ? `${actionLabel}结果已确认`
        : operation.phase === 'superseded' ? `${actionLabel}结果已有后续变更`
        : operation.phase === 'expired' ? `${actionLabel}查询已到期，请家长核实` : `这次${actionLabel}未完成`;
      return <section key={operation.operationId} className={`operation-card ${done?'resolved':''}`} aria-live="polite">
        <div className="operation-title">{done?<Check size={17}/>:pending?<Clock3 size={17}/>:<ShieldCheck size={17}/>}<strong>{title}</strong></div>
        <p>{operation.message}</p>
        {pending?<button className="button secondary small" disabled={busy} onClick={()=>onQuery(operation.operationId)}><RefreshCw size={14}/>{busy?'正在核实…':'查询结果'}</button>:null}
        <small>本机仅保留随机编号、操作类型和时间，不保留记忆原文。</small>
      </section>;
    })}
  </div>;
}
