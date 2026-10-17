import type { HistoryItem, Preferences, Provider, ProviderKind } from '../types';
import { isNative } from './platform';
import { OCR_LANGUAGES } from './catalog';
import { createId } from './id';
import { DEFAULT_TRANSLATION_PROMPT, normalizePromptTemplate } from './prompts';

const STORAGE_PREFIX = 'fastdict.v1.';
export const HISTORY_LIMIT = 100;
export const HISTORY_BYTE_LIMIT = 2 * 1024 * 1024;
export const PROVIDER_LIMIT = 30;
const sessionKeys = new Map<string, string>();
const PROVIDER_KINDS = new Set<ProviderKind>(['openai', 'anthropic', 'gemini', 'codex']);
const PROVIDER_ID = /^[a-zA-Z0-9_-]{1,120}$/;
const OCR_LANGUAGE_VALUES = new Set(OCR_LANGUAGES.map(language => language.value));
type StorageArea = 'providers' | 'preferences' | 'history' | 'configuration';
const AREA_NAMES: Record<StorageArea, string> = { providers: 'API 配置', preferences: '偏好设置', history: '翻译记录', configuration: '服务与偏好配置' };
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
  translationPrompt: DEFAULT_TRANSLATION_PROMPT,
};

function read(key: StorageArea): unknown {
  try {
    const raw = storage().getItem(STORAGE_PREFIX + key);
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    if (key === 'configuration') {
      const config = record(value);
      if (config.version !== 1 || !Array.isArray(config.providers) || config.preferences === null || typeof config.preferences !== 'object' || Array.isArray(config.preferences)) throw new Error('保存的数据格式不正确');
    } else if (key === 'preferences' ? value === null || typeof value !== 'object' || Array.isArray(value) : !Array.isArray(value)) throw new Error('保存的数据格式不正确');
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
  if (kind !== 'codex' && item.credentialId !== undefined && item.credentialId !== null && (typeof item.credentialId !== 'string' || !PROVIDER_ID.test(item.credentialId))) return null;
  const credentialId = kind !== 'codex' && item.credentialId !== undefined ? item.credentialId as string | null : undefined;
  const keyId = credentialId === undefined ? id : credentialId;
  return {
    id, name: kind === 'codex' && savedName === '本机 Codex（GPT 订阅）' ? 'ChatGPT 订阅' : savedName, kind,
    baseUrl: kind === 'codex' ? '' : boundedString(item.baseUrl, 2000), model: boundedString(item.model, 200),
    hasKey: kind === 'codex' ? false : keyId === null ? false : isNative ? item.hasKey === true : sessionKeys.has(keyId),
    ...(credentialId !== undefined ? { credentialId } : {}),
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
  const configuration = readConfiguration();
  if (unreadableAreas.has('configuration')) return [];
  const saved = configuration ? configuration.providers : read('providers');
  if (!Array.isArray(saved)) return [];
  const seen = new Set<string>();
  return saved.flatMap(value => {
    const item = providerMetadata(value);
    if (!item || seen.has(item.id)) return [];
    seen.add(item.id);
    return [item];
  }).slice(0, PROVIDER_LIMIT);
}

/** Persist only the known metadata fields. Secret values never enter localStorage. */
export function saveProviders(providers: Provider[]): void {
  const metadata = providersMetadata(providers);
  const configuration = readConfiguration();
  if (unreadableAreas.has('configuration')) throw new Error('无法保存服务配置：原有配置无法读取，原有数据已保留。');
  if (configuration) write('configuration', { ...configuration, providers: metadata });
  else write('providers', metadata);
}

export function loadPreferences(): Preferences {
  const configuration = readConfiguration();
  if (unreadableAreas.has('configuration')) return { ...DEFAULT_PREFERENCES };
  const saved = record(configuration ? configuration.preferences : read('preferences'));
  return {
    sourceLang: boundedString(saved.sourceLang, 80) || DEFAULT_PREFERENCES.sourceLang,
    targetLang: boundedString(saved.targetLang, 80) || DEFAULT_PREFERENCES.targetLang,
    ocrLang: preferenceOcrLanguage(saved.ocrLang),
    autoTranslate: typeof saved.autoTranslate === 'boolean' ? saved.autoTranslate : DEFAULT_PREFERENCES.autoTranslate,
    activeProviderId: boundedString(saved.activeProviderId, 120) || DEFAULT_PREFERENCES.activeProviderId,
    translationPrompt: normalizePromptTemplate(saved.translationPrompt),
  };
}

export function savePreferences(preferences: Preferences): void {
  const metadata = preferencesMetadata(preferences);
  const configuration = readConfiguration();
  if (unreadableAreas.has('configuration')) throw new Error('无法保存服务配置：原有配置无法读取，原有数据已保留。');
  if (configuration) write('configuration', { ...configuration, preferences: metadata });
  else write('preferences', metadata);
}

function preferencesMetadata(preferences: Preferences): Preferences {
  return {
    sourceLang: boundedString(preferences.sourceLang, 80), targetLang: boundedString(preferences.targetLang, 80),
    ocrLang: preferenceOcrLanguage(preferences.ocrLang), autoTranslate: preferences.autoTranslate === true, activeProviderId: boundedString(preferences.activeProviderId, 120),
    translationPrompt: normalizePromptTemplate(preferences.translationPrompt),
  };
}

interface Configuration { version: 1; providers: Provider[]; preferences: Preferences; }
function readConfiguration(): Configuration | null { return read('configuration') as Configuration | null; }
function providersMetadata(providers: Provider[]): Provider[] {
  if (providers.length > PROVIDER_LIMIT) throw new Error(`最多可保存 ${PROVIDER_LIMIT} 个翻译服务，请先移除不再使用的服务。`);
  return providers.flatMap(value => { const item = providerMetadata(value); return item ? [item] : []; });
}

/** One localStorage write is the commit point for metadata and active selection. */
function commitConfiguration(providers: Provider[], preferences: Preferences): void {
  const configuration = readConfiguration();
  if (!configuration) { read('providers'); read('preferences'); }
  if (unreadableAreas.has('configuration') || !configuration && (unreadableAreas.has('providers') || unreadableAreas.has('preferences'))) throw new Error('原有配置尚未成功读取，未保存更改；原有数据已保留。');
  write('configuration', { version: 1, providers: providersMetadata(providers), preferences: preferencesMetadata(preferences) });
}

export function providerCredentialId(provider: Provider): string | null {
  return provider.kind === 'codex' ? null : provider.credentialId === undefined ? provider.id : provider.credentialId;
}
export async function getProviderApiKey(provider: Provider): Promise<string | null> {
  const id = providerCredentialId(provider);
  return id === null ? null : getApiKey(id);
}

type ConfigurationSource = () => { providers: Provider[]; preferences: Preferences };
interface ConfigurationCommit { providers: Provider[]; preferences: Preferences; cleanup: () => Promise<void>; }
function cleanupCredential(previous: Provider | undefined, providers: Provider[]): () => Promise<void> {
  const id = previous && providerCredentialId(previous);
  return async () => {
    if (id && !providers.some(provider => providerCredentialId(provider) === id)) await deleteApiKey(id);
  };
}

/** Stage a distinct credential; failed metadata commits can never replace the old key. */
export async function saveProviderConfiguration(source: ConfigurationSource, provider: Provider, key: string, removeKey: boolean): Promise<ConfigurationCommit> {
  const initial = source();
  if (!initial.providers.some(item => item.id === provider.id) && initial.providers.length >= PROVIDER_LIMIT) throw new Error(`最多可保存 ${PROVIDER_LIMIT} 个翻译服务，请先移除不再使用的服务。`);
  let stagedId: string | undefined;
  try {
    if (provider.kind !== 'codex' && !removeKey && key.trim()) {
      stagedId = createId();
      await saveApiKey(stagedId, key);
    }
    const current = source();
    const previous = current.providers.find(item => item.id === provider.id);
    const saved: Provider = provider.kind === 'codex'
      ? { id: provider.id, name: provider.name, kind: provider.kind, model: provider.model, baseUrl: '', hasKey: false }
      : { ...provider, ...(stagedId ? { credentialId: stagedId } : removeKey ? { credentialId: null } : { credentialId: previous ? previous.credentialId : provider.credentialId }), hasKey: removeKey ? false : Boolean(stagedId || previous?.hasKey || provider.hasKey) };
    const providers = previous ? current.providers.map(item => item.id === saved.id ? saved : item) : [...current.providers, saved];
    const preferences = { ...current.preferences, activeProviderId: saved.id };
    commitConfiguration(providers, preferences);
    return { providers, preferences, cleanup: cleanupCredential(previous, providers) };
  } catch (error) {
    if (stagedId) {
      try { await deleteApiKey(stagedId); }
      catch { throw new Error('配置未保存，原有服务与密钥已保留；暂存密钥暂时无法清理，请检查系统保险库权限。'); }
    }
    throw error;
  }
}

export async function removeProviderConfiguration(source: ConfigurationSource, provider: Provider): Promise<ConfigurationCommit> {
  const current = source();
  const previous = current.providers.find(item => item.id === provider.id);
  const providers = current.providers.filter(item => item.id !== provider.id);
  const preferences = { ...current.preferences, activeProviderId: providers.some(item => item.id === current.preferences.activeProviderId) ? current.preferences.activeProviderId : providers[0]?.id || '' };
  commitConfiguration(providers, preferences);
  return { providers, preferences, cleanup: cleanupCredential(previous, providers) };
}

function historyMetadata(value: unknown): HistoryItem | null {
  const item = record(value);
  if (typeof item.id !== 'string' || typeof item.source !== 'string' || typeof item.translation !== 'string' || typeof item.createdAt !== 'number' || !Number.isFinite(item.createdAt)) return null;
  // Successful translation transports allow up to 1 MiB of output. Preserve it
  // whole: clipping to a smaller character count makes history look complete.
  if (item.source.length > 60_000 || item.translation.length > 1_048_576) return null;
  if (!['text', 'clipboard', 'image'].includes(String(item.input))) return null;
  return {
    id: boundedString(item.id, 120), source: item.source, translation: item.translation,
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

export function saveHistory(history: HistoryItem[]): HistoryItem[] {
  const retained: HistoryItem[] = [];
  const encoded: string[] = [];
  const encoder = new TextEncoder();
  let bytes = 2; // Array brackets, plus comma separators below.
  for (const value of history.slice(0, HISTORY_LIMIT)) {
    const item = historyMetadata(value);
    if (!item) continue;
    const json = JSON.stringify(item);
    const size = encoder.encode(json).length + (retained.length ? 1 : 0);
    if (bytes + size > HISTORY_BYTE_LIMIT) {
      // Escaping a valid result can exceed the JSON budget. Do not replace old
      // history with an empty list or silently save a shortened translation.
      if (!retained.length) throw new Error('完整译文超过本地记录容量，未保存本次记录；原有数据已保留。');
      break;
    }
    retained.push(item); encoded.push(json); bytes += size;
  }
  let serialized = `[${encoded.join(',')}]`;
  try {
    const adapter = storage();
    if (unreadableAreas.has('history')) throw new Error('原有数据尚未成功读取');
    for (;;) {
      try { adapter.setItem(STORAGE_PREFIX + 'history', serialized); return retained; }
      catch (error) {
        if (!(error instanceof DOMException && error.name === 'QuotaExceededError') || retained.length <= 1) throw error;
        retained.pop(); serialized = JSON.stringify(retained);
      }
    }
  } catch {
    storageProblem('history', 'write');
    throw new Error('无法保存本地翻译记录，原有数据已保留。');
  }
}

export function addHistory(item: HistoryItem): HistoryItem[] {
  const history = [item, ...loadHistory().filter(previous => previous.id !== item.id)].slice(0, HISTORY_LIMIT);
  return saveHistory(history);
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
