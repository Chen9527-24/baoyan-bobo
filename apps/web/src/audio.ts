import { convertRecordingToWav, MAX_RECORDING_BYTES } from './audioWav';
import { ApiError } from './lib/api';

/** Local, explicit-start audio only. This module never uploads audio or starts another turn. */
export interface AudioCapabilities {
  secureContext: boolean;
  microphone: boolean;
  recording: boolean;
  playback: boolean;
  streamingPlayback: boolean;
  speechSynthesis: boolean;
}

export interface MeterOptions {
  onLevel: (rms: number) => void;
  durationMs?: number;
  onDone?: () => void;
  onError?: (error: Error) => void;
}

export interface ListeningOptions {
  outputFormat?: 'browser' | 'wav';
  /** Manual mode only submits through finishUtterance; silence and the time limit never submit. */
  endMode?: 'silence' | 'manual';
  /** Capture has stopped; final recorder data and optional WAV conversion are still pending. */
  onProcessing?: () => void;
  onUtterance: (blob: Blob) => void | Promise<void>;
  onSilence?: () => void;
  /** Live WebAudio RMS in [0, 1], sampled every 50 ms while capture is active. */
  onLevel?: (rms: number) => void;
  /** Once per utterance, after the configured minimum sustained speech is detected. */
  onSpeechStart?: () => void;
  onError?: (error: Error) => void;
  silenceMs?: number;
  maxDurationMs?: number;
  noSpeechTimeoutMs?: number;
  speechThreshold?: number;
  minimumSpeechMs?: number;
}

export interface PlaybackOptions {
  onStart?: () => void;
  /** Confirmed output playback activity, separate from the reply's once-only first start. */
  onActivityChange?: (active: boolean) => void;
  onEnd?: () => void;
  onError?: (error: Error) => void;
  timeoutMs?: number;
  /** Optional first-playing deadline, separate from the overall playback duration. */
  startTimeoutMs?: number;
  /** PCM/Blob monotonic start target, at most 500ms ahead; expired targets add no pause. */
  notBeforeMs?: number;
}

export interface SpeechOptions extends PlaybackOptions {
  lang?: string;
  rate?: number;
}

export type PlaybackResult = 'ended' | 'cancelled';

/** Optional dependencies make permission/cancellation races testable without a microphone. */
export interface AudioDependencies {
  secureContext: boolean;
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  createAudioContext?: () => AudioContext;
  createRecorder?: (stream: MediaStream, options?: MediaRecorderOptions) => MediaRecorder;
  convertRecordingToWav: (blob: Blob, options: { signal: AbortSignal; maxDurationMs: number }) => Promise<Blob>;
  supportsMimeType: (mime: string) => boolean;
  createAudioElement?: () => HTMLAudioElement;
  speechSynthesis?: SpeechSynthesis;
  createSpeechUtterance?: (text: string) => SpeechSynthesisUtterance;
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
  now: () => number;
  setInterval: typeof globalThis.setInterval;
  clearInterval: typeof globalThis.clearInterval;
  setTimeout: typeof globalThis.setTimeout;
  clearTimeout: typeof globalThis.clearTimeout;
}

function browserDependencies(): AudioDependencies {
  const browser = globalThis as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  const Context = browser.AudioContext ?? browser.webkitAudioContext;
  const media = globalThis.navigator?.mediaDevices;
  return {
    secureContext: globalThis.isSecureContext === true,
    getUserMedia: media?.getUserMedia ? (constraints) => media.getUserMedia(constraints) : undefined,
    createAudioContext: Context ? () => new Context() : undefined,
    createRecorder: typeof MediaRecorder !== 'undefined' ? (stream, options) => new MediaRecorder(stream, options) : undefined,
    convertRecordingToWav,
    supportsMimeType: (mime) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime),
    createAudioElement: typeof Audio !== 'undefined' ? () => new Audio() : undefined,
    speechSynthesis: globalThis.speechSynthesis,
    createSpeechUtterance: typeof SpeechSynthesisUtterance !== 'undefined' ? (text) => new SpeechSynthesisUtterance(text) : undefined,
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    now: () => performance.now(),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };
}

function capabilities(deps: AudioDependencies): AudioCapabilities {
  const microphone = deps.secureContext && !!deps.getUserMedia && !!deps.createAudioContext;
  return {
    secureContext: deps.secureContext,
    microphone,
    recording: microphone && !!deps.createRecorder,
    playback: !!deps.createAudioElement,
    streamingPlayback: !!deps.createAudioContext,
    speechSynthesis: !!deps.speechSynthesis && !!deps.createSpeechUtterance,
  };
}

