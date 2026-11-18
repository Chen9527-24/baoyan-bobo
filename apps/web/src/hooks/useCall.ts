import { useCallback, useEffect, useRef, useState } from 'react';
import { AudioController } from '../audio';
import { api, messageOf, operationId, post } from '../lib/api';
import type { Bootstrap, Call, CallState, ConversationMode, SpeechLanguage, StoryProgress, Turn } from '../lib/types';
import { matchesStoryAudio, storyPlaybackAction, storyCompletionDeadline, deliverStoryCompletion, stateAfterReply, StoryAudioSession } from '../lib/softwareActivities';
import { useMemoryOperations } from './useMemoryOperations';
import { SessionSyncGate } from '../lib/sessionSyncGate';
import { readAudioTurnStream } from '../lib/audioTurnStream';
import { fetchReplySpeechStream } from '../lib/speechStream';
import { fetchReplySpeech, interruptReplyPlayback, permitsTextFallback, presentReplyWithPlayback, presentReplySegmentsWithPlayback, type ReplyReveal } from '../lib/replyPlayback';
import { replySegmentEmotion, replySegmentsForTurn } from '../lib/replySegments';
import { characterReactionFor } from '../lib/characterMotion';
import { createReplySpeechPrefetch } from '../lib/replySpeechPrefetch';
import { createFirstAudioObserver } from '../lib/clientLatency';
import { isLanguageClarification, languageAnswerContext, recoverExpiredLanguageQuestion, LanguageClarificationSession, LANGUAGE_EXPIRED, LANGUAGE_QUESTION } from '../lib/languageClarification';

