export type Outfit = 'mint' | 'peach' | 'night';
export interface Child { id: string; nickname: string; ageGroup: '3-5'|'6-8'|'9-12'|'13-14'; outfit: Outfit; showCaptions: boolean; memoryEnabled: boolean; voiceEnabled: boolean; sessionMinutes: number; dailyMinutes: number }
export interface Memory { id: string; key: string; content: string; scope: 'global'|'personal'; kind: 'preference'|'event'|'imaginary'|'plan'; revision: number; expiresAt?: string; source: string }
export interface Member { id: string; name: string; relation: '爸爸'|'妈妈'|'爷爷'|'奶奶'|'外公'|'外婆'|'孩子'|'其他家人'; status: 'not_enrolled'|'demo'|'enrolled'|'disabled'; consent: boolean }
export interface Trial { enabled: true; requiresInvite: boolean; expiresAt: string; maxSessionMinutes: number; maxDailyMinutes: number }
export interface AccountState { bound:boolean; signedIn:boolean; username?:string; expiresAt?:string; pending?:boolean; guardian?:boolean; childName?:string; hasPin?:boolean }
export interface Bootstrap { realtime?:{configured:boolean}; account?:AccountState; trial?: Trial; audioInputFormat?: 'browser'|'wav'; configured: boolean; mode: 'demo'|'live'|'mixed'; capabilities: {chat:boolean;asr:boolean;tts:boolean;ttsStreaming?:boolean;voiceprint:boolean;audioUnderstanding?:boolean;autoLanguage?:boolean;vision?:boolean}; child: Child|null; parentAuthorized: boolean; memoryCount: number; memberCount: number; globalMemories: Memory[]; globalRevision?: number; remainingDailySeconds: number; demoSpeakers?: {id:string;relation:string}[] }
export interface Call { id: string; expiresAt: string; remainingSeconds: number; memoryRevision: number; globalRevision: number; speakerRevision: number }
export interface ConversationMode { mode:'chat'|'auto'|'dialect'; dialect?:'chaoshan'|'hakka'; behavior?:'understand'|'translate' }
export type SpeechLanguage = 'mandarin'|'chaoshan'|'hakka'|'cantonese'|'english';
export interface AudioInputMetadata { inputSource?:'transcript'|'interpretation'; detectedLanguage?:SpeechLanguage }
export interface LanguageClarification { id:string; expiresAt:string }
export type ReplyExpression = 'natural'|'bright'|'gentle'|'clear';
export interface ReplySegment { text:string; expression:ReplyExpression }
export interface StoryProgress { id:string;title:string;segment:number;total:number;status:'playing'|'paused'|'completed';endsAt:string;choices?:{id:string;label:string}[] }
export interface StoryItem {id:string;title:string;theme:string;ageGroups:string[];durationSeconds:number;source?:string}
export interface LearningTopic {id:string;title:string;description?:string;ageGroups?:string[]}
export interface LearningProgress {topic:'arithmetic'|'units'|'chinese'|'english';stage:'confirm'|'attempt'|'explain'|'finished'|'paused'|'stopped';question:string;step:number;totalSteps:number;endsAt:number}
export interface SoftwareCatalog {stories:StoryItem[];learningTopics:LearningTopic[]}
export interface Turn extends AudioInputMetadata { inputKind?: 'image'; transcript?: string; reply: string; replyId: string; replySegments?:ReplySegment[]; mode: 'demo'|'live'; memoryRevision: number; globalRevision: number; speakerRevision: number; candidate?: { id: string; content: string; key: string; kind: string; action?: 'save'|'forget'; memoryId?: string }; speaker?: { name?: string; status: 'known'|'unknown'|'demo' }; endCall?: boolean;story?:StoryProgress;learning?:LearningProgress;conversationMode?:ConversationMode;interpretedText?:string;emotion?:'warm'|'thoughtful'|'happy'|'calm';languageClarification?:LanguageClarification;audioReview?:{replyId:string;expiresAt:string} }
export type CallState = 'idle'|'connecting'|'listening'|'processing'|'speaking'|'paused'|'ended';