/** Feature detection only: never asks permission or opens an audio context. */
export function getAudioCapabilities(): AudioCapabilities {
  return capabilities(browserDependencies());
}

export class AudioControllerError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'AudioControllerError';
  }
}

function friendlyError(error: unknown, fallback = '声音操作未完成，请重新点击再试一次。'): Error {
  if (error instanceof ApiError) return error;
  if (error instanceof AudioControllerError) return error;
  const name = error instanceof Error ? error.name : '';
  const messages: Record<string, string> = {
    NotAllowedError: '未获得麦克风或声音播放权限，请在浏览器设置中允许后重新点击。',
    SecurityError: '浏览器限制了声音权限，请通过安全页面打开并重新点击。',
    NotFoundError: '没有找到麦克风，请检查设备连接。',
    NotReadableError: '麦克风暂时无法使用，可能被其他程序占用。',
    NotSupportedError: '当前浏览器不支持这种声音格式，请换用支持的浏览器。',
    AbortError: '声音操作已中断，请重新点击开始。',
  };
  return new AudioControllerError(messages[name] ?? fallback, name || 'audio_error');
}

function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value!)) : fallback;
}

function playbackNotBefore(value: number | undefined, now: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || !Number.isFinite(now) || value - now > 500)
    throw new AudioControllerError('声音段落等待时间无效，已停止播放。', 'invalid_playback_timing');
  return value;
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

interface Capture {
  generation: number;
  stream: MediaStream;
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  recorder?: MediaRecorder;
  chunks: Blob[];
  byteLength: number;
  interval?: ReturnType<typeof setInterval>;
  deadline?: ReturnType<typeof setTimeout>;
  finalizationTimeout?: ReturnType<typeof setTimeout>;
  finishing: boolean;
  resourcesClosed: boolean;
  cancelUnlock?: () => void;
  finishUtterance?: () => void;
  onTrackEnded?: () => void;
}

export class AudioController {
  private readonly deps: AudioDependencies;
  private captureGeneration = 0;
  private playbackGeneration = 0;
  private requestingCapture = false;
  private capture?: Capture;
  private conversion?: { generation: number; cancellation: AbortController };
  private cancelPlayback?: () => void;
  private storyElement?: HTMLAudioElement;
  private playbackContext?: AudioContext;
  private disposed = false;
  private lifecycleAttached = false;
  private readonly onVisibility = () => {
    if (globalThis.document?.visibilityState === 'hidden') { this.cancel(); this.closePlaybackContext(); }
  };
  private readonly onLeave = () => { this.cancel(); this.closePlaybackContext(); };

  constructor(dependencies: Partial<AudioDependencies> = {}) {
    this.deps = { ...browserDependencies(), ...dependencies };
  }

  getCapabilities(): AudioCapabilities { return capabilities(this.deps); }

  /** Call synchronously from an explicit gesture, before networking; asks no microphone permission. */
  preparePlayback(): void {
    if(this.disposed || !this.deps.createAudioContext || globalThis.document?.visibilityState==='hidden')return;
    try {
      if(!this.playbackContext || this.playbackContext.state==='closed')this.playbackContext=this.deps.createAudioContext();
      this.attachLifecycle();
      void this.playbackContext.resume().catch(()=>{});
    } catch { /* Playback reports actionable permission errors if the user sends a turn. */ }
  }

  private closePlaybackContext(): void {
    const context=this.playbackContext;this.playbackContext=undefined;
    if(context && context.state!=='closed')void context.close().catch(()=>{});
    this.detachLifecycleWhenIdle();
  }

  /** Returns false if cancelled while a permission prompt or audio context was pending. */
  async startMeter(options: MeterOptions): Promise<boolean> {
    const session = await this.acquire(false);
    if (!session || !this.isCurrent(session)) return false;
    const data = new Float32Array(session.analyser.fftSize);
    session.interval = this.deps.setInterval(() => {
      if (!this.isCurrent(session) || session.finishing) return;
      try {
        session.analyser.getFloatTimeDomainData(data);
        options.onLevel(this.rms(data));
      } catch (error) { this.failCapture(session, options, error); }
    }, 50);
    session.deadline = this.deps.setTimeout(() => {
      if (!this.isCurrent(session)) return;
      this.releaseCapture(session, true);
      options.onDone?.();
    }, bounded(options.durationMs, 10_000, 1_000, 30_000));
    this.watchTracks(session, options);
    return true;
  }