export function useCall(bootstrap: Bootstrap|null, onEnded?:()=>void) {
  const [state,setState]=useState<CallState>('idle');
  const [call,setCall]=useState<Call|null>(null);
  const [remaining,setRemaining]=useState(0);
  const [muted,setMuted]=useState(false);
  const [reply,setReply]=useState('');
  // Keep the accepted answer intact while captions reveal one spoken segment at a time.
  const [fullReply,setFullReply]=useState('');
  const [replyTextOnly,setReplyTextOnly]=useState(false);
  const [playbackActive,setPlaybackActive]=useState(false);
  const [spokenSegment,setSpokenSegment]=useState('');
  const [characterReaction,setCharacterReaction]=useState<{id:string;motion:'reaction-happy'|'reaction-sad'}>();
  const [inputText,setInputText]=useState('');
  const [inputSource,setInputSource]=useState<Turn['inputSource']>();
  const [detectedLanguage,setDetectedLanguage]=useState<Turn['detectedLanguage']>();
  const [audioReview,setAudioReview]=useState<Turn['audioReview']>();
  const [languageClarification,setLanguageClarification]=useState<Turn['languageClarification']>();
  const [languageClarificationExpired,setLanguageClarificationExpired]=useState(false);
  const [languageSession]=useState(()=>new LanguageClarificationSession());
  const clearLanguageClarification=useCallback(()=>{languageSession.clear();setLanguageClarification(undefined);setLanguageClarificationExpired(false);},[languageSession]);
  const [inputKind,setInputKind]=useState<'text'|'image'>('text');
  const nativePickerUntil=useRef(0);
  const nativePickerTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const suspendForNativePicker=useRef<()=>void>(()=>{});
  const setImagePickerActive=(picking:boolean)=>{const previous=nativePickerUntil.current;clearTimeout(nativePickerTimer.current);nativePickerUntil.current=picking?Date.now()+30_000:0;if(picking){suspendForNativePicker.current();nativePickerTimer.current=setTimeout(()=>{if(document.hidden&&nativePickerUntil.current>0)void end('选择照片时间较长，回来后请重新开始聊天。');nativePickerUntil.current=0;},30_000);}else if(previous&&Date.now()>=previous&&active.current){void end('选择照片时间较长，回来后请重新开始聊天。');}};
  const [processingPhase,setProcessingPhase]=useState<'recognizing'|'thinking'|'preparing-speech'>('thinking');
  const [candidate,setCandidate]=useState<Turn['candidate']>();
  const [speaker,setSpeaker]=useState<Turn['speaker']>();
  const [speakerNeedsRejoin,setSpeakerNeedsRejoin]=useState(false);const speakerNeedsRejoinRef=useRef(false);const voiceprintParticipant=useRef(false);
  const [story,setStory]=useState<StoryProgress>();const storyRef=useRef<StoryProgress|undefined>(undefined);
  const [learning,setLearning]=useState<Turn['learning']>();
  const defaultMode=useRef<ConversationMode>({mode:bootstrap?.capabilities.autoLanguage?'auto':'chat'});
  defaultMode.current={mode:bootstrap?.capabilities.autoLanguage?'auto':'chat'};
  const [conversationMode,setConversationMode]=useState<ConversationMode>(()=>defaultMode.current);
  const [interpretedText,setInterpretedText]=useState('');
  const [emotion,setEmotion]=useState<Turn['emotion']>('warm');
  const [replyId,setReplyId]=useState('');const replyIdRef=useRef('');const replaceReplyId=useRef('');
  const advanceStory=useRef<(action:'next'|'pause'|'resume'|'replay'|'stop'|'complete')=>Promise<void>>(async()=>{});
  const [storyAudio]=useState(()=>new StoryAudioSession());const storyPaused=useRef(false);
  const clearStoryAudio=useCallback(()=>{storyAudio.clear();storyPaused.current=false;},[storyAudio]);
  const [error,setError]=useState('');
  const [endReason,setEndReason]=useState('');
  const [voiceReady,setVoiceReady]=useState(false);
  const [voiceMode,setVoiceModeState]=useState<'hold'|'auto'>('hold');
  const [voiceHolding,setVoiceHolding]=useState(false);
  const [audioPreparing,setAudioPreparing]=useState(false);
  const [syncReady,setSyncReady]=useState(false);const [syncGate]=useState(()=>new SessionSyncGate());
  const memoryOperations=useMemoryOperations(bootstrap!==null,bootstrap?.child?.id??null);
  const memoryPending=memoryOperations.pending;
  const [contextNotice,setContextNotice]=useState('');
  const [cancelling,setCancelling]=useState(false);const cancellingRef=useRef(false);
  const endedCallback=useRef(onEnded);endedCallback.current=onEnded;
  const [audio]=useState(()=>new AudioController());
  const active=useRef<Call|null>(null); const epoch=useRef(0); const request=useRef<AbortController|null>(null);
  const expires=useRef(0); const mutedRef=useRef(false); const mounted=useRef(true);
  const clearPlaybackActivity=useCallback(()=>{if(mounted.current){setPlaybackActive(false);setCharacterReaction(undefined);}},[]);
  suspendForNativePicker.current=()=>{
    const {previousGeneration,generation}=interruptReplyPlayback({epoch,request,clearActivity:clearPlaybackActivity,cancelAudio:()=>audio.cancel()});
    // A cancelled chooser must not abandon the pending original audio or extend its TTL.
    const current=active.current;
    if(current&&languageClarification&&languageSession.matches(languageClarification.id,current.id,previousGeneration)){
      const question={...languageClarification};languageSession.offer(question,current.id,generation);setLanguageClarification(question);
    }
    setFullReply('');setVoiceReady(false);setAudioPreparing(false);setVoiceHolding(false);setState('paused');
  };
  const end=useCallback(async(reason='挂断通话')=>{
    clearTimeout(nativePickerTimer.current);nativePickerUntil.current=0;
    clearStoryAudio();
    ++epoch.current; request.current?.abort(); clearPlaybackActivity();audio.cancel(); audio.endPlaybackSession(); setVoiceReady(false);setAudioPreparing(false);setVoiceHolding(false);
    const current=active.current; active.current=null; setCall(null); setReply('');setFullReply('');setReplyTextOnly(false);setInputText('');setInputSource(undefined);setAudioReview(undefined);setDetectedLanguage(undefined);clearLanguageClarification(); setCandidate(undefined); setSpeaker(undefined);
    voiceprintParticipant.current=false;speakerNeedsRejoinRef.current=false;setSpeakerNeedsRejoin(false);
    setState('ended'); setEndReason(reason);setError('');setContextNotice('');setCancelling(false);cancellingRef.current=false;
    storyRef.current=undefined;setStory(undefined);setLearning(undefined);setConversationMode(defaultMode.current);setInterpretedText('');setReplyId('');replyIdRef.current='';replaceReplyId.current='';setEmotion('warm');
    if(current) { try { await api(`/calls/${current.id}/end`,{method:'POST',body:JSON.stringify({reason}),keepalive:true}); } catch { /* The server lease also expires an unreachable call. */ } if(mounted.current)endedCallback.current?.(); }
  },[audio,clearStoryAudio,clearPlaybackActivity,clearLanguageClarification]);
  useEffect(()=>{
    if(!audioReview)return;
    const timer=window.setTimeout(()=>setAudioReview(current=>current?.replyId===audioReview.replyId?undefined:current),Math.max(0,Math.min(Date.parse(audioReview.expiresAt)-Date.now(),2147483647)));
    return()=>window.clearTimeout(timer);
  },[audioReview]);
  useEffect(()=>{
    if(!languageClarification)return;
    const current=active.current,generation=epoch.current;
    const expire=()=>{if(current&&languageSession.matches(languageClarification.id,current.id,generation)){languageSession.clear();setLanguageClarificationExpired(true);}};
    const timer=window.setTimeout(expire,Math.max(0,Math.min(Date.parse(languageClarification.expiresAt)-Date.now(),2147483647)));
    return()=>window.clearTimeout(timer);
  },[languageClarification,languageSession]);
  useEffect(()=>{
    mounted.current=true;
    const stopForLifecycle=(reason:string)=>{clearStoryAudio();if(active.current){void end(reason);return;}++epoch.current;request.current?.abort();clearPlaybackActivity();audio.cancel();setFullReply('');setVoiceReady(false);setAudioPreparing(false);setVoiceHolding(false);setState(previous=>previous==='connecting'?'ended':previous);setEndReason(reason);};
    const onHidden=()=>{if(!document.hidden)return;if(nativePickerUntil.current>Date.now()){suspendForNativePicker.current();return;}stopForLifecycle('离开页面后，通话已结束。');};
    const onOffline=()=>stopForLifecycle('网络断开，通话已结束。');
    const onPageHide=()=>stopForLifecycle('页面已关闭，通话已结束。');
    document.addEventListener('visibilitychange',onHidden);window.addEventListener('offline',onOffline);window.addEventListener('pagehide',onPageHide);
    return()=>{clearTimeout(nativePickerTimer.current);nativePickerUntil.current=0;mounted.current=false;clearStoryAudio();document.removeEventListener('visibilitychange',onHidden);window.removeEventListener('offline',onOffline);window.removeEventListener('pagehide',onPageHide);++epoch.current;request.current?.abort();clearPlaybackActivity();audio.cancel();audio.endPlaybackSession();const current=active.current;active.current=null;if(current)void api(`/calls/${current.id}/end`,{method:'POST',body:JSON.stringify({reason:'页面离开'}),keepalive:true}).catch(()=>{});};
  },[audio,end,clearPlaybackActivity]);
  useEffect(()=>{if(!call)return;
    const tick=window.setInterval(()=>{const seconds=Math.max(0,Math.ceil((expires.current-Date.now())/1000));setRemaining(seconds);if(seconds===0)void end('这次的聊天时间到了，和家人一起休息一下吧。');},1000);
    const heartbeat=window.setInterval(()=>{void post<{remainingSeconds:number;expiresAt:string}>(`/calls/${call.id}/heartbeat`).then(value=>{if(active.current?.id===call.id){expires.current=Date.now()+value.remainingSeconds*1000;setRemaining(value.remainingSeconds);}}).catch(()=>{if(active.current?.id===call.id)void end('连接中断，准备好后可以重新开始。');});},20000);
    return()=>{clearInterval(tick);clearInterval(heartbeat);};
  },[call,end]);
  useEffect(()=>{if(!story||story.status==='completed')return;const deadline=Date.parse(story.endsAt);if(!Number.isFinite(deadline))return;
    const timer=window.setTimeout(()=>{if(storyRef.current?.id!==story.id)return;clearPlaybackActivity();audio.cancel();clearStoryAudio();storyRef.current={...storyRef.current,status:'completed'};setStory(storyRef.current);setState('paused');void advanceStory.current('stop');},Math.max(0,Math.min(deadline-Date.now(),2147483647)));
    return()=>window.clearTimeout(timer);
  },[story?.id,story?.status,story?.endsAt,audio,clearPlaybackActivity]);
  useEffect(()=>{
    const streamGeneration=syncGate.attach();setSyncReady(false);
    if(!bootstrap?.configured||!bootstrap.child?.id)return;
    const source=new EventSource('/api/events');
    const invalidate=(message:string)=>{
      clearStoryAudio();
      ++epoch.current;request.current?.abort();clearPlaybackActivity();audio.cancel();
      setVoiceReady(false);setAudioPreparing(false);setVoiceHolding(false);setReply('');setFullReply('');setReplyTextOnly(false);setInputText('');setInputSource(undefined);setAudioReview(undefined);setDetectedLanguage(undefined);clearLanguageClarification();setCandidate(undefined);setSpeaker(undefined);setError('');
      storyRef.current=undefined;setStory(undefined);setLearning(undefined);setInterpretedText('');setReplyId('');replyIdRef.current='';replaceReplyId.current='';
      cancellingRef.current=false;setCancelling(false);
      if(active.current){setState('paused');setContextNotice(message);}
      else {setState(previous=>previous==='connecting'?'ended':previous);setContextNotice('');}
      endedCallback.current?.();
    };
    const onContext=(event:MessageEvent)=>{
      if(!syncGate.isCurrent(streamGeneration))return;
      let reason='';
      try{reason=(JSON.parse(event.data) as {reason?:string}).reason??'';}catch{/* Even a malformed invalidation must stop old output. */}
      memoryOperations.invalidate();
      invalidate(reason==='global-published'?'共享设定已更新，旧回复已停止。准备好后可以继续聊天。':'记忆或设置已变化，旧回复已停止。准备好后可以继续聊天。');
    };
    const onEnded=(event:MessageEvent)=>{
      if(!syncGate.isCurrent(streamGeneration))return;
      let payload:{callId?:string;reason?:string};
      try{payload=JSON.parse(event.data) as typeof payload;}catch{invalidate('会话状态发生变化，旧回复已停止。');return;}
      if(payload.reason==='account-replaced'||payload.reason==='account-logout')window.dispatchEvent(new Event('baoyan:account-recheck'));
      if(!active.current||payload.callId!==active.current.id)return;
      const reason=payload.reason??'';
      const message=reason==='safety'?'请马上联系身边可信任的成年人；如有紧急危险，请向当地急救或警方求助。我没有替你联系任何人。':reason==='goodbye'?'这次先聊到这里。想聊的时候，再来找宝妍。':reason==='expired'?'这次聊天已到时。和身边的家人一起休息一下吧。':reason==='withdrawn'?'授权已撤回，通话和收音已停止。':'通话已由服务端结束。收音和播放已停止，准备好后可以重新开始。';
      void end(message);
    };
    source.addEventListener('context-invalidated',onContext as EventListener);
    source.addEventListener('call-ended',onEnded as EventListener);
    source.onopen=()=>{if(!syncGate.open(streamGeneration))return;setSyncReady(true);memoryOperations.invalidate();endedCallback.current?.();};
    source.onerror=()=>{
      window.dispatchEvent(new Event('baoyan:account-recheck'));
      if(!syncGate.disconnect(streamGeneration))return;setSyncReady(false);
      if(active.current)void end('状态同步暂时中断，通话已停止。连接恢复后，请重新开始。');
      else{++epoch.current;request.current?.abort();clearPlaybackActivity();audio.cancel();setFullReply('');setState(previous=>previous==='connecting'?'ended':previous);setEndReason('状态同步暂时中断，这次连接已取消。');}
    };
    return()=>{if(syncGate.detach(streamGeneration))setSyncReady(false);source.close();};
  },[bootstrap?.configured,bootstrap?.child?.id,audio,end,memoryOperations.invalidate,syncGate,clearPlaybackActivity]);
  const start=async(voiceprintParticipation=false):Promise<boolean>=>{
    audio.preparePlayback();
    if(active.current)return true;
    if(!syncGate.ready){setError('正在确认最新设置，请等连接恢复后再试。');return false;}
    setConversationMode(defaultMode.current);setContextNotice('');const generation=++epoch.current;setState('connecting');setError('');setReply('');setFullReply('');setReplyTextOnly(false);setInputText('');setInputSource(undefined);setAudioReview(undefined);setDetectedLanguage(undefined);clearLanguageClarification();setCandidate(undefined);setEndReason('');setMuted(false);mutedRef.current=false;
    try{
      const participating=voiceprintParticipation&&bootstrap?.capabilities.voiceprint===true&&bootstrap?.child?.voiceEnabled===true;
      const current=await post<Call>('/calls',{operationId:operationId(),voiceprintParticipation:participating});
      if(generation!==epoch.current||document.hidden){void post(`/calls/${current.id}/end`,{reason:'已取消连接'}).catch(()=>{});return false;}
      voiceprintParticipant.current=participating;speakerNeedsRejoinRef.current=false;setSpeakerNeedsRejoin(false);active.current=current;setCall(current);expires.current=Date.now()+current.remainingSeconds*1000;setRemaining(current.remainingSeconds);setState('listening');return true;
    }catch(err){if(generation===epoch.current){setError(messageOf(err));setState('ended');setEndReason('这次没有接通。');}return false;}
  };
  const play=async(turn:Turn,generation:number,inputStartedAt?:number,playbackDeadline?:number,reactionInput='')=>{
    const current=active.current;
    const isCurrent=()=>mounted.current&&generation===epoch.current&&active.current?.id===current?.id
      &&(playbackDeadline===undefined||Date.now()<playbackDeadline);
    if(!current||!isCurrent())return;
    if(turn.languageClarification!==undefined&&(!isLanguageClarification(turn.languageClarification)||turn.reply!==LANGUAGE_QUESTION||turn.transcript!==undefined||turn.inputSource!==undefined||turn.detectedLanguage!==undefined||turn.interpretedText!==undefined||turn.candidate!==undefined||turn.story!==undefined||turn.learning!==undefined||turn.endCall!==undefined))throw new Error('这次语音回复没有完整收到，请重新试一次。');
    setInputKind(!turn.languageClarification&&turn.inputKind==='image'?'image':'text');
    if(turn.languageClarification)setInputText('');
    clearPlaybackActivity();
    const onActivityChange=(value:boolean)=>{if(isCurrent())setPlaybackActive(value);};
    const firstAudio=inputStartedAt===undefined?undefined:createFirstAudioObserver({startedAt:inputStartedAt,replyId:turn.replyId,isCurrent,report:value=>post(`/calls/${current.id}/latency`,value)});
    if(turn.story?.status==='playing')storyPaused.current=false;
    if(turn.story?.status==='completed')clearStoryAudio();
    const available=audio.getCapabilities();
    const segments=replySegmentsForTurn(turn);
    // child.voiceEnabled controls simulated speaker recognition, not reply audio.
    const playbackFor=(text:string,segmentIndex?:number)=>bootstrap?.capabilities.ttsStreaming&&available.streamingPlayback
      ? async(onStart:()=>void)=>{const signal=request.current?.signal;return audio.playPcmStream(playbackSignal=>fetchReplySpeechStream(current.id,turn.replyId,signal?[signal,playbackSignal]:playbackSignal,35000,fetch,undefined,segmentIndex),{onStart,onActivityChange,startTimeoutMs:35000});}
      : bootstrap?.capabilities.tts&&available.playback
      ? async(onStart:()=>void)=>{const blob=await fetchReplySpeech(current.id,turn.replyId,request.current?.signal,35000,fetch,undefined,segmentIndex);if(!isCurrent())return 'cancelled' as const;return audio.playBlob(blob,{onStart,onActivityChange,startTimeoutMs:8000});}
      : !bootstrap?.capabilities.tts&&available.speechSynthesis
        ? (onStart:()=>void)=>audio.speak(text,{lang:'zh-CN',rate:0.9,onStart,onActivityChange,startTimeoutMs:8000})
        : undefined;
    let playback=playbackFor(turn.reply);
    if(turn.story?.status==='playing'&&bootstrap?.capabilities.tts&&available.playback){
      playback=async(onStart:()=>void)=>{
        if(storyAudio.cache?.storyId===turn.story!.id&&storyAudio.cache.segment===turn.story!.segment&&!matchesStoryAudio(storyAudio.cache,turn))setContextNotice('这段声音已更新，将从本段开头继续。');
        const cached=await storyAudio.load(turn,signal=>fetchReplySpeech(current.id,turn.replyId,signal));
        if(!cached||!isCurrent()||storyPaused.current)return 'cancelled';
        return audio.playStoryBlob(cached.blob,cached.offsetSeconds,{onStart,onActivityChange,startTimeoutMs:8000});
      };
    }
    storyRef.current=turn.story;setStory(turn.story);setLearning(turn.learning);replyIdRef.current=turn.replyId;setReplyId(turn.replyId);setFullReply(turn.reply);
    if(turn.conversationMode)setConversationMode(turn.conversationMode);
    setInputSource(turn.inputSource);setDetectedLanguage(turn.detectedLanguage);setAudioReview(turn.audioReview);
    if(!turn.reply){setReply('');setFullReply('');setInterpretedText('');setState(stateAfterReply(turn.story,speakerNeedsRejoinRef.current));return;}
    let completed=false,heardReply=false;
    let lastSpoken='',lastEmotion=turn.emotion??'warm';
    const preparing=()=>{clearPlaybackActivity();setState('processing');setProcessingPhase('preparing-speech');};
    const reveal=(text:string,mode:ReplyReveal,emotion=turn.emotion??'warm',segmentText=text)=>{setSpokenSegment(segmentText);if(mode==='speech'){lastSpoken=segmentText;lastEmotion=emotion;}setReply(text);setCandidate(turn.candidate);setSpeaker(turn.speaker);setReplyTextOnly(mode==='text-only');setInterpretedText(turn.interpretedText??'');setEmotion(emotion);if(turn.languageClarification){languageSession.offer(turn.languageClarification,current.id,generation);setLanguageClarification(turn.languageClarification);setLanguageClarificationExpired(Date.parse(turn.languageClarification.expiresAt)<=Date.now());}else clearLanguageClarification();};
    const speaking=()=>{heardReply=true;firstAudio?.();setState('speaking');};
    const ready=()=>{clearPlaybackActivity();completed=true;setState(stateAfterReply(turn.story,speakerNeedsRejoinRef.current));if(heardReply&&!turn.story&&!turn.learning&&!turn.languageClarification&&turn.conversationMode?.behavior!=='translate'){const motion=characterReactionFor({emotion:lastEmotion,spokenText:lastSpoken,inputText:reactionInput});if(motion)setCharacterReaction({id:turn.replyId,motion});}};
    const failed=(err:unknown,afterStart=false)=>{clearPlaybackActivity();if(!permitsTextFallback(err))setFullReply('');setError(permitsTextFallback(err)?`${messageOf(err)} ${afterStart?'声音已停止，后续内容可先阅读文字':'本次可先阅读文字'}；如已隐藏，请点“显示宝妍回复”。`:messageOf(err));setState('paused');};
    if(segments){
      const streaming=Boolean(bootstrap?.capabilities.ttsStreaming&&available.streamingPlayback);
      const prefetched=streaming||(bootstrap?.capabilities.tts&&available.playback)?createReplySpeechPrefetch({
        segmentCount:segments.length,segments,isCurrent,signal:request.current?.signal,streaming,audio,onActivityChange,
        fetchPcm:(index,signal)=>fetchReplySpeechStream(current.id,turn.replyId,signal,35000,fetch,undefined,index),
        fetchBlob:(index,signal)=>fetchReplySpeech(current.id,turn.replyId,signal,35000,fetch,undefined,index),
      }):undefined;
      try{
        await presentReplySegmentsWithPlayback({isCurrent,reply:turn.reply,segments,
          playback:prefetched?(_segment,index,onStart)=>prefetched.play(index,onStart):playback?(segment,index,onStart)=>playbackFor(segment.text,index)!(onStart):undefined,
          preparing:index=>{if(index>0&&prefetched?.isReady(index))clearPlaybackActivity();else preparing();},reveal:(text,mode,segment)=>reveal(text,mode,segment?replySegmentEmotion(segment.expression):undefined,segment?.text??text),speaking,ready,failed});
      }finally{prefetched?.dispose();}
    }else{
      await presentReplyWithPlayback({isCurrent,playback,preparing,reveal:mode=>reveal(turn.reply,mode),speaking,ready,failed});
    }
    const next=completed?storyPlaybackAction(turn.story,Date.now(),isCurrent(),!!playback):undefined;if(next)await advanceStory.current(next);
  };
  const restoreExpiredQuestion=(error:unknown,question:Turn['languageClarification'],callId:string,generation:number)=>{
    const expired=recoverExpiredLanguageQuestion(error,question?{question,callId,generation}:undefined,{callId:active.current?.id,generation:epoch.current});
    if(!expired)return;
    languageSession.clear();setLanguageClarification(expired);setLanguageClarificationExpired(true);setReply(LANGUAGE_QUESTION);setFullReply('');setReplyTextOnly(true);setInputText('');setInputSource(undefined);setAudioReview(undefined);setDetectedLanguage(undefined);
  };
  const send=async(text:string|Blob,demoSpeaker='child')=>{const current=active.current;if(!current||speakerNeedsRejoinRef.current||cancellingRef.current||memoryPending||!syncGate.ready)return;
    const languageQuestion=languageClarification;
    let confirmation:ReturnType<typeof languageAnswerContext>;
    try{confirmation=languageAnswerContext(languageQuestion,languageClarificationExpired);}catch(err){languageSession.clear();audio.stopCapture();setVoiceReady(false);setAudioPreparing(false);setVoiceHolding(false);setLanguageClarificationExpired(true);setError(messageOf(err));setState('paused');return;}
    const inputStartedAt=performance.now();clearStoryAudio();setContextNotice('');clearPlaybackActivity();audio.cancel();audio.preparePlayback();setVoiceReady(false);setAudioPreparing(false);setVoiceHolding(false);request.current?.abort();request.current=new AbortController();const generation=++epoch.current;setError('');setCandidate(undefined);setReply('');setFullReply('');setReplyTextOnly(false);setInputKind('text');setInputText(typeof text==='string'?text:'');setInputSource(undefined);setAudioReview(undefined);setDetectedLanguage(undefined);clearLanguageClarification();setReplyId('');replyIdRef.current='';setInterpretedText('');setState('processing');setProcessingPhase(typeof text==='string'?'thinking':'recognizing');
    try{let turn:Turn;if(typeof text==='string'){const replacing=replaceReplyId.current;replaceReplyId.current='';turn=await api<Turn>(`/calls/${current.id}/${replacing?'correct':'turn'}`,{method:'POST',body:JSON.stringify({text,operationId:operationId(),...(replacing?{replyId:replacing}:{}),...confirmation,...(!bootstrap?.capabilities.chat?{demoSpeaker}:{})}),signal:request.current.signal});}
      else {if(bootstrap?.audioInputFormat==='wav'&&text.type.split(';')[0]!=='audio/wav')throw new Error('这次录音没有准备好，请重新说一次，或使用文字。');const form=new FormData();form.append('audio',text,`utterance.${text.type.includes('wav')?'wav':text.type.includes('mp4')?'mp4':text.type.includes('ogg')?'ogg':'webm'}`);form.append('operationId',operationId());if(confirmation)form.append('clarificationId',confirmation.clarificationId);if(replaceReplyId.current){form.append('replaceReplyId',replaceReplyId.current);replaceReplyId.current='';}const controller=request.current;
        const timeout=window.setTimeout(()=>controller.abort(),60000);
        try {
          const response=await fetch(`/api/calls/${current.id}/audio`,{method:'POST',credentials:'same-origin',headers:{Accept:'application/x-ndjson'},body:form,signal:controller.signal});
          turn=await readAudioTurnStream(response,(transcript,metadata)=>{
            if(generation!==epoch.current||active.current?.id!==current.id)return;
            setInputText(transcript);setInputSource(metadata?.inputSource);setDetectedLanguage(metadata?.detectedLanguage);setProcessingPhase('thinking');
          });
        } finally {window.clearTimeout(timeout);}}
      if(generation!==epoch.current||!active.current)return;if(turn.endCall){await end(turn.reply||'通话已结束，下次想聊时再来。');return;}if(typeof text!=='string'&&voiceprintParticipant.current&&turn.speaker?.status==='unknown'){speakerNeedsRejoinRef.current=true;setSpeakerNeedsRejoin(true);}if(turn.transcript)setInputText(turn.transcript);await play(turn,generation,inputStartedAt,undefined,typeof text==='string'?text:turn.transcript??'');
    }catch(err){if(generation!==epoch.current||active.current?.id!==current.id)return;restoreExpiredQuestion(err,languageQuestion,current.id,generation);setError(messageOf(err));setState('paused');}
  };
  const sendImage=async(payload:{image:Blob;question:string;audio?:Blob},externalSignal:AbortSignal)=>{
    const current=active.current;
    if(!current||speakerNeedsRejoinRef.current||cancellingRef.current||memoryPending||!syncGate.ready||!bootstrap?.capabilities.vision)throw new Error('聊天还没准备好，请稍后再发照片。');
    if(externalSignal.aborted)return;
    const inputStartedAt=performance.now(),question=payload.audio?'':payload.question.trim();
    clearStoryAudio();clearPlaybackActivity();audio.cancel();audio.preparePlayback();request.current?.abort();const controller=new AbortController();request.current=controller;
    const generation=++epoch.current;setVoiceReady(false);setAudioPreparing(false);setVoiceHolding(false);setError('');setContextNotice('');setCandidate(undefined);setReply('');setFullReply('');setReplyTextOnly(false);setInputKind('image');setInputText(question);setInputSource(undefined);setAudioReview(undefined);setDetectedLanguage(undefined);clearLanguageClarification();setReplyId('');replyIdRef.current='';replaceReplyId.current='';setInterpretedText('');setState('processing');setProcessingPhase(payload.audio?'recognizing':'thinking');
    const abort=()=>{if(generation===epoch.current&&active.current?.id===current.id)void cancel();else controller.abort();};
    externalSignal.addEventListener('abort',abort,{once:true});
    try{
      const form=new FormData();form.append('image',payload.image,'picture.jpg');if(payload.audio)form.append('audio',payload.audio,'question.wav');else form.append('question',question);form.append('operationId',operationId());
      const turn=await api<Turn>(`/calls/${current.id}/image`,{method:'POST',body:form,signal:controller.signal});
      if(generation!==epoch.current||active.current?.id!==current.id)return;
      if(turn.transcript)setInputText(turn.transcript);setProcessingPhase('thinking');
      // The accepted reply now belongs to the call; closing the draft must not abort playback.
      externalSignal.removeEventListener('abort',abort);
      if(turn.endCall){await end(turn.reply||'通话已结束。');return;}
      void play(turn,generation,inputStartedAt).catch(err=>{if(generation===epoch.current){setError(messageOf(err));setState('paused');}});
    }catch(err){if(generation===epoch.current){setError(messageOf(err));setState('paused');}throw err;}
    finally{externalSignal.removeEventListener('abort',abort);}
  };
  const pauseStory=async()=>{
    const current=active.current;if(!current||cancellingRef.current)return;
    const generation=epoch.current;storyPaused.current=true;clearPlaybackActivity();const offset=audio.pauseStoryPlayback();if(storyAudio.cache&&offset!==undefined)storyAudio.cache.offsetSeconds=offset;
    audio.stopCapture();setVoiceReady(false);setAudioPreparing(false);setVoiceHolding(false);setState('paused');setError('');if(storyRef.current){storyRef.current={...storyRef.current,status:'paused'};setStory(storyRef.current);}
    cancellingRef.current=true;setCancelling(true);
    try{const turn=await post<Turn>(`/calls/${current.id}/story-control`,{action:'pause',operationId:operationId()});if(generation!==epoch.current||active.current?.id!==current.id)return;storyRef.current=turn.story;setStory(turn.story);if(storyAudio.cache&&!matchesStoryAudio(storyAudio.cache,turn))clearStoryAudio();}
    catch(err){if(generation===epoch.current){clearStoryAudio();setError(messageOf(err));}}
    finally{if(generation===epoch.current){cancellingRef.current=false;setCancelling(false);}}
  };
  const cancel=async()=>{replaceReplyId.current='';if(storyRef.current&&storyRef.current.status!=='completed'){const currentId=active.current?.id;await pauseStory();if(active.current?.id===currentId)setState('listening');return;}clearStoryAudio();setLearning(undefined);const generation=++epoch.current;request.current?.abort();clearPlaybackActivity();audio.cancel();setVoiceReady(false);setAudioPreparing(false);setVoiceHolding(false);setReply('');setFullReply('');setReplyTextOnly(false);setInputText('');setInputSource(undefined);setAudioReview(undefined);setDetectedLanguage(undefined);clearLanguageClarification();setCandidate(undefined);setReplyId('');replyIdRef.current='';setInterpretedText('');setError('');const current=active.current;if(!current){setState('ended');setEndReason('已取消连接。');return;}cancellingRef.current=true;setCancelling(true);setState('paused');try{await post(`/calls/${current.id}/cancel`);if(generation===epoch.current&&active.current?.id===current.id)setState('listening');}catch(err){if(generation===epoch.current)setError(messageOf(err));}finally{if(generation===epoch.current){setCancelling(false);cancellingRef.current=false;}}};
  const performTurn=async(path:string,body:unknown,languageQuestion?:Turn['languageClarification'],playbackDeadline?:number)=>{
    const current=active.current;if(!current||memoryPending||!syncGate.ready||cancellingRef.current||speakerNeedsRejoinRef.current)return;
    clearLanguageClarification();setAudioReview(undefined);clearPlaybackActivity();audio.cancel();audio.preparePlayback();request.current?.abort();request.current=new AbortController();
    const generation=++epoch.current;setVoiceReady(false);setAudioPreparing(false);setVoiceHolding(false);setState('processing');setProcessingPhase('thinking');setCandidate(undefined);setReply('');setFullReply('');setReplyTextOnly(false);setError('');setContextNotice('');
    try{const turn=await api<Turn>(`/calls/${current.id}/${path}`,{method:'POST',body:JSON.stringify(body),signal:request.current.signal});if(generation!==epoch.current||active.current?.id!==current.id)return;if(turn.endCall){await end(turn.reply||'通话已结束。');return;}if(turn.transcript)setInputText(turn.transcript);await play(turn,generation,undefined,playbackDeadline);}
    catch(err){if(generation===epoch.current&&active.current?.id===current.id){restoreExpiredQuestion(err,languageQuestion,current.id,generation);setError(messageOf(err));setState('paused');}}
  };
  const confirmLanguage=async(id:string,language:SpeechLanguage)=>{
    const current=active.current;
    if(!current||!syncGate.ready||memoryPending||cancellingRef.current||speakerNeedsRejoinRef.current||voiceHolding||audioPreparing||state==='processing'||state==='speaking'
      ||!languageSession.matches(id,current.id,epoch.current))return;
    if(!languageClarification||Date.parse(languageClarification.expiresAt)<=Date.now()){
      languageSession.clear();setLanguageClarificationExpired(true);setError(LANGUAGE_EXPIRED);return;
    }
    const body=languageSession.take(id,language,current.id,epoch.current);
    if(!body)return;
    const question=languageClarification;
    clearLanguageClarification();setInputText('');setInputSource(undefined);setAudioReview(undefined);setDetectedLanguage(undefined);setInterpretedText('');setReplyId('');replyIdRef.current='';replaceReplyId.current='';
    await performTurn('language',body,question);
  };
  const startTask=async(kind:'chat'|'story'|'learning',storyId?:string,topic?:string)=>{clearStoryAudio();storyRef.current=undefined;setStory(undefined);setLearning(undefined);replaceReplyId.current='';setReplyId('');replyIdRef.current='';setInputText('');setInputSource(undefined);setAudioReview(undefined);setDetectedLanguage(undefined);clearLanguageClarification();await performTurn('task',{kind,storyId,topic,operationId:operationId()});};
  const storyControl=async(action:'next'|'pause'|'resume'|'replay'|'stop'|'complete')=>{
    if(action==='pause'){await pauseStory();return;}
    if(action==='complete'){
      const current=active.current;
      const deadline=storyCompletionDeadline(storyRef.current,Date.now(),expires.current,
        !!current&&mounted.current&&syncGate.ready&&!memoryPending&&!cancellingRef.current&&!speakerNeedsRejoinRef.current&&!storyPaused.current);
      if(!current||deadline===undefined)return;
      clearStoryAudio();
      // performTurn advances once before its first await. The timer belongs only
      // to that completion, so a later input can never be cancelled by this one.
      const generation=epoch.current+1;
      const expire=()=>{
        if(generation!==epoch.current||active.current?.id!==current.id)return;
        ++epoch.current;request.current?.abort();clearPlaybackActivity();audio.cancel();clearStoryAudio();
        if(storyRef.current) {storyRef.current={...storyRef.current,status:'completed'};setStory(storyRef.current);}
        setState('paused');
      };
      await deliverStoryCompletion({deadline,expire,
        isCurrent:()=>generation===epoch.current&&active.current?.id===current.id,
        deliver:limit=>performTurn('story-control',{action,operationId:operationId()},undefined,limit),
        setTimer:(callback,delay)=>window.setTimeout(callback,delay),clearTimer:timer=>window.clearTimeout(timer as number)});
      return;
    }
    if(action==='next'||action==='stop')clearStoryAudio();if(action==='replay'&&storyAudio.cache)storyAudio.cache.offsetSeconds=0;storyPaused.current=false;await performTurn('story-control',{action,operationId:operationId()});
  };advanceStory.current=storyControl;
  const changeConversationMode=async(mode:ConversationMode):Promise<boolean>=>{
    const current=active.current;if(!current||memoryPending||!syncGate.ready||cancellingRef.current)return false;
    clearStoryAudio();setLearning(undefined);
    const generation=++epoch.current;request.current?.abort();clearPlaybackActivity();audio.cancel();storyRef.current=undefined;setStory(undefined);setVoiceReady(false);setAudioPreparing(false);setVoiceHolding(false);setCandidate(undefined);setReply('');setFullReply('');setInputText('');setInputSource(undefined);setAudioReview(undefined);setDetectedLanguage(undefined);clearLanguageClarification();setInterpretedText('');setReplyId('');replyIdRef.current='';replaceReplyId.current='';setError('');setState('processing');
    request.current=new AbortController();
    try{const result=await api<ConversationMode>(`/calls/${current.id}/mode`,{method:'POST',body:JSON.stringify(mode),signal:request.current.signal});if(generation!==epoch.current||active.current?.id!==current.id)return false;setConversationMode(result);storyRef.current=undefined;setStory(undefined);setState('listening');return true;}
    catch(err){if(generation===epoch.current){setError(messageOf(err));setState('paused');}return false;}
  };
  const retryAudioLanguage=async(language:SpeechLanguage)=>{
    if(!audioReview||audioReview.replyId!==replyIdRef.current||Date.parse(audioReview.expiresAt)<=Date.now()){setAudioReview(undefined);setError('这句录音已清除，请重新说一句，或修改文字。');return;}
    await performTurn('audio-language',{replyId:audioReview.replyId,language,operationId:operationId()});
  };
  const correctTurn=async(text:string)=>{const id=replyIdRef.current;if(!id||!text.trim())return;clearStoryAudio();await performTurn('correct',{replyId:id,text:text.trim(),operationId:operationId()});};
  const repeatTurn=async()=>{
    const id=replyIdRef.current;const current=active.current;if(!id||!current||memoryPending||cancellingRef.current||!syncGate.ready)return;
    clearStoryAudio();const generation=++epoch.current;request.current?.abort();request.current=new AbortController();clearPlaybackActivity();audio.cancel();setVoiceReady(false);setAudioPreparing(false);setVoiceHolding(false);setCandidate(undefined);setReply('');setFullReply('');setReplyTextOnly(false);setInterpretedText('');setError('');setState('paused');setContextNotice('正在撤回刚才这一句，请稍等。');cancellingRef.current=true;setCancelling(true);
    try{
      await api(`/calls/${current.id}/retract`,{method:'POST',body:JSON.stringify({replyId:id}),signal:request.current.signal});
      if(generation!==epoch.current||active.current?.id!==current.id)return;
      replaceReplyId.current='';replyIdRef.current='';setReplyId('');setInputText('');setInputSource(undefined);setAudioReview(undefined);setDetectedLanguage(undefined);clearLanguageClarification();setState('paused');setContextNotice('上一句已撤回，不会用于自动整理记忆。此前的话题会保留，准备好后点“开始说话”，再重新说。');
    }catch(err){if(generation===epoch.current&&active.current?.id===current.id){setError(messageOf(err));setContextNotice('这次撤回的结果尚未确认，请重试“重新说这一句”。');setState('paused');}}
    finally{if(generation===epoch.current&&active.current?.id===current.id){cancellingRef.current=false;setCancelling(false);}}
  };
  const reviseMemory=async(content:string)=>{
    const current=active.current;const selected=candidate;if(!current||!selected||memoryPending||selected.action==='forget')return;
    const generation=++epoch.current;request.current?.abort();clearPlaybackActivity();audio.cancel();setFullReply('');setVoiceReady(false);setAudioPreparing(false);setVoiceHolding(false);setState('processing');setError('');request.current=new AbortController();
    try{const result=await api<{candidate:NonNullable<Turn['candidate']>}>(`/calls/${current.id}/memory/revise`,{method:'POST',body:JSON.stringify({candidateId:selected.id,content:content.trim()}),signal:request.current.signal});if(generation!==epoch.current||active.current?.id!==current.id)return;setCandidate(result.candidate);setState('listening');}
    catch(err){if(generation===epoch.current){setError(messageOf(err));setState('paused');}}
  };
  const toggleMute=()=>{const value=!mutedRef.current;mutedRef.current=value;setMuted(value);if(value){audio.stopCapture();setVoiceReady(false);setAudioPreparing(false);setVoiceHolding(false);}};
  const setVoiceMode=(mode:'hold'|'auto')=>{
    if(mode===voiceMode)return;
    audio.stopCapture();setVoiceReady(false);setAudioPreparing(false);setVoiceHolding(false);
    setVoiceModeState(mode);
  };
  const confirmMemory=async()=>{
    const current=active.current;
    if(!current||!candidate||memoryPending)return;
    if(memoryOperations.unresolved){setError('还有一项结果待核实。请先查询结果，或让家长查看记忆小本，不重复提交。');return;}
    const selected=candidate;
    const action=selected.action??'save';
    clearStoryAudio();clearPlaybackActivity();audio.cancel();request.current?.abort();setVoiceReady(false);setAudioPreparing(false);setVoiceHolding(false);
    const generation=++epoch.current;
    setState('paused');setError('');setContextNotice('');setCandidate(undefined);setReply('');setFullReply('');setReplyTextOnly(false);setInputText('');setInputSource(undefined);setAudioReview(undefined);setDetectedLanguage(undefined);clearLanguageClarification();
    const outcome=await memoryOperations.submit(action,id=>post(`/calls/${current.id}/memory/${action==='forget'?'forget':'confirm'}`,{candidateId:selected.id,operationId:id}));
    if(generation!==epoch.current||active.current?.id!==current.id)return;
    if(!outcome.submitted){setError(outcome.message??'这次请求尚未提交。');setCandidate(selected);}
    setState('listening');
  };
  const retrySpeaker=async()=>{const current=active.current;if(!current||cancellingRef.current)return;await cancel();if(active.current?.id!==current.id)return;clearStoryAudio();const generation=epoch.current;try{await post(`/calls/${current.id}/speaker/retry`);if(generation!==epoch.current||active.current?.id!==current.id)return;speakerNeedsRejoinRef.current=false;setSpeakerNeedsRejoin(false);setSpeaker(undefined);setState('listening');setFullReply('');setReply(bootstrap?.capabilities.voiceprint?'请本次同意参与、已登记声音的家人再说一次。':'准备好后，请再说一次。这一步仍为模拟识人。');}catch(err){if(generation===epoch.current){setState('paused');setError(messageOf(err));}}};
  const correctSpeaker=async()=>{
    const current=active.current;if(!current||!voiceprintParticipant.current||!bootstrap?.capabilities.voiceprint||memoryPending||cancellingRef.current||!syncGate.ready)return;
    clearStoryAudio();const generation=++epoch.current;request.current?.abort();clearPlaybackActivity();audio.cancel();
    speakerNeedsRejoinRef.current=true;setSpeakerNeedsRejoin(true);setSpeaker({status:'unknown'});
    setVoiceReady(false);setAudioPreparing(false);setVoiceHolding(false);setCandidate(undefined);setReply('');setFullReply('');setReplyTextOnly(false);setInputText('');setInputSource(undefined);setAudioReview(undefined);setDetectedLanguage(undefined);clearLanguageClarification();setInterpretedText('');setReplyId('');replyIdRef.current='';replaceReplyId.current='';storyRef.current=undefined;setStory(undefined);setLearning(undefined);setError('');setState('paused');
    setContextNotice('这次识人已停止。请已登记并同意参与的本人重新加入，再说一次。');
    cancellingRef.current=true;setCancelling(true);request.current=new AbortController();
    try{await api(`/calls/${current.id}/speaker/retry`,{method:'POST',body:JSON.stringify({}),signal:request.current.signal});}
    catch(err){if(generation===epoch.current&&active.current?.id===current.id)setError(messageOf(err));}
    finally{if(generation===epoch.current&&active.current?.id===current.id){cancellingRef.current=false;setCancelling(false);}}
  };
  return {state,call,remaining,muted,reply,fullReply,replyTextOnly,playbackActive,spokenSegment,characterReaction,inputText,inputKind,inputSource,detectedLanguage,audioReview,languageClarification,languageClarificationExpired,processingPhase,candidate,speaker,speakerNeedsRejoin,story,learning,conversationMode,interpretedText,emotion,replyId,error,endReason,contextNotice,syncReady,memoryOperations,voiceReady,voiceMode,setVoiceMode,voiceHolding,setVoiceHolding,audioPreparing,setAudioPreparing,memoryPending,cancelling,audio,start,end,send,sendImage,setImagePickerActive,cancel,startTask,storyControl,changeConversationMode,confirmLanguage,correctTurn,retryAudioLanguage,repeatTurn,reviseMemory,toggleMute,confirmMemory,retrySpeaker,correctSpeaker,setVoiceReady,setError,setState,active:call!==null||state==='connecting'};
}
export type CallController = ReturnType<typeof useCall>;
