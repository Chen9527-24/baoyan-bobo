import type { SpeechExpression } from './reply-expression.js';
import type { ReplySegment } from './reply-plan.js';
export type AgeGroup = '3-5' | '6-8' | '9-12' | '13-14';
export type Child = {
    id: string;
    nickname: string;
    ageGroup: AgeGroup;
    outfit: 'mint' | 'peach' | 'night';
    showCaptions: boolean;
    memoryEnabled: boolean;
    voiceEnabled: boolean;
    sessionMinutes: number;
    dailyMinutes: number;
};
export type Memory = {
    id: string;
    key: string;
    content: string;
    scope: 'global' | 'personal';
    kind: 'preference' | 'event' | 'imaginary' | 'plan';
    revision: number;
    expiresAt?: string;
    source: string;
};
export type Member = {
    id: string;
    name: string;
    relation: '爸爸' | '妈妈' | '爷爷' | '奶奶' | '外公' | '外婆' | '孩子' | '其他家人';
    status: 'not_enrolled' | 'demo' | 'enrolled' | 'disabled';
    consent: boolean;
};
export type Candidate = {
    id: string;
    content: string;
    key: string;
    kind: Memory['kind'];
    action: 'save' | 'forget';
    memoryId?: string;
    globalRevision: number;
    memoryRevision: number;
    speakerRevision: number;
    generation: number;
    expiresAt: number;
};
export type Reply = {
    text: string;
    speechExpression?: SpeechExpression;
    segments?: ReplySegment[];
    globalRevision: number;
    memoryRevision: number;
    speakerRevision: number;
    generation: number;
};
export type CallContext = {
    id: string;
    familyId: string;
    generation: number;
    speakerRevision: number;
    speaker: 'child' | 'adult' | 'unknown';
    speakerName?: string;
    speakerMemberId?:string;
    voiceprintPaused?:boolean;
    voiceprintParticipation?:boolean;
    conversationMode?:{mode:'chat'|'dialect';dialect:'chaoshan'|'hakka'|'cantonese';behavior:'understand'|'translate'}|{mode:'auto';dialect?:undefined;behavior?:undefined};
    pendingLanguage?: {id:string;buffer:Buffer;mime:string;image?:{buffer:Buffer;mime:string};transcript:string;resolving?:boolean;recordedDay:string;expiresAt:number;timer?:ReturnType<typeof setTimeout>;version:{memoryRevision:number;globalRevision:number;speakerRevision:number}};
    /** One recent auto-language voice turn, RAM only; cleared by any new turn/context change. */
    audioReview?: {replyId:string;buffer:Buffer;mime:string;recordedDay:string;expiresAt:number;timer?:ReturnType<typeof setTimeout>;version:{generation:number;memoryRevision:number;globalRevision:number;speakerRevision:number}};
    lastMemoryPromptId?:string;
    storyReplyId?:string;
    measuredReplies?:Set<string>;
    earlierStatements?:string[];
    autoMemoryStatements?:{id:string;text:string;recordedDay?:string}[];
    dailyChatStatements?:{id:string;text:string;recordedDay:string}[];
    autoMemoryOptOut?:boolean;
    retractedReplyId?:string;
    lastTurn?:{replyId:string;inputText:string;inputSource?:'transcript'|'interpretation';detectedLanguage?:'mandarin'|'chaoshan'|'hakka'|'cantonese'|'english';historyBefore:CallContext['history'];earlierStatementsBefore?:string[];autoMemoryStatementsBefore?:{id:string;text:string;recordedDay?:string}[];dailyChatStatementsBefore?:{id:string;text:string;recordedDay:string}[];autoMemoryOptOutBefore?:boolean;contentBefore:unknown;version:{globalRevision:number;memoryRevision:number;speakerRevision:number}};
    candidate?: Candidate;
    replies: Map<string, Reply>;
    history: {
        role: 'user' | 'assistant';
        content: string;
    }[];
    pending?: Set<AbortController>;
    turnOps: Map<string, {
        textHash: string;
        speaker?: string;
        promise?: Promise<unknown>;
        version: { generation: number; memoryRevision: number; globalRevision: number; speakerRevision: number };
    }>;

};