  async startListening(options: ListeningOptions): Promise<boolean> {
    const session = await this.acquire(true);
    if (!session || !this.isCurrent(session)) return false;
    const generation = session.generation;
    const automatic = options.endMode !== 'manual';
    const maximumMs = bounded(options.maxDurationMs, 30_000, 1_000, 30_000);
    const noSpeechMs = Math.min(maximumMs, bounded(options.noSpeechTimeoutMs, 12_000, 1_000, 30_000));
    const silenceMs = bounded(options.silenceMs, 1_400, 300, 5_000);
    const threshold = bounded(options.speechThreshold, 0.018, 0.001, 1);
    const minimumSpeechMs = bounded(options.minimumSpeechMs, 180, 0, 1_000);
    const data = new Float32Array(session.analyser.fftSize);
    const startedAt = this.deps.now();
    let previousAt = startedAt;
    let lastVoiceAt = startedAt;
    let voicedMs = 0;
    let heardSpeech = false;

    const finish = () => {
      if (!this.isCurrent(session) || session.finishing) return;
      session.finishing = true;
      // stop() queues the final chunk; all tracks are closed synchronously before delivery.
      try { session.recorder!.stop(); }
      catch (error) { this.failCapture(session, options, error); return; }
      this.closeResources(session);
      if (!this.isCurrent(session)) return;
      session.finalizationTimeout = this.deps.setTimeout(() => {
        this.failCapture(session, options, new AudioControllerError('录音未能完成，请重新点击再说一次。', 'recording_timeout'));
      }, 3_000);
      try { options.onProcessing?.(); }
      catch (error) { this.failCapture(session, options, error); }
    };
    const finishWithoutSpeech = () => {
      if (!this.isCurrent(session)) return;
      this.releaseCapture(session, true);
      options.onSilence?.();
    };

    try {
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
        .find((mime) => this.deps.supportsMimeType(mime));
      session.recorder = this.deps.createRecorder!(session.stream, mimeType ? { mimeType } : undefined);
      const recorder = session.recorder;
      recorder.ondataavailable = (event) => {
        if (!this.isCurrent(session) || !event.data.size) return;
        if (session.byteLength + event.data.size > MAX_RECORDING_BYTES) {
          this.failCapture(session, options, new AudioControllerError('这段声音太大，请缩短后再说一次。', 'recording_too_large'));
          return;
        }
        session.byteLength += event.data.size;
        session.chunks.push(event.data);
      };
      recorder.onerror = () => this.failCapture(session, options, new Error('recorder failure'));
      recorder.onstop = () => {
        if (!this.isCurrent(session)) return;
        if (!session.finishing) {
          this.failCapture(session, options, new AudioControllerError('录音已中断，请重新点击开始。', 'recording_interrupted'));
          return;
        }
        const blob = new Blob(session.chunks, { type: recorder.mimeType || mimeType || 'audio/webm' });
        const conversion = options.outputFormat === 'wav' ? { generation, cancellation: new AbortController() } : undefined;
        if (conversion) this.conversion = conversion;
        this.releaseCapture(session, false);
        if (generation !== this.captureGeneration || this.disposed) return;
        if (!blob.size) {
          if (this.conversion === conversion) this.conversion = undefined;
          this.detachLifecycleWhenIdle();
          options.onError?.(new AudioControllerError('这次没有录到声音，请重新点击再说一次。', 'empty_recording'));
          return;
        }
        if (conversion) {
          // Capture resources have already closed. Keep lifecycle cancellation attached during conversion.
          void this.convertUtterance(blob, conversion, maximumMs, options);
        } else this.deliverUtterance(blob, generation, options);
      };
      recorder.start(500);
      session.finishUtterance = () => heardSpeech ? finish() : finishWithoutSpeech();
      session.interval = this.deps.setInterval(() => {
        if (!this.isCurrent(session) || session.finishing) return;
        try {
          session.analyser.getFloatTimeDomainData(data);
          const level = this.rms(data);
          const now = this.deps.now();
          const elapsed = Math.min(150, Math.max(0, now - previousAt));
          previousAt = now;
          options.onLevel?.(level);
          if (!this.isCurrent(session) || session.finishing) return;
          if (level >= threshold) {
            voicedMs += elapsed;
            lastVoiceAt = now;
            if (!heardSpeech && voicedMs >= minimumSpeechMs) {
              heardSpeech = true;
              options.onSpeechStart?.();
              if (!this.isCurrent(session) || session.finishing) return;
            }
          } else {
            if (!heardSpeech) voicedMs = 0;
            if (automatic && heardSpeech && now - lastVoiceAt >= silenceMs) { finish(); return; }
          }
          if (automatic && !heardSpeech && now - startedAt >= noSpeechMs) finishWithoutSpeech();
        } catch (error) { this.failCapture(session, options, error); }
      }, 50);
      session.deadline = this.deps.setTimeout(() => {
        if (!automatic) {
          this.failCapture(session, options, new AudioControllerError('每次最多按住说话 30 秒。这段未发送，请松开后重新按住说。', 'recording_limit'));
        } else if (heardSpeech) finish();
        else finishWithoutSpeech();
      }, maximumMs);
      this.watchTracks(session, options);
      return true;
    } catch (error) {
      this.releaseCapture(session, true);
      throw friendlyError(error, '当前浏览器无法录音，请检查麦克风或使用文字体验。');
    }
  }

