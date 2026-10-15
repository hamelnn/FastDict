import type { Provider } from '../types';

export const LANGUAGES = [
  { code: 'auto', label: '自动检测' },
  { code: 'zh-CN', label: '简体中文' },
  { code: 'zh-TW', label: '繁體中文' },
  { code: 'en', label: '英语' },
  { code: 'ja', label: '日语' },
  { code: 'ko', label: '韩语' },
  { code: 'fr', label: '法语' },
  { code: 'de', label: '德语' },
  { code: 'es', label: '西班牙语' },
  { code: 'ru', label: '俄语' },
];

export const OCR_LANGUAGES = [
  { value: 'eng', label: '英文 / 拉丁字母' },
  { value: 'eng+chi_sim', label: '简体中文 + 英文' },
  { value: 'eng+chi_tra', label: '繁體中文 + 英文' },
  { value: 'eng+jpn', label: '日语 + 英文' },
  { value: 'eng+kor', label: '韩语 + 英文' },
];

export type ProviderPreset = Readonly<Omit<Provider, 'hasKey'>>;

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4.1-mini',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    kind: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-haiku-4-5',
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    kind: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-2.5-flash',
  },
  {
    id: 'ollama',
    name: '本地 Ollama',
    kind: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen3:4b',
  },
  { id: 'custom', name: '自定义 API', kind: 'openai', baseUrl: 'https://api.example.com/v1', model: '' },
];

export const labelForLanguage = (code: string) =>
  LANGUAGES.find((language) => language.code === code)?.label || code;
