import type { HistoryItem, Preferences, Provider, ProviderKind } from '../types';
import { isNative } from './platform';
import { OCR_LANGUAGES } from './catalog';

const STORAGE_PREFIX = 'fastdict.v1.';
export const HISTORY_LIMIT = 100;
const sessionKeys = new Map<string, string>();
const PROVIDER_KINDS = new Set<ProviderKind>(['openai', 'anthropic', 'gemini', 'codex']);
const PROVIDER_ID = /^[a-zA-Z0-9_-]{1,120}$/;
const OCR_LANGUAGE_VALUES = new Set(OCR_LANGUAGES.map(language => language.value));
type StorageArea = 'providers' | 'preferences' | 'history';
const AREA_NAMES: Record<StorageArea, string> = { providers: 'API 配置', preferences: '偏好设置', history: '翻译记录' };
const storageProblems = new Map<string, string>();
const unreadableAreas = new Set<StorageArea>();
let storageAdapter: Storage | undefined;

function storage(): Storage {
  const adapter = globalThis.localStorage;
  if (!adapter) throw new Error('本地存储不可用');
  if (adapter !== storageAdapter) {
    storageAdapter = adapter; storageProblems.clear(); unreadableAreas.clear();
  }
  return adapter;
}

/** Fixed diagnostics only: never include stored text, provider URLs or secrets. */
export function getStorageWarnings(): string[] { return [...storageProblems.values()]; }

function storageProblem(area: StorageArea, operation: 'read' | 'write' | 'delete'): void {
  const action = operation === 'read' ? '读取' : operation === 'write' ? '保存' : '清除';
  storageProblems.set(area + ':' + operation, '无法' + action + '本地' + AREA_NAMES[area] + '，请检查存储权限或可用空间；原有数据不会被自动清除。');
}

function preferenceOcrLanguage(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_PREFERENCES.ocrLang;
  const normalized = [...new Set(value.split('+'))].sort((a, b) => a === 'eng' ? -1 : b === 'eng' ? 1 : a.localeCompare(b)).join('+');
  return OCR_LANGUAGE_VALUES.has(normalized) ? normalized : DEFAULT_PREFERENCES.ocrLang;
}

export const DEFAULT_PREFERENCES: Preferences = {
  sourceLang: 'auto', targetLang: 'zh-CN', ocrLang: 'eng', autoTranslate: true, activeProviderId: '',
};

function read(key: StorageArea): unknown {
  try {
    const raw = storage().getItem(STORAGE_PREFIX + key);
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    if (key === 'preferences' ? value === null || typeof value !== 'object' || Array.isArray(value) : !Array.isArray(value)) throw new Error('保存的数据格式不正确');
    unreadableAreas.delete(key);
    return value;
  } catch {
    unreadableAreas.add(key); storageProblem(key, 'read');
    return null;
  }
}

function write(key: StorageArea, value: unknown): void {
  try {
    const adapter = storage();
    // A fallback value must never replace bytes which failed to load.
    if (unreadableAreas.has(key)) throw new Error('原有数据尚未成功读取');
    adapter.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
  } catch {
    storageProblem(key, 'write');
    throw new Error('无法保存本地设置，请检查存储权限或可用空间；原有数据已保留。');
  }
}

function record(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}; }
function boundedString(value: unknown, maximum = 500): string { return typeof value === 'string' ? value.slice(0, maximum) : ''; }

function providerMetadata(value: unknown): Provider | null {
  const item = record(value);
  const id = boundedString(item.id, 120);
  const kind = item.kind as ProviderKind;
  if (!PROVIDER_ID.test(id) || !PROVIDER_KINDS.has(kind)) return null;
  const savedName = boundedString(item.name, 80);
  return {
    id, name: kind === 'codex' && savedName === '本机 Codex（GPT 订阅）' ? 'ChatGPT 订阅' : savedName, kind,
    baseUrl: kind === 'codex' ? '' : boundedString(item.baseUrl, 2000), model: boundedString(item.model, 200),
    hasKey: kind === 'codex' ? false : isNative ? item.hasKey === true : sessionKeys.has(id),
  };
}

/** This flag records only the notice acknowledgement, never identity or credentials. */
export function hasAcknowledgedChatGPTPlan(): boolean {
  try { return storage().getItem(STORAGE_PREFIX + 'chatgptPlanNotice') === 'acknowledged'; }
  catch { return false; }
}

export function acknowledgeChatGPTPlan(): void {
  try { storage().setItem(STORAGE_PREFIX + 'chatgptPlanNotice', 'acknowledged'); }
  catch { /* The notice can be shown again if storage is unavailable. */ }
}

