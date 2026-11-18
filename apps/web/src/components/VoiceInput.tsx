import { useEffect, useRef } from 'react';
import type { AudioController } from '../audio';
export function VoiceInput({active,audio,outputFormat='browser',onAudio,onReady,onProcessing,onLevel,onSpeechStart,onError}: {
  active:boolean;
  audio:AudioController;
  outputFormat?:'browser'|'wav';
  onAudio:(blob:Blob)=>void;
  onReady:(ready:boolean)=>void;
  onProcessing:(preparing:boolean)=>void;
  onLevel?:(level:number)=>void;
  onSpeechStart?:()=>void;
  onError:(message:string)=>void;
}) {
  const latest=useRef({onAudio,onReady,onProcessing,onLevel,onSpeechStart,onError});latest.current={onAudio,onReady,onProcessing,onLevel,onSpeechStart,onError};
  useEffect(()=>{
    latest.current.onLevel?.(0);
    if(!active)return;
    let cancelled=false;
    void audio.startListening({
      outputFormat,
      onLevel:level=>{if(!cancelled)latest.current.onLevel?.(level);},
      onSpeechStart:()=>{if(!cancelled)latest.current.onSpeechStart?.();},
      onProcessing:()=>{if(cancelled)return;latest.current.onLevel?.(0);latest.current.onReady(false);latest.current.onProcessing(true);},
      onUtterance:blob=>{if(cancelled)return;latest.current.onLevel?.(0);latest.current.onReady(false);latest.current.onProcessing(false);latest.current.onAudio(blob);},
      onSilence:()=>{if(cancelled)return;latest.current.onLevel?.(0);latest.current.onReady(false);latest.current.onProcessing(false);latest.current.onError('暂时没有听到声音，点击“开始说话”再试试。');},
      onError:error=>{if(cancelled)return;latest.current.onLevel?.(0);latest.current.onReady(false);latest.current.onProcessing(false);latest.current.onError(error.message);},
    }).then(started=>{if(!cancelled)latest.current.onReady(started);}).catch(error=>{
      if(cancelled)return;
      latest.current.onLevel?.(0);
      latest.current.onReady(false);
      latest.current.onProcessing(false);
      latest.current.onError(error instanceof Error?error.message:'麦克风没有启动，请检查权限。');
    });
    // onProcessing updates a separate flag; normal conversion keeps this listening effect alive.
    return()=>{cancelled=true;audio.stopCapture();latest.current.onLevel?.(0);latest.current.onReady(false);latest.current.onProcessing(false);};
  },[active,audio,outputFormat]);
  return null;
}