  /**
   * Explicit "done speaking": the same finalization/conversion path as VAD silence.
   * Returns false outside an active recording (including permission, meter and conversion).
   * A silent recording is stopped with onSilence and is never delivered or uploaded.
   */
  finishUtterance(): boolean {
    const session = this.capture;
    if (!session || !this.isCurrent(session) || session.finishing || !session.finishUtterance) return false;
    session.finishUtterance();
    return true;
  }

  /** Stops capture only; an already submitted reply may keep playing while muted. */
  stopCapture(): void {
    this.captureGeneration++;
    this.requestingCapture = false;
    this.conversion?.cancellation.abort();
    this.conversion = undefined;
    if (this.capture) this.releaseCapture(this.capture, true);
    this.detachLifecycleWhenIdle();
  }

  stopPlayback(): void {
    this.playbackGeneration++;
    this.cancelPlayback?.();
    this.cancelPlayback = undefined;
    this.detachLifecycleWhenIdle();
  }

  cancel(): void { this.stopCapture(); this.stopPlayback(); }
  stop(): void { this.cancel(); }

  endPlaybackSession(): void { this.stopPlayback(); this.closePlaybackContext(); }

  dispose(): void {
    this.cancel();
    this.closePlaybackContext();
    this.disposed = true;
  }

