import type { AgeGroup } from './types.js';
import { ORIGINAL_STORIES, storyCatalog, type StoryDefinition, type StoryTheme } from './content-catalog.js';
import { createLearningEngine, LEARNING_TOPICS, type LearningAction, type LearningResult, type LearningSnapshot } from './learning-engine.js';

export type ContentContext = { ageGroup: AgeGroup; remainingSeconds: number; hardEndsAt?: number; storyId?: string; theme?: StoryTheme; durationSeconds?: number };
export type ContentInput = ContentContext & { callId: string; text: string };
export type ContentAction = 'start' | 'next' | 'repeat' | 'pause' | 'resume' | 'stop' | 'complete' | `choose:${string}` | `learning:${LearningAction}`;
export type StoryState = {
  id: string; title: string; segment: number; total: number; status: 'playing' | 'paused' | 'completed' | 'stopped';
  endsAt: number; choices?: { id: string; label: string }[];
};
type StorySession = { id: string; title: string; revision: number; total: number; index: number; status: StoryState['status']; endsAt: number; chosen?: string; lastReply: string; awaitingContinuation?: boolean };
export type ContentSnapshot = { story: StorySession | null; learning: LearningSnapshot | null; active: 'story' | 'learning' | null };
export type StoryResult = { handled: true; reply: string; story?: StoryState; presentation: 'story' };
export type ContentResult = StoryResult | LearningResult;

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const positive = (seconds: number) => Number.isFinite(seconds) && seconds > 0;
const compact = (text: string) => text.trim().replace(/[\s，。！？!?]/g, '');
export function createContentEngine({ now = Date.now, catalogProvider = () => ORIGINAL_STORIES, learningTopicsProvider = () => LEARNING_TOPICS }: { now?: () => number; catalogProvider?: () => readonly StoryDefinition[]; learningTopicsProvider?: () => readonly { id: string; title: string; scope: string }[] } = {}) {
  const find = (id: string) => catalogProvider().find(story => story.id === id && story.publication === 'published');
  const sessions = new Map<string, StorySession>();
  const active = new Map<string, 'story' | 'learning'>();
  const learning = createLearningEngine({ now });
  const view = (session: StorySession): StoryState => {
    const story = find(session.id);
    if (!story || (story.revision || 1) !== session.revision) session.status = 'stopped';
    return { id: session.id, title: session.title, segment: session.index + 1, total: session.total, status: session.status, endsAt: session.endsAt,
      ...(story && session.status === 'playing' && session.index === 1 && story.choices && !session.chosen ? { choices: story.choices.map(({ id, label }) => ({ id, label })) } : {}),
    };
  };
  const result = (reply: string, session?: StorySession): StoryResult => {
    if (session) session.lastReply = reply;
    return { handled: true, reply, ...(session ? { story: view(session) } : {}), presentation: 'story' };
  };
  const deadline = (session: StorySession, context: ContentContext) => {
    if (positive(context.remainingSeconds)) session.endsAt = Math.min(session.endsAt, now() + context.remainingSeconds * 1000,Number.isFinite(context.hardEndsAt)?context.hardEndsAt!:Infinity);
    if (!positive(context.remainingSeconds) || now() >= session.endsAt) { session.status = 'stopped';session.awaitingContinuation=false; return false; }
    return true;
  };
  function start(callId: string, context: ContentContext): StoryResult {
    if (!positive(context.remainingSeconds)||(Number.isFinite(context.hardEndsAt)&&now()>=context.hardEndsAt!)) return result('这次聊天的时间到了，故事先到这里。');
    const matching = catalogProvider().filter(story => story.publication === 'published' && story.ageGroup === context.ageGroup && (!context.theme || story.theme === context.theme));
    const requested = context.storyId ? find(context.storyId) : undefined;
    if (context.storyId && (!requested || requested.ageGroup !== context.ageGroup || requested.publication !== 'published')) return result('这篇故事不在当前年龄段的已发布目录中，可以从故事列表重新选择。');
    const duration = context.durationSeconds && positive(context.durationSeconds) ? Math.min(context.durationSeconds, context.remainingSeconds) : context.remainingSeconds;
    const suitable = matching.filter(story => story.durationSeconds <= duration);
    const previous = sessions.get(callId)?.id;
    const story = requested || (suitable.length ? suitable : matching).find(story => story.id !== previous) || matching[0];
    if (!story) return result('这个年龄段暂时没有该主题的已发布故事，可以看看故事列表。');
    learning.cancel(callId); active.set(callId, 'story');
    const session: StorySession = { id: story.id, title: story.title, revision: story.revision || 1, total: story.segments.length, index: 0, status: 'playing', endsAt: Math.min(now() + duration * 1000,Number.isFinite(context.hardEndsAt)?context.hardEndsAt!:Infinity), lastReply: '' };
    sessions.set(callId, session);
    return result(`我们听《${story.title}》，一共${story.segments.length}小段。${story.durationSeconds > duration ? '时间有限，我们会在约定时间结束，不为讲完而延长。' : ''}${story.segments[0]}`, session);
  }
  function storyControl(callId: string, action: ContentAction, context: ContentContext): StoryResult {
    if (action === 'start') return start(callId, context);
    const session = sessions.get(callId);
    if (!session) return result('还没有正在讲的故事，可以先从故事列表选一篇。');
    if (!deadline(session, context)) return result('约定的时间到了，故事在这里收住。', session);
    const story = find(session.id);
    if (!story || (story.revision || 1) !== session.revision) { session.status = 'stopped'; return result('这篇故事已更新或下架，先在这里停下。请从当前目录重新选择。', session); }
    if(action!=='complete')session.awaitingContinuation=false;
    const segmentText = () => session.index === story.segments.length - 1 && session.chosen ? story.choices?.find(choice => choice.id === session.chosen)?.ending || story.segments[session.index]! : story.segments[session.index]!;
    if (action === 'stop') { session.status = 'stopped'; return result('故事先到这里。想再听时可以重新选一篇。', session); }
    if (action === 'pause') {
      if (session.status === 'playing') session.status = 'paused';
      return result(session.status === 'paused' ? '故事暂停，进度留在这次聊天里。休息不会延长约定时间。' : '这篇故事已经结束。', session);
    }
    if (action === 'resume') {
      if (session.status === 'paused') session.status = 'playing';
      if (session.status === 'stopped' || session.status === 'completed') return result('这篇故事已经结束。可以重新选一篇。', session);
      return result(`我们接着《${story.title}》的第${session.index + 1}段。${segmentText()}`, session);
    }
    if (session.status === 'paused') return result('故事还在暂停，准备好后说“继续故事”。', session);
    if (session.status === 'stopped') return result('这篇故事已经停止，可以重新选一篇。', session);
    if (action === 'repeat') {
      if (session.status === 'completed') session.status = 'playing';
      return result(segmentText(), session);
    }
    if (action === 'complete') {
      if (session.index !== story.segments.length - 1) return result('还没有到最后一段，不能把整篇故事标为完成。', session);
      if (session.status === 'completed') return result('这篇故事已经讲完。', session);
      session.status = 'completed'; session.awaitingContinuation=true; return result('故事讲完啦。还想听一篇，还是先休息？', session);
    }
    if (session.status === 'completed') return result('这篇故事已经讲完。可以从列表选下一篇，或者在这里休息。', session);
    if (action.startsWith('choose:')) {
      const choice = story.choices?.find(item => item.id === action.slice('choose:'.length));
      if (session.index !== 1 || !choice) return result('现在没有这个故事选择，可以按页面上的选项选择。', session);
      session.chosen = choice.id; session.index = 2; session.status = 'playing';
      return result(choice.ending, session);
    }
    if (session.index === 1 && story.choices?.length && !session.chosen) return result(`这里有两个选择：${story.choices.map(choice => `“${choice.label}”`).join('，或者')}。选一个，我们再讲结尾。`, session);
    if (session.index === story.segments.length - 1) return result('已经到最后一段，播放结束后再确认完成；也可以重听或停止。', session);
    session.index = Math.min(session.index + 1, story.segments.length - 1);
    return result(story.segments[session.index]!, session);
  }
  const control = (callId: string, action: ContentAction, context: ContentContext): ContentResult => {
    if (action === 'complete' && active.get(callId) === 'learning') return result('当前正在学习，没有待确认完成的故事。');
    const lesson = learning.state(callId);
    if ((action.startsWith('learning:') || active.get(callId) === 'learning') && lesson && !learningTopicsProvider().some(topic => topic.id === lesson.topic)) { learning.clear(callId); active.delete(callId); return { handled: true, presentation: 'learning', reply: '这类学习内容已下架，先停在这里。可以从当前学习目录选择其他练习。' }; }
    if (action.startsWith('learning:')) { active.set(callId, 'learning'); return learning.control(callId, action.slice('learning:'.length) as LearningAction, context); }
    if (action !== 'start' && !action.startsWith('choose:') && active.get(callId) === 'learning') return learning.control(callId, action === 'next' ? 'next' : action as LearningAction, context);
    active.set(callId, 'story'); return storyControl(callId, action, context);
  };
  function handle(input: ContentInput): ContentResult | undefined {
    const text = compact(input.text);
    // Only explicit, standalone song requests reach this availability reply.
    // A feeling, a preference or a question about a song remains ordinary chat.
    const musicCommand=text.replace(/^宝妍(?:姐姐)?/,'').replace(/(?:吧|好吗)$/,'');
    const namedSong='(?:《[^《》]{1,60}》|[^《》]{1,60})这首歌';
    if(new RegExp(`^(?:请|帮我|给我)?(?:播放|放)(?:音乐|歌曲|歌|首歌|一首歌|${namedSong})$`).test(musicCommand)
      ||new RegExp(`^(?:我想要|我想|想)?听(?:音乐|歌曲|歌|首歌|一首歌|${namedSong})$`).test(musicCommand)){
      const session=sessions.get(input.callId);if(session){session.awaitingContinuation=false;if(session.status==='playing')session.status='paused';}
      return result('歌曲播放还没接好，现在可以先听故事。');
    }
    const currentLesson = learning.state(input.callId);
    if (active.get(input.callId) === 'learning' && currentLesson && !learningTopicsProvider().some(topic => topic.id === currentLesson.topic)) { learning.clear(input.callId); active.delete(input.callId); return { handled: true, presentation: 'learning', reply: '这类学习内容已下架，先停在这里。可以从当前学习目录选择其他练习。' }; }
    if (/^(故事列表|有什么故事|有哪些故事|看看故事|选故事)$/.test(text)) {
      const titles = storyCatalog(input.ageGroup, catalogProvider()).map(story => `《${story.title}》`);
      return result(`这个年龄段有${titles.join('、')}。可以选标题，也可以告诉我想听的主题和时长。`);
    }
    const explicitId = text.match(/^讲故事[:：]([a-z0-9-]+)$/)?.[1];
    const titleRequest=text.replace(/^宝妍(?:姐姐)?/,'').replace(/^(?:请|帮我|给我|我想要|我想|想)/,'').replace(/^(?:听|讲)(?:一下)?/,'').replace(/[《》]/g,'').replace(/(?:吧|好吗)$/,'');
    const requested = catalogProvider().find(story => story.id === explicitId || story.title === titleRequest);
    if (explicitId && !requested) return result('这篇故事不在已发布目录中，可以重新选择。');
    if(!requested&&/^(?:宝妍)?(?:请|帮我|给我|我想要|我想|想)?(?:听|讲)《[^《》]{1,100}》(?:吧|好吗)?$/.test(text))return result('这篇故事暂时不在已发布目录里。可以告诉我想听的主题，我从已有故事中选一篇。');
    const storyRequest = /^(?:宝妍)?(?:请|帮我|给我|我想要|我想|想)?(?:听|讲|讲个|讲一个|讲一篇|听个|听一个)(?:一个|一篇|个)?(?:.{0,15})?故事(?:吧|好吗)?$/.test(text) || /^(故事|睡前故事|讲故事)$/.test(text);
    if (requested || storyRequest) {
      if (/恐怖|血腥|色情|暴力/.test(text)) return result('当前目录是适龄陪伴故事。可以选友谊、勇气、情绪、好奇、责任、关怀或睡前主题。');
      const theme: StoryTheme | undefined = /睡前|晚安/.test(text) ? '睡前' : /朋友|友谊/.test(text) ? '友谊' : /勇敢|勇气/.test(text) ? '勇气' : /生气|情绪|难过/.test(text) ? '情绪' : /探索|好奇/.test(text) ? '好奇' : /责任|负责/.test(text) ? '责任' : /关心|关怀/.test(text) ? '关怀' : input.theme;
      const durationMatch = text.match(/([1-9]|一|两|二|三|四|五|六|七|八|九|十)分钟/);
      const durationDigit = durationMatch ? ({ 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }[durationMatch[1]!] || Number(durationMatch[1])) : undefined;
      return start(input.callId, { ...input, storyId: requested?.id || input.storyId, theme, durationSeconds: durationDigit ? durationDigit * 60 : input.durationSeconds });
    }
    const lastSession=sessions.get(input.callId);
    const explicitAnother=/^(?:(?:再来|再听|再讲|换)(?:一篇|一个|个)(?:故事)?(?:吧)?|(?:还想听|还要听|想再听)(?:一篇|一个|故事)?)$/.test(text);
    if (lastSession && (active.get(input.callId) === 'story' || /^(继续故事|接着故事|暂停故事|停止故事|结束故事)$/.test(text) || (lastSession.status==='completed'&&explicitAnother))) {
      const session = sessions.get(input.callId)!, definition = find(session.id);
      if (!definition || (definition.revision || 1) !== session.revision) { session.status = 'stopped'; return result('这篇故事已更新或下架，先在这里停下。请从当前目录重新选择。', session); }
      // These short answers belong only to the just-finished story invitation.
      // An ordinary chat or a paused story must not start new content by guessing.
      if (session.status === 'completed') {
        if (explicitAnother) return start(input.callId, input);
        if (session.awaitingContinuation && now()<session.endsAt && /^(?:好|好呀|好啊|要|要呀|想听|继续听)$/.test(text))return start(input.callId,input);
        if ((session.awaitingContinuation && now()<session.endsAt && /^(?:不要|不用|不听|不了|休息)$/.test(text)) || /^(?:不听了|不想听了|不要了|不用了|先不听了|先休息|休息一下|停止|停|先停下)(?:吧)?$/.test(text)) return storyControl(input.callId, 'stop', input);
      }
      const choice = definition.choices?.find(item => text === item.label || text === `选${item.label}` || text === `我选${item.label}` || text === item.id);
      if (choice) return storyControl(input.callId, `choose:${choice.id}`, input);
      const command: ContentAction | undefined = /^(下一段|接着讲|继续讲|继续故事|接着故事|继续)$/.test(text) ? session.status === 'paused' ? 'resume' : 'next'
        : /^(暂停故事|暂停|等一下)$/.test(text) ? 'pause'
        : /^(重听这一段|重听|再讲一遍|再听一遍)$/.test(text) ? 'repeat'
        : /^(停止故事|结束故事|不听故事了|退出故事|不听了|不想听了|停止|停|先停下)$/.test(text) ? 'stop' : undefined;
      if (command) { active.set(input.callId, 'story'); learning.cancel(input.callId); return storyControl(input.callId, command, input); }
    }
    const previousSession=sessions.get(input.callId);if(previousSession){previousSession.awaitingContinuation=false;if(['completed','stopped'].includes(previousSession.status)&&active.get(input.callId)==='story')active.delete(input.callId);}
    const lesson = learning.handle(input);
    if (lesson?.learning && !learningTopicsProvider().some(topic => topic.id === lesson.learning!.topic)) { learning.clear(input.callId); return { handled: true, presentation: 'learning', reply: '这类学习内容暂未上架，可以从当前目录选择其他练习。' }; }
    if (lesson) { const session = sessions.get(input.callId); if (session?.status === 'playing') session.status = 'paused'; active.set(input.callId, 'learning'); }
    return lesson;
  }
  return {
    handle, control,
    catalog: (ageGroup?: AgeGroup) => ({ stories: storyCatalog(ageGroup, catalogProvider()), learningTopics: learningTopicsProvider().map(topic => ({ ...topic })) }),
    state: (callId: string) => {const session=sessions.get(callId);return {active:active.get(callId),story:session&&(active.get(callId)==='story'||['playing','paused'].includes(session.status))?view(session):undefined,learning:learning.state(callId)};},
    checkpoint: (callId: string): ContentSnapshot => ({ story: sessions.get(callId) ? copy(sessions.get(callId)!) : null, learning: learning.checkpoint(callId), active: active.get(callId) || null }),
    restore: (callId: string, snapshot: ContentSnapshot) => {
      if (snapshot.story && find(snapshot.story.id)) sessions.set(callId, copy(snapshot.story)); else sessions.delete(callId);
      learning.restore(callId, snapshot.learning);
      if (snapshot.active) active.set(callId, snapshot.active); else active.delete(callId);
    },
    cancel: (callId: string) => { const session = sessions.get(callId); if(session){session.awaitingContinuation=false;if(session.status === 'playing') session.status = 'paused';else if(['completed','stopped'].includes(session.status)&&active.get(callId)==='story')active.delete(callId);} learning.cancel(callId); },
    clear: (callId: string) => { sessions.delete(callId); active.delete(callId); learning.clear(callId); },
  };
}