export function loadProviders(): Provider[] {
  const saved = read('providers');
  if (!Array.isArray(saved)) return [];
  const seen = new Set<string>();
  return saved.flatMap(value => {
    const item = providerMetadata(value);
    if (!item || seen.has(item.id)) return [];
    seen.add(item.id);
    return [item];
  }).slice(0, 30);
}

/** Persist only the known metadata fields. Secret values never enter localStorage. */
export function saveProviders(providers: Provider[]): void {
  const metadata = providers.slice(0, 30).flatMap(value => { const item = providerMetadata(value); return item ? [item] : []; });
  write('providers', metadata);
}

export function loadPreferences(): Preferences {
  const saved = record(read('preferences'));
  return {
    sourceLang: boundedString(saved.sourceLang, 80) || DEFAULT_PREFERENCES.sourceLang,
    targetLang: boundedString(saved.targetLang, 80) || DEFAULT_PREFERENCES.targetLang,
    ocrLang: preferenceOcrLanguage(saved.ocrLang),
    autoTranslate: typeof saved.autoTranslate === 'boolean' ? saved.autoTranslate : DEFAULT_PREFERENCES.autoTranslate,
    activeProviderId: boundedString(saved.activeProviderId, 120) || DEFAULT_PREFERENCES.activeProviderId,
  };
}

export function savePreferences(preferences: Preferences): void {
  write('preferences', {
    sourceLang: boundedString(preferences.sourceLang, 80), targetLang: boundedString(preferences.targetLang, 80),
    ocrLang: preferenceOcrLanguage(preferences.ocrLang), autoTranslate: preferences.autoTranslate === true, activeProviderId: boundedString(preferences.activeProviderId, 120),
  });
}

function historyMetadata(value: unknown): HistoryItem | null {
  const item = record(value);
  if (typeof item.id !== 'string' || typeof item.source !== 'string' || typeof item.translation !== 'string' || typeof item.createdAt !== 'number' || !Number.isFinite(item.createdAt)) return null;
  if (!['text', 'clipboard', 'image'].includes(String(item.input))) return null;
  return {
    id: boundedString(item.id, 120), source: boundedString(item.source, 60_000), translation: boundedString(item.translation, 100_000),
    sourceLang: boundedString(item.sourceLang, 80), targetLang: boundedString(item.targetLang, 80), providerName: boundedString(item.providerName, 80),
    createdAt: item.createdAt, durationMs: typeof item.durationMs === 'number' && Number.isFinite(item.durationMs) ? Math.max(0, item.durationMs) : 0,
    input: item.input as HistoryItem['input'],
  };
}

export function loadHistory(): HistoryItem[] {
  const saved = read('history');
  if (!Array.isArray(saved)) return [];
  return saved.flatMap(value => { const item = historyMetadata(value); return item ? [item] : []; }).slice(0, HISTORY_LIMIT);
}

export function saveHistory(history: HistoryItem[]): void {
  write('history', history.slice(0, HISTORY_LIMIT).flatMap(value => { const item = historyMetadata(value); return item ? [item] : []; }));
}

export function addHistory(item: HistoryItem): HistoryItem[] {
  const history = [item, ...loadHistory().filter(previous => previous.id !== item.id)].slice(0, HISTORY_LIMIT);
  saveHistory(history);
  return history;
}

export function clearHistory(): void {
  try { storage().removeItem(STORAGE_PREFIX + 'history'); unreadableAreas.delete('history'); }
  catch { storageProblem('history', 'delete'); throw new Error('无法清除历史记录，请检查本地存储权限。'); }
}

export async function saveApiKey(providerId: string, apiKey: string): Promise<void> {
  const key = apiKey.trim();
  if (!key) { await deleteApiKey(providerId); return; }
  if (key.length > 4096 || /[\0\r\n]/.test(key)) throw new Error('API Key 格式不正确。');
  if (!PROVIDER_ID.test(providerId)) throw new Error('服务配置标识不正确。');
  if (isNative) {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('save_api_key', { providerId, apiKey: key });
  } else sessionKeys.set(providerId, key);
}

export async function getApiKey(providerId: string): Promise<string | null> {
  if (isNative) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<string | null>('get_api_key', { providerId });
  }
  return sessionKeys.get(providerId) ?? null;
}

export async function deleteApiKey(providerId: string): Promise<void> {
  if (isNative) {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('delete_api_key', { providerId });
  } else sessionKeys.delete(providerId);
}