  /** Schedule validated PCM as it arrives, without waiting for the provider's terminal event. */
  async playPcmStream(stream: (signal: AbortSignal) => AsyncIterable<Uint8Array>, options: PlaybackOptions = {}): Promise<PlaybackResult> {
    this.ensureUsable();
    if(!this.deps.createAudioContext)throw new AudioControllerError('当前浏览器无法分段播放声音。','playback_unsupported');
    const notBeforeMs=playbackNotBefore(options.notBeforeMs,this.deps.now());
    this.stopCapture();this.stopPlayback();
    const generation=this.playbackGeneration;
    const context=this.playbackContext??this.deps.createAudioContext();
    const owned=context!==this.playbackContext;
    const controller=new AbortController();const sources=new Map<AudioBufferSourceNode,{start:number;end:number}>();
    let cleaned=false,monitor: ReturnType<typeof setInterval>|undefined;
    let onContextStateChange: (() => void) | undefined;
    let iterator: AsyncIterator<Uint8Array>|undefined;
    const current=()=>!cleaned && generation===this.playbackGeneration && !this.disposed;
    return this.play({...options,timeoutMs:options.timeoutMs??120_000},generation,(done,fail,started,activity)=>{
      void (async()=>{
        await context.resume();if(!current())return;
        if(context.state!=='running')throw new AudioControllerError('浏览器尚未允许声音播放，请重新点击再试。','playback_permission');
        // A system audio interruption can leave the page visible while freezing
        // its audio clock. Discard queued speech instead of resuming an old reply
        // later or silently waiting for the overall duration limit.
        const outputRunning=()=>{
          if(!current())return false;
          if(context.state==='running')return true;
          fail(new AudioControllerError('声音被手机或浏览器中断了，请先看文字，再点一下继续聊天。','playback_interrupted'));
          return false;
        };
        onContextStateChange=()=>{outputRunning();};
        context.addEventListener?.('statechange',onContextStateChange);
        let nextAt=context.currentTime,firstAt: number|undefined,announced=false,finished=false,total=0,pending: number|undefined;
        const updateActivity=()=>{
          if(!outputRunning())return;
          const now=context.currentTime;
          let playing=false;
          if(context.state==='running')for(const range of sources.values()){
            if(now>=range.start&&now<range.end){playing=true;break;}
          }
          activity(playing);
        };
        monitor=this.deps.setInterval(()=>{
          if(!outputRunning())return;
          if(!announced && firstAt!==undefined && context.state==='running' && context.currentTime>=firstAt){announced=true;started();}
          updateActivity();
          if(finished && sources.size===0)done();
        },20);
        iterator=stream(controller.signal)[Symbol.asyncIterator]();
        while(current()){
          const part=await iterator.next();if(!outputRunning())return;if(part.done)break;
          const chunk=part.value;total+=chunk.length;
          if(!(chunk instanceof Uint8Array) || !chunk.length || total>4_320_000)throw new AudioControllerError('声音数据超过本轮限制。','invalid_audio');
          const length=Math.floor((chunk.length+(pending===undefined?0:1))/2);
          if(!length){pending=chunk[0];continue;}
          const buffer=context.createBuffer(1,length,24000),samples=buffer.getChannelData(0);
          let offset=0,index=0;
          if(pending!==undefined){const value=pending|(chunk[offset++]!<<8);samples[index++]=(value>=32768?value-65536:value)/32768;pending=undefined;}
          while(offset+1<chunk.length){const value=chunk[offset]!|(chunk[offset+1]!<<8);samples[index++]=(value>=32768?value-65536:value)/32768;offset+=2;}
          if(offset<chunk.length)pending=chunk[offset];
          const source=context.createBufferSource();source.buffer=buffer;source.connect(context.destination);
          const lead=firstAt===undefined?Math.max(0.12,notBeforeMs===undefined?0:Math.max(0,notBeforeMs-this.deps.now())/1000):0.015;
          nextAt=Math.max(nextAt,context.currentTime+lead);
          if(firstAt===undefined)firstAt=nextAt;
          source.onended=()=>{sources.delete(source);source.disconnect();updateActivity();};sources.set(source,{start:nextAt,end:nextAt+buffer.duration});
          source.start(nextAt);nextAt+=buffer.duration;
        }
        if(!current())return;
        if(pending!==undefined || !total)throw new AudioControllerError('声音数据不完整。','invalid_audio');
        finished=true;
      })().catch(error=>{if(current())fail(error);});
    },()=>{
      cleaned=true;controller.abort();
      if(onContextStateChange)context.removeEventListener?.('statechange',onContextStateChange);
      if(monitor!==undefined)this.deps.clearInterval(monitor);
      for(const source of sources.keys()){source.onended=null;try{source.stop();}catch{/* Already ended. */}source.disconnect();}sources.clear();
      void iterator?.return?.().catch(()=>{});
      if(owned && context.state!=='closed')void context.close().catch(()=>{});
    });
  }

  async playBlob(blob: Blob, options: PlaybackOptions = {}): Promise<PlaybackResult> {
    this.ensureUsable();
    if (!this.deps.createAudioElement) throw new AudioControllerError('当前浏览器无法播放声音。', 'playback_unsupported');
    const notBeforeMs=playbackNotBefore(options.notBeforeMs,this.deps.now());
    this.stopCapture();
    this.stopPlayback();
    const generation = this.playbackGeneration;
    const audio = this.deps.createAudioElement();
    const url = this.deps.createObjectURL(blob);
    let cleaned = false;
    let notBeforeTimer: ReturnType<typeof setTimeout> | undefined;
    return this.play(options, generation, (done, fail, started, activity) => {
      audio.onplaying = () => { started(); activity(true); };
      audio.onwaiting = audio.onpause = () => activity(false);
      audio.onended = done;
      audio.onerror = () => fail(new Error('playback failure'));
      audio.src = url;
      const beginPlayback=()=>{
        notBeforeTimer=undefined;
        if(cleaned || generation!==this.playbackGeneration || this.disposed)return;
        try {
          Promise.resolve(audio.play()).then(() => {
            if (cleaned || generation !== this.playbackGeneration || this.disposed) audio.pause();
          }).catch(fail);
        } catch(error) { fail(error); }
      };
      const remaining=notBeforeMs===undefined?0:Math.max(0,notBeforeMs-this.deps.now());
      if(remaining>0)notBeforeTimer=this.deps.setTimeout(beginPlayback,remaining);
      else beginPlayback();
    }, () => {
      cleaned = true;
      if(notBeforeTimer!==undefined)this.deps.clearTimeout(notBeforeTimer);
      notBeforeTimer=undefined;
      audio.onplaying = audio.onwaiting = audio.onpause = audio.onended = audio.onerror = null;
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      this.deps.revokeObjectURL(url);
    });
  }

