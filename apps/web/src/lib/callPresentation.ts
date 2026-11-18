import type { CallState } from './types';

export type ProcessingPhase = 'recognizing' | 'thinking' | 'preparing-speech';
export interface CallPresentationInput {
  state: CallState;
  liveVoice: boolean;
  voiceReady: boolean;
  muted: boolean;
  audioPreparing: boolean;
  memoryPending: boolean;
  cancelling: boolean;
  hasCandidate: boolean;
  forgetCandidate: boolean;
  processingPhase: ProcessingPhase;
  voiceMode?: 'hold' | 'auto';
  voiceHolding?: boolean;
}
export interface CallPresentation {
  title: string;
  detail: string;
  turn: 'you' | 'baoyan' | 'waiting' | 'off';
}

/** Presentation follows confirmed media state; stale readiness never overrides a stopped or busy turn. */
export function getCallPresentation(input: CallPresentationInput): CallPresentation {
  const { state } = input;
  if (state === 'idle') return {
    title: '有小事，想和我分享吗？',
    detail: '准备好后，点“和我说话”。',
    turn: 'off',
  };
  if (state === 'ended') return {
    title: '这次先聊到这里',
    detail: '收音和播放已停止，不会自动重新连接。',
    turn: 'off',
  };
  if (state === 'connecting') return {
    title: '正在和宝妍连接',
    detail: '连接好、麦克风准备好后再说。',
    turn: 'waiting',
  };
  if (input.audioPreparing) return {
    title: '正在整理这段声音',
    detail: '麦克风已关闭，处理好后会开始识别。',
    turn: 'waiting',
  };
  if (input.memoryPending) return {
    title: '正在提交，请稍等',
    detail: '正在确认这次记忆操作，麦克风已关闭。',
    turn: 'waiting',
  };
  if (input.hasCandidate && state !== 'processing' && state !== 'speaking') return {
    title: input.forgetCandidate ? '只忘记这一条' : '一起确认这件小事',
    detail: '请确认或取消，确认期间麦克风已关闭。',
    turn: 'waiting',
  };
  if (state === 'processing') {
    if (input.processingPhase === 'recognizing') return {
      title: '正在识别你说的话',
      detail: '麦克风已关闭，文字出来后会显示。',
      turn: 'waiting',
    };
    if (input.processingPhase === 'preparing-speech') return {
      title: '正在准备宝妍的声音',
      detail: '麦克风已关闭，声音开始播放时会同步显示回复文字。',
      turn: 'waiting',
    };
    return {
      title: '宝妍在想一想',
      detail: '麦克风已关闭，宝妍想好后再回答。',
      turn: 'waiting',
    };
  }
  if (state === 'speaking') return {
    title: '宝妍在说话',
    detail: '想插话可点“我来说”。',
    turn: 'baoyan',
  };
  if (state === 'paused') return input.cancelling ? {
    title: '正在停止这一轮',
    detail: '麦克风已关闭，请稍等。',
    turn: 'waiting',
  } : {
    title: '我们停一下，再继续',
    detail: !input.liveVoice ? '麦克风已关闭，可以直接打字。' : input.muted ? '麦克风已关闭，仍保持静音；点“开始说话”才开麦。' : '麦克风已关闭，准备好了可以点“开始说话”。',
    turn: 'waiting',
  };
  if (input.muted) return {
    title: '麦克风已关闭',
    detail: '文字输入仍可使用。想用声音说话时，点“打开麦克风”。',
    turn: 'off',
  };
  if (!input.liveVoice) return {
    title: '轮到你输入了',
    detail: '这是文字对话，不会录音。',
    turn: 'you',
  };
  if (input.voiceMode === 'hold' && !input.voiceHolding) return {
    title: '轮到你了，按住说话',
    detail: '按住下方按钮再说，松手发送。未按住时麦克风关闭。',
    turn: 'you',
  };
  if (!input.voiceReady) return {
    title: '正在打开麦克风',
    detail: '麦克风准备好后再说，也可以先输入文字。',
    turn: 'waiting',
  };
  return {
    title: input.voiceMode === 'hold' ? '正在收音，松手发送' : '轮到你说了',
    detail: input.voiceMode === 'hold' ? '继续按住说话，停顿不会自动发送。' : '停顿一会儿会自动发送，也可以点“说完了，发送”。',
    turn: 'you',
  };
}
