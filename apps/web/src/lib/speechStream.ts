import { ApiError, responseApiError } from './api';
import { speechRequestBody } from './replySegments';

export const MAX_SPEECH_AUDIO_BYTES = 4_320_000; // 90 seconds, mono signed 16-bit at 24 kHz.
const MAX_WIRE_BYTES = 6_000_000;
const MAX_LINE = MAX_WIRE_BYTES;
function invalid(): Error { return new Error('声音数据不完整，已停止播放，可以先阅读文字。'); }
function abortError(): DOMException { return new DOMException('Cancelled', 'AbortError'); }
function boundedRead<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void promise.catch(() => {}); return Promise.reject(abortError()); }
  return new Promise((resolve,reject)=>{
    const abort=()=>{signal.removeEventListener('abort',abort);reject(abortError());};
    signal.addEventListener('abort',abort,{once:true});
    promise.then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});
  });
}

/** One provider request. Never automatically retries or persists audio. */
export async function* fetchReplySpeechStream(callId: string, replyId: string, signal?: AbortSignal | readonly AbortSignal[],
  timeoutMs = 35_000, request: typeof fetch = fetch, endpoint?: string, segmentIndex?: number): AsyncGenerator<Uint8Array> {
  const body = speechRequestBody(replyId, segmentIndex);
  const controller = new AbortController(); let timedOut = false;
  const signals=signal?(Array.isArray(signal)?signal:[signal as AbortSignal]):[];
  const abort=()=>controller.abort();for(const item of signals)item.addEventListener('abort',abort,{once:true});
  if(signals.some(item=>item.aborted))controller.abort();
  const timer=globalThis.setTimeout(()=>{timedOut=true;controller.abort();},timeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined; let complete=false;
  const cancelReader=()=>{void reader?.cancel().catch(()=>{});};
  controller.signal.addEventListener('abort',cancelReader,{once:true});
  try {
    const pending=request(endpoint ?? `/api/calls/${callId}/speech`,{method:'POST',credentials:'same-origin',
      headers:{'Content-Type':'application/json',Accept:'application/x-ndjson'},body,signal:controller.signal});
    void pending.then(late=>{if(controller.signal.aborted)void late.body?.cancel().catch(()=>{});},()=>{});
    const response=await boundedRead(pending,controller.signal);
    if(!response.ok)throw await responseApiError(response,'声音暂时不可用。');
    if(!response.body || !/^application\/x-ndjson(?:\s*;|\s*$)/i.test(response.headers.get('content-type')??''))throw invalid();
    reader=response.body.getReader(); const decoder=new TextDecoder('utf-8',{fatal:true});
    let line='',wireBytes=0,audioBytes=0,events=0,formatted=false,finished=false;
    while(true){
      const part=await boundedRead(reader.read(),controller.signal);
      if(controller.signal.aborted)throw abortError();
      if(part.done) { line+=decoder.decode(); break; }
      wireBytes+=part.value.length;if(wireBytes>MAX_WIRE_BYTES)throw invalid();
      line+=decoder.decode(part.value,{stream:true});
      let newline: number;
      while((newline=line.indexOf('\n'))>=0){
        const encoded=line.slice(0,newline);line=line.slice(newline+1);
        if(!encoded || encoded.length>MAX_LINE || ++events>10002 || finished)throw invalid();
        const frame: unknown=JSON.parse(encoded);
        if(!frame || typeof frame!=='object' || Array.isArray(frame))throw invalid();
        const value=frame as Record<string,unknown>;
        if(value.type==='error'){
          if(typeof value.error!=='string' || typeof value.code!=='string' || (!Number.isInteger(value.status) || Number(value.status)<400 || Number(value.status)>599 || !/^[A-Z][A-Z0-9_]{0,63}$/.test(value.code)))throw invalid();
          throw new ApiError(value.error.slice(0,200),Number(value.status),value.code);
        }
        if(value.type==='format'){
          if(formatted || value.format!=='pcm_s16le' || value.sampleRate!==24000 || value.channels!==1)throw invalid();
          formatted=true;
        } else if(value.type==='audio'){
          if(!formatted || typeof value.data!=='string' || !value.data || value.data.length%4!==0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data))throw invalid();
          const raw=atob(value.data);audioBytes+=raw.length;if(btoa(raw)!==value.data || !raw.length || audioBytes>MAX_SPEECH_AUDIO_BYTES)throw invalid();
          yield Uint8Array.from(raw,char=>char.charCodeAt(0));
          if(controller.signal.aborted)throw abortError();
        } else if(value.type==='done'){
          if(!formatted || !audioBytes || audioBytes%2)throw invalid();finished=true;
        } else throw invalid();
      }
      if(line.length>MAX_LINE)throw invalid();
    }
    if(line || !finished)throw invalid();complete=true;
  } catch(error){
    if(timedOut && !signals.some(item=>item.aborted))throw new Error('声音准备超时，可以先阅读文字。');
    if(controller.signal.aborted)throw abortError();throw error;
  } finally {
    globalThis.clearTimeout(timer);for(const item of signals)item.removeEventListener('abort',abort);controller.signal.removeEventListener('abort',cancelReader);
    if(!complete){controller.abort();void reader?.cancel().catch(()=>{});}
    try{reader?.releaseLock();}catch{/* Pending cancellation owns the reader. */}
  }
}
