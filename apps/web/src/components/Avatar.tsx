import { useEffect, useRef, useState } from 'react';
import type { Outfit, CallState } from '../lib/types';
import { characterMotionFor, type CharacterMotion } from '../lib/characterMotion';

type Expression = 'warm' | 'thoughtful' | 'happy' | 'calm';
type CharacterAsset = 'neutral' | 'thoughtful' | 'happy' | 'calm' | 'welcome' | 'full-welcome';
const expressions: Record<Expression, CharacterAsset> = { warm: 'neutral', thoughtful: 'thoughtful', happy: 'happy', calm: 'calm' };
const descriptions: Record<CharacterAsset, string> = { neutral: '微笑陪着你', thoughtful: '认真想一想', happy: '开心地说话', calm: '安静休息', welcome: '挥手问好', 'full-welcome': '挥手问好' };

/** Current call state wins over the expression retained from the previous reply. */
export function characterAssetFor(state: CallState, emotion: Expression, view: 'full' | 'portrait' = 'portrait'): CharacterAsset {
  if (state === 'idle') return view === 'full' ? 'full-welcome' : 'welcome';
  if (state === 'processing') return 'thoughtful';
  if (state === 'speaking') return expressions[emotion];
  if (state === 'paused' || state === 'ended') return 'calm';
  return 'neutral';
}

export interface CharacterReaction { id: string; motion: 'reaction-happy' | 'reaction-sad' }
const motionDescriptions: Record<CharacterMotion | 'cover', string> = {
  cover: '宝妍 bobo 形象封面，温柔陪伴，每一件小事', idle: '宝妍安静陪着你', listening: '宝妍认真听你说', thinking: '宝妍正在想一想',
  'speaking-natural': '宝妍自然地说话', 'speaking-happy': '宝妍开心地说话', 'speaking-caring': '宝妍温柔地安慰',
  'speaking-explaining': '宝妍耐心地讲解', 'speaking-question': '宝妍好奇地询问', 'reaction-happy': '宝妍开心地回应', 'reaction-sad': '宝妍难过地回应',
};
const mediaRoot = '/assets/character-motion-v1';
const staticRoot = '/assets/character-v2';
const useMotionVideos = import.meta.env?.VITE_CHARACTER_VIDEO === 'true';
const staticByMotion: Record<CharacterMotion, CharacterAsset> = {
  idle: 'neutral', listening: 'neutral', thinking: 'thoughtful',
  'speaking-natural': 'neutral', 'speaking-happy': 'happy', 'speaking-caring': 'calm',
  'speaking-explaining': 'thoughtful', 'speaking-question': 'thoughtful',
  'reaction-happy': 'happy', 'reaction-sad': 'calm',
};

/** Decorative video never controls or delays the speech/recording clock. */
function CharacterVideo({ motion, loop, onFinished }: { motion: CharacterMotion; loop: boolean; onFinished: () => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [visible, setVisible] = useState(false);
  const [failed, setFailed] = useState(false);
  const finished = useRef(onFinished); finished.current = onFinished;
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    let current = true;
    video.muted = true; video.defaultMuted = true; video.src = `${mediaRoot}/${motion}.mp4`;
    const fail = () => { if (current) { video.pause(); setVisible(false); setFailed(true); finished.current(); } };
    const timeout = window.setTimeout(() => { if (video.readyState < 2 || video.paused) fail(); }, 8000);
    void video.play().catch(fail);
    return () => { current = false; clearTimeout(timeout); video.pause(); video.removeAttribute('src'); video.load(); };
  }, []);
  if (failed) return null;
  return <video ref={ref} className={`character-video ${visible ? 'is-playing' : ''}`} src={`${mediaRoot}/${motion}.mp4`}
    width={480} height={854} muted playsInline loop={loop} preload="none" disablePictureInPicture disableRemotePlayback
    aria-hidden="true" tabIndex={-1} onPlaying={() => setVisible(true)} onWaiting={() => setVisible(false)}
    onError={() => { setVisible(false); setFailed(true); finished.current(); }} onEnded={() => { if (!loop) finished.current(); }}/>;
}

export function Avatar({ state = 'idle', small = false, emotion = 'warm', view = 'full', playbackActive = false, listeningActive = false, segmentText = '', suspended = false, reaction }: {
  outfit?: Outfit; state?: CallState; small?: boolean; emotion?: Expression; view?: 'full' | 'portrait'; playbackActive?: boolean;
  listeningActive?: boolean; segmentText?: string; suspended?: boolean; reaction?: CharacterReaction;
}) {
  const [motionAllowed, setMotionAllowed] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  const [activeReaction, setActiveReaction] = useState<CharacterReaction>();
  const seenReaction = useRef(reaction?.id);
  const [failedPoster, setFailedPoster] = useState<string>();
  useEffect(() => {
    const element = container.current;
    if (!element || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => setInView(entry?.isIntersecting === true));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setMotionAllowed(!document.hidden && !preference.matches);
    update(); document.addEventListener('visibilitychange', update); preference.addEventListener('change', update);
    const hide = () => setMotionAllowed(false); window.addEventListener('pagehide', hide);
    return () => { document.removeEventListener('visibilitychange', update); preference.removeEventListener('change', update); window.removeEventListener('pagehide', hide); };
  }, []);
  useEffect(() => {
    const eligible = motionAllowed && inView && !suspended && state === 'listening' && !listeningActive;
    if (!eligible) setActiveReaction(undefined);
    if (reaction && seenReaction.current !== reaction.id) {
      seenReaction.current = reaction.id;
      if (eligible) setActiveReaction(reaction);
    }
  }, [reaction, motionAllowed, inView, suspended, state, listeningActive]);
  useEffect(() => {
    if (!activeReaction) return;
    const timeout = window.setTimeout(() => setActiveReaction(undefined), 6000);
    return () => clearTimeout(timeout);
  }, [activeReaction]);
  const base = characterMotionFor({ state, emotion, playbackActive, listeningActive, segmentText, suspended });
  const mayReact = motionAllowed && inView && !suspended && state === 'listening' && !listeningActive;
  const media = mayReact && activeReaction ? activeReaction.motion : base;
  const animated = useMotionVideos && media !== 'cover' && motionAllowed && inView && !suspended && state !== 'paused' && state !== 'connecting'
    && !(state === 'speaking' && !playbackActive);
  const poster = media === 'cover' ? `${mediaRoot}/cover.webp` : `${staticRoot}/${staticByMotion[media]}.webp`;
  return <div ref={container} className={`avatar-wrap character-v2 character-media character-view-${small ? 'portrait' : view} avatar-${state} ${small ? 'avatar-small' : ''} ${media === 'cover' ? 'character-cover' : ''}`}
    data-character-state={state} data-character-asset={media} data-character-motion={animated ? media : 'still'}>
    <img className="bobo-avatar character-art" src={failedPoster === poster ? '/assets/character-v2/neutral.webp' : poster}
      width={media === 'cover' ? 864 : 480} height={media === 'cover' ? 1536 : 854} alt={motionDescriptions[media]} decoding="async" draggable={false}
      onError={() => setFailedPoster(poster)}/>
    {animated ? <CharacterVideo key={`${media}:${activeReaction?.id ?? ''}`} motion={media} loop={!media.startsWith('reaction-')} onFinished={() => setActiveReaction(undefined)}/> : null}
  </div>;
}

export function CharacterMark() {
  return <span className="brand-flower character-brand" aria-hidden="true"><img src={`${mediaRoot}/cover.webp`} width={864} height={1536} alt="" decoding="async" draggable={false}/></span>;
}
