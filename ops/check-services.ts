import 'dotenv/config';
import { createProviders } from '../apps/server/src/providers.js';
import { createVolcRealtime } from '../apps/server/src/volc-realtime.js';
import { createVolcVoiceprint } from '../apps/server/src/volc-voiceprint.js';

// This check is deliberately local: it never sends a prompt, audio, or key over the network.
const env = process.env;
const { capabilities, audioInputFormat } = createProviders({ env });
const realtime = createVolcRealtime({ env }).configured;
const voiceprint = capabilities.asr && env.ASR_PROVIDER === 'volc' && createVolcVoiceprint({ env }).configured;
const label = (ready: boolean) => ready ? '已配置，尚需真实联调' : '未启用或配置未完整';
console.log('宝妍服务配置检查（只检查本机配置，不调用API，不产生模型调用费用）');
console.log(`文字对话：${label(capabilities.chat)}`);
console.log(`语音识别：${label(capabilities.asr)}`);
console.log(`语音合成：${label(capabilities.tts)}`);
console.log(`识图：${label(capabilities.vision)}`);
console.log(`语种自动判断：${label(capabilities.autoLanguage)}`);
console.log(`实时语音：${label(realtime)}`);
console.log(`声纹识人：${label(voiceprint)}`);
console.log(`录音传输格式：${audioInputFormat === 'wav' ? '16kHz 单声道 WAV' : '浏览器原始格式'}`);
console.log('密钥、模型输入及录音内容不会在此输出。配置完整不代表已连通或效果通过。');