  /** Story-only cached bytes: seek the same segment rather than requesting another synthesis. */
  async playStoryBlob(blob:Blob,offsetSeconds:number,options:PlaybackOptions={}):Promise<PlaybackResult>{
    this.ensureUsable();
    if(!this.deps.createAudioElement)throw new AudioControllerError('当前浏览器无法播放声音。','playback_unsupported');
    if(!Number.isFinite(offsetSeconds)||offsetSeconds<0)throw new AudioControllerError('故事播放位置无效，请重新选择故事。','invalid_audio');
    this.stopCapture();this.stopPlayback();
    const generation=this.playbackGeneration,audio=this.deps.createAudioElement(),url=this.deps.createObjectURL(blob);
    this.storyElement=audio;let cleaned=false,loading=false;
    return this.play(options,generation,(done,fail,started,activity)=>{
      const begin=()=>{
        if(cleaned||generation!==this.playbackGeneration||loading)return;loading=true;
        try{
          if(Number.isFinite(audio.duration)&&offsetSeconds>audio.duration+.05)throw new AudioControllerError('故事播放位置超出这段声音，请重新播放本段。','invalid_audio');
          audio.currentTime=offsetSeconds;
          Promise.resolve(audio.play()).then(()=>{if(cleaned||generation!==this.playbackGeneration)audio.pause();}).catch(fail);
        }catch(error){fail(error);}
      };
      audio.onplaying=()=>{started();activity(true);};audio.onwaiting=audio.onpause=()=>activity(false);audio.onended=done;audio.onerror=()=>fail(new Error('story playback failure'));
      audio.onloadedmetadata=begin;audio.src=url;
      if(audio.readyState>=1)begin();else audio.load();
    },()=>{
      cleaned=true;audio.onplaying=audio.onwaiting=audio.onpause=audio.onended=audio.onerror=audio.onloadedmetadata=null;
      audio.pause();audio.removeAttribute('src');audio.load();this.deps.revokeObjectURL(url);
      if(this.storyElement===audio)this.storyElement=undefined;
    });
  }

  /** Return the actual media clock before releasing its sources and object URL. */
  pauseStoryPlayback():number|undefined{
    const audio=this.storyElement;if(!audio)return undefined;
    const offset=Number.isFinite(audio.currentTime)?Math.max(0,audio.currentTime):0;
    this.stopPlayback();return offset;
  }

  async speak(text: string, options: SpeechOptions = {}): Promise<PlaybackResult> {
    this.ensureUsable();
    const synthesis = this.deps.speechSynthesis;
    if (!synthesis || !this.deps.createSpeechUtterance) throw new AudioControllerError('当前浏览器没有设备朗读功能，仍可查看文字。', 'speech_unsupported');
    this.stopCapture();
    this.stopPlayback();
    if (!text.trim()) return 'ended';
    const generation = this.playbackGeneration;
    const utterance = this.deps.createSpeechUtterance(text);
    utterance.lang = options.lang ?? 'zh-CN';
    utterance.rate = bounded(options.rate, 0.95, 0.5, 1.5);
    return this.play(options, generation, (done, fail, started, activity) => {
      utterance.onstart = () => { started(); activity(true); };
      utterance.onpause = () => activity(false);
      utterance.onresume = () => activity(true);
      utterance.onend = done;
      utterance.onerror = () => fail(new Error('speech failure'));
      synthesis.speak(utterance);
    }, () => {
      utterance.onstart = utterance.onpause = utterance.onresume = utterance.onend = utterance.onerror = null;
      synthesis.cancel();
    });
  }

  private deliverUtterance(blob: Blob, generation: number, options: ListeningOptions): void {
    if (generation !== this.captureGeneration || this.disposed) return;
    // The owner controls session validity, networking, mute and the next explicit listen.
    try {
      Promise.resolve(options.onUtterance(blob)).catch((error: unknown) => {
        if (generation === this.captureGeneration && !this.disposed) options.onError?.(friendlyError(error));
      });
    } catch (error) { if (generation === this.captureGeneration && !this.disposed) options.onError?.(friendlyError(error)); }
  }

  private async convertUtterance(blob: Blob, conversion: { generation: number; cancellation: AbortController }, maximumMs: number, options: ListeningOptions): Promise<void> {
    const current = () => this.conversion === conversion && conversion.generation === this.captureGeneration && !this.disposed && !conversion.cancellation.signal.aborted;
    try {
      if (!current()) return;
      const wav = await this.deps.convertRecordingToWav(blob, { signal: conversion.cancellation.signal, maxDurationMs: maximumMs });
      if (!current()) return;
      this.conversion = undefined;
      this.detachLifecycleWhenIdle();
      this.deliverUtterance(wav, conversion.generation, options);
    } catch (error) {
      if (current()) options.onError?.(error instanceof Error ? error : new AudioControllerError('声音处理没有完成，请重新说一次。', 'conversion_failed'));
    } finally {
      if (this.conversion === conversion) this.conversion = undefined;
      this.detachLifecycleWhenIdle();
    }
  }

  private async acquire(recording: boolean): Promise<Capture | undefined> {
    this.ensureUsable();
    const available = this.getCapabilities();
    if (!available.secureContext) throw new AudioControllerError('麦克风需要安全页面，请通过 HTTPS 或本机地址打开。', 'insecure_context');
    if (!available.microphone || (recording && !available.recording)) throw new AudioControllerError('当前浏览器不支持麦克风录音，请换用支持的浏览器或使用文字体验。', 'capture_unsupported');
    if (this.requestingCapture || this.capture || this.conversion) throw new AudioControllerError('麦克风正在使用中，请先停止当前录音或测试。', 'capture_busy');
    if (globalThis.document?.visibilityState === 'hidden') throw new AudioControllerError('请回到当前页面后重新点击开始。', 'page_hidden');
    this.stopPlayback();
    const generation = ++this.captureGeneration;
    this.requestingCapture = true;
    this.attachLifecycle();
    let stream: MediaStream | undefined;
    let context: AudioContext | undefined;
    try {
      stream = await this.deps.getUserMedia!({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      if (generation !== this.captureGeneration || this.disposed) { stopTracks(stream); return undefined; }
      context = this.deps.createAudioContext!();
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      const source = context.createMediaStreamSource(stream);
      source.connect(analyser); // Never connect input to output: no monitoring or feedback.
      const session: Capture = { generation, stream, context, source, analyser, chunks: [], byteLength: 0, finishing: false, resourcesClosed: false };
      this.capture = session;
      if (!(await this.unlockCapture(session))) { this.releaseCapture(session, true); return undefined; }
      if (!this.isCurrent(session)) { this.releaseCapture(session, true); return undefined; }
      if (!stream.getAudioTracks().some((track) => track.readyState === 'live')) throw new AudioControllerError('麦克风已断开，请重新点击开始。', 'capture_ended');
      return session;
    } catch (error) {
      if (this.capture?.generation === generation) this.releaseCapture(this.capture, true);
      else {
        if (stream) stopTracks(stream);
        if (context && context.state !== 'closed') void context.close().catch(() => {});
      }
      if (generation !== this.captureGeneration || this.disposed) return undefined;
      throw friendlyError(error);
    } finally {
      if (generation === this.captureGeneration) this.requestingCapture = false;
      this.detachLifecycleWhenIdle();
    }
  }

  private async unlockCapture(session: Capture): Promise<boolean> {
    if (session.context.state === 'running') return this.isCurrent(session);
    // Mobile WebAudio may remain suspended/interrupted even after resume resolves.
    // This limit applies after microphone permission, never to the system prompt.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const resumed = new Promise<boolean>((resolve, reject) => {
      session.cancelUnlock = () => resolve(false);
      timer = this.deps.setTimeout(() => reject(new AudioControllerError('麦克风还没能开始收音，请再点一次或使用文字；微信中也可以用系统浏览器打开。', 'capture_permission')), 8000);
      Promise.resolve().then(() => session.context.resume()).then(() => {
        if (!this.isCurrent(session)) return resolve(false);
        if (session.context.state !== 'running') return reject(new AudioControllerError('麦克风还没能开始收音，请再点一次或使用文字；微信中也可以用系统浏览器打开。', 'capture_permission'));
        resolve(true);
      }, reject);
    });
    try { return await resumed; }
    finally { if (timer !== undefined) this.deps.clearTimeout(timer); session.cancelUnlock = undefined; }
  }

  private isCurrent(session: Capture): boolean {
    return !this.disposed && this.capture === session && this.captureGeneration === session.generation;
  }

  private ensureUsable(): void {
    if (this.disposed) throw new AudioControllerError('声音组件已关闭，请重新打开页面。', 'disposed');
  }

  private attachLifecycle(): void {
    if (this.lifecycleAttached) return;
    this.lifecycleAttached = true;
    globalThis.document?.addEventListener('visibilitychange', this.onVisibility);
    globalThis.window?.addEventListener('pagehide', this.onLeave);
    globalThis.window?.addEventListener('offline', this.onLeave);
  }

  private detachLifecycleWhenIdle(): void {
    if (!this.lifecycleAttached || this.requestingCapture || this.capture || this.conversion || this.cancelPlayback || this.playbackContext) return;
    this.lifecycleAttached = false;
    globalThis.document?.removeEventListener('visibilitychange', this.onVisibility);
    globalThis.window?.removeEventListener('pagehide', this.onLeave);
    globalThis.window?.removeEventListener('offline', this.onLeave);
  }

  private rms(data: Float32Array): number {
    return Math.min(1, Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length));
  }

  private watchTracks(session: Capture, options: { onError?: (error: Error) => void }): void {
    session.onTrackEnded = () => {
      if (!session.finishing) this.failCapture(session, options, new AudioControllerError('麦克风已断开，请重新点击开始。', 'capture_ended'));
    };
    for (const track of session.stream.getTracks()) track.addEventListener('ended', session.onTrackEnded);
  }

  private closeResources(session: Capture): void {
    if (session.resourcesClosed) return;
    session.resourcesClosed = true;
    session.cancelUnlock?.();
    session.cancelUnlock = undefined;
    session.finishUtterance = undefined;
    if (session.interval !== undefined) this.deps.clearInterval(session.interval);
    if (session.deadline !== undefined) this.deps.clearTimeout(session.deadline);
    if (session.onTrackEnded) for (const track of session.stream.getTracks()) track.removeEventListener('ended', session.onTrackEnded);
    stopTracks(session.stream);
    session.source.disconnect();
    session.analyser.disconnect();
    if (session.context.state !== 'closed') void session.context.close().catch(() => {});
  }

  private releaseCapture(session: Capture, discard: boolean): void {
    if (session.finalizationTimeout !== undefined) this.deps.clearTimeout(session.finalizationTimeout);
    if (session.recorder) {
      session.recorder.ondataavailable = session.recorder.onstop = session.recorder.onerror = null;
      if (discard && session.recorder.state !== 'inactive') {
        try { session.recorder.stop(); } catch { /* Tracks below still close. */ }
      }
    }
    session.chunks = [];
    this.closeResources(session);
    if (this.capture === session) this.capture = undefined;
    this.detachLifecycleWhenIdle();
  }

  private failCapture(session: Capture, options: { onError?: (error: Error) => void }, error: unknown): void {
    if (!this.isCurrent(session)) return;
    this.releaseCapture(session, true);
    options.onError?.(friendlyError(error, '录音未完成，请重新点击再试一次。'));
  }

  private play(
    options: PlaybackOptions,
    generation: number,
    begin: (done: () => void, fail: (error: unknown) => void, started: () => void, activity: (active: boolean) => void) => void,
    cleanup: () => void,
  ): Promise<PlaybackResult> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let announced = false;
      let active = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let startTimer: ReturnType<typeof setTimeout> | undefined;
      const current = () => !settled && generation === this.playbackGeneration && !this.disposed;
      const changeActivity = (value: boolean) => {
        if(active===value)return;
        active=value;
        try { options.onActivityChange?.(value); } catch { /* A visual observer cannot interrupt media cleanup or settlement. */ }
      };
      const complete = (result: PlaybackResult, error?: Error) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) this.deps.clearTimeout(timer);
        if (startTimer !== undefined) this.deps.clearTimeout(startTimer);
        cleanup();
        changeActivity(false);
        this.cancelPlayback = undefined;
        this.detachLifecycleWhenIdle();
        if (error) { reject(error); options.onError?.(error); }
        else { resolve(result); if (result === 'ended') options.onEnd?.(); }
      };
      this.cancelPlayback = () => complete('cancelled');
      this.attachLifecycle();
      const fail = (error: unknown) => { if (current()) complete('ended', friendlyError(error, '声音播放失败，请点击重新播放或查看文字。')); };
      timer = this.deps.setTimeout(() => fail(new AudioControllerError('声音播放超时，已停止播放。', 'playback_timeout')), bounded(options.timeoutMs, 90_000, 1_000, 120_000));
      if (options.startTimeoutMs !== undefined) startTimer = this.deps.setTimeout(() =>
        fail(new AudioControllerError('声音没有及时开始播放，已停止等待，可以先阅读文字。', 'playback_start_timeout')),
      bounded(options.startTimeoutMs, 8_000, 1_000, 120_000));
      try {
        begin(() => { if (current()) complete('ended'); }, fail, () => {
          if (current() && !announced) {
            announced = true;
            if (startTimer !== undefined) this.deps.clearTimeout(startTimer);
            startTimer = undefined;
            options.onStart?.();
          }
        }, value => { if(current())changeActivity(value); });
      } catch (error) { fail(error); }
    });
  }
}
