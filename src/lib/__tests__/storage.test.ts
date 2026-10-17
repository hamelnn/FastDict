import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HistoryItem, Provider } from '../../types';
import { acknowledgeChatGPTPlan, addHistory, clearHistory, DEFAULT_PREFERENCES, deleteApiKey, getApiKey, hasAcknowledgedChatGPTPlan, HISTORY_BYTE_LIMIT, HISTORY_LIMIT, loadHistory, loadPreferences, loadProviders, saveApiKey, saveHistory, savePreferences, saveProviders } from '../storage';
import { PROVIDER_PRESETS } from '../catalog';
import { DEFAULT_TRANSLATION_PROMPT, MAX_PROMPT_LENGTH } from '../prompts';

let values: Map<string, string>;
beforeEach(() => {
  values = new Map();
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
});
afterEach(async () => { await deleteApiKey('session-test'); vi.unstubAllGlobals(); });
function history(index: number): HistoryItem {
  return { id: String(index), source: `source ${index}`, translation: `translated ${index}`, sourceLang: 'auto', targetLang: '中文', providerName: 'Test', createdAt: index, durationMs: 123, input: 'text' };
}

describe('local metadata and key storage', () => {
  const providerFixture = (): Provider => ({ ...PROVIDER_PRESETS[0], hasKey: false });
  it('starts with no provider or active service without writing startup defaults', () => {
    expect(loadProviders()).toEqual([]);
    expect(loadPreferences().activeProviderId).toBe('');
    expect(values.size).toBe(0);
    // Templates stay available for explicit user selection, never auto-install.
    expect(PROVIDER_PRESETS.length).toBeGreaterThan(0);
  });
  it('recovers from missing or malformed settings without mutating defaults', () => {
    expect(loadPreferences()).toEqual(DEFAULT_PREFERENCES);
    values.set('fastdict.v1.preferences', '{invalid');
    expect(loadPreferences()).toEqual(DEFAULT_PREFERENCES);
    const preferences = loadPreferences(); preferences.targetLang = 'changed';
    expect(DEFAULT_PREFERENCES.targetLang).toBe('zh-CN');
  });
  it('preserves existing providers, active selection and original bytes after the empty-default upgrade', () => {
    const providers = [providerFixture(), { ...providerFixture(), id: 'custom-existing', name: 'Existing API', baseUrl: 'https://example.org/v1' }];
    const savedProviders = JSON.stringify(providers);
    const savedPreferences = JSON.stringify({ ...DEFAULT_PREFERENCES, activeProviderId: 'custom-existing' });
    values.set('fastdict.v1.providers', savedProviders);
    values.set('fastdict.v1.preferences', savedPreferences);
    expect(loadProviders()).toEqual(providers);
    expect(loadPreferences().activeProviderId).toBe('custom-existing');
    expect(values.get('fastdict.v1.providers')).toBe(savedProviders);
    expect(values.get('fastdict.v1.preferences')).toBe(savedPreferences);
  });
  it('never overwrites unreadable provider data with the empty onboarding state', () => {
    const original = '{broken providers';
    values.set('fastdict.v1.providers', original);
    expect(loadProviders()).toEqual([]);
    expect(() => saveProviders([])).toThrow('原有数据已保留');
    expect(values.get('fastdict.v1.providers')).toBe(original);
  });
  it('persists configuration metadata but strips unexpected key fields', async () => {
    const provider = { ...providerFixture(), id: 'session-test', apiKey: 'secret-value', key: 'another-secret' } as Provider;
    await saveApiKey(provider.id, 'secret-value');
    saveProviders([provider]);
    const stored = [...values.values()].join('');
    expect(stored).not.toContain('secret-value'); expect(stored).not.toContain('another-secret'); expect(stored).not.toContain('apiKey');
    expect(loadProviders()[0].hasKey).toBe(true);
    expect(await getApiKey(provider.id)).toBe('secret-value');
    await deleteApiKey(provider.id);
    expect(await getApiKey(provider.id)).toBeNull(); expect(loadProviders()[0].hasKey).toBe(false);
  });
  it('does not trust a persisted hasKey flag in the browser or duplicate/invalid provider IDs', () => {
    const provider = { ...providerFixture(), hasKey: true };
    values.set('fastdict.v1.providers', JSON.stringify([provider, provider, { ...provider, id: '../../bad' }, { ...provider, id: 'unknown', kind: 'fake' }]));
    expect(loadProviders()).toEqual([{ ...provider, hasKey: false }]);
  });
  it('loads Codex metadata without an endpoint and discards credential and address fields on save', async () => {
    const original = { id: 'session-test', name: 'My Codex', kind: 'codex', model: 'gpt-6-luna', hasKey: true, apiKey: 'must-not-persist', authToken: 'must-not-persist' };
    values.set('fastdict.v1.providers', JSON.stringify([original]));
    // Even an unrelated in-memory key under the same ID cannot make Codex keyed.
    await saveApiKey(original.id, 'unrelated-session-key');
    expect(loadProviders()).toEqual([{ id: original.id, name: original.name, kind: 'codex', model: original.model, baseUrl: '', hasKey: false }]);
    saveProviders([{ ...loadProviders()[0], baseUrl: 'https://ignored.example', hasKey: true }]);
    expect(JSON.parse(values.get('fastdict.v1.providers')!)).toEqual(loadProviders());
    expect(values.get('fastdict.v1.providers')).not.toContain('ignored.example');
    expect(values.get('fastdict.v1.providers')).not.toContain('must-not-persist');
    expect(values.get('fastdict.v1.providers')).not.toContain('authToken');
  });
  it('migrates only the old default subscription label and preserves identifiers, history and user names', () => {
    const oldDefault = { id: 'existing-subscription', name: '本机 Codex（GPT 订阅）', kind: 'codex', model: 'gpt-6-luna', baseUrl: '', hasKey: false };
    const custom = { ...oldDefault, id: 'custom-subscription', name: 'My Codex' };
    const original = JSON.stringify([oldDefault, custom]);
    values.set('fastdict.v1.providers', original);
    saveHistory([{ ...history(1), providerName: oldDefault.name }]);
    expect(loadProviders()).toEqual([{ ...oldDefault, name: 'ChatGPT 订阅' }, custom]);
    expect(values.get('fastdict.v1.providers')).toBe(original);
    expect(loadHistory()[0].providerName).toBe(oldDefault.name);
  });
  it('persists only the first-plan-use acknowledgement and no identity or tokens', () => {
    expect(hasAcknowledgedChatGPTPlan()).toBe(false);
    acknowledgeChatGPTPlan();
    expect(hasAcknowledgedChatGPTPlan()).toBe(true);
    expect([...values.entries()]).toEqual([['fastdict.v1.chatgptPlanNotice', 'acknowledged']]);
  });
  it('preserves an intentionally empty provider list', () => {
    saveProviders([]);
    expect(loadProviders()).toEqual([]);
  });
  it('stores preferences through known fields and restores optional defaults', () => {
    savePreferences({ ...DEFAULT_PREFERENCES, autoTranslate: false, targetLang: 'English' });
    expect(loadPreferences()).toMatchObject({ autoTranslate: false, targetLang: 'English' });
    values.set('fastdict.v1.preferences', JSON.stringify({ ocrLang: '../../bad', autoTranslate: 'yes' }));
    expect(loadPreferences()).toEqual(DEFAULT_PREFERENCES);
  });
  it('preserves OCR choices from the UI and normalizes legacy language ordering', () => {
    for (const language of ['eng+chi_sim', 'eng+chi_tra', 'eng+jpn', 'eng+kor']) {
      savePreferences({ ...DEFAULT_PREFERENCES, ocrLang: language });
      expect(loadPreferences().ocrLang).toBe(language);
    }
    values.set('fastdict.v1.preferences', JSON.stringify({ ocrLang: 'chi_sim+eng' }));
    expect(loadPreferences().ocrLang).toBe('eng+chi_sim');
  });
  it('loads the default prompt for old preferences without writing migration defaults', () => {
    const original = JSON.stringify({ autoTranslate: false, activeProviderId: 'existing' });
    values.set('fastdict.v1.preferences', original);
    expect(loadPreferences().translationPrompt).toBe(DEFAULT_TRANSLATION_PROMPT);
    expect(values.get('fastdict.v1.preferences')).toBe(original);
  });
  it('persists the custom prompt and restores the default without affecting other choices', () => {
    const custom = 'Translate into {{targetLang}} using concise technical terminology.';
    savePreferences({ ...DEFAULT_PREFERENCES, translationPrompt: custom, targetLang: 'ja', autoTranslate: false });
    expect(loadPreferences()).toMatchObject({ translationPrompt: custom, targetLang: 'ja', autoTranslate: false });
    savePreferences({ ...loadPreferences(), translationPrompt: DEFAULT_TRANSLATION_PROMPT });
    expect(loadPreferences()).toMatchObject({ translationPrompt: DEFAULT_TRANSLATION_PROMPT, targetLang: 'ja', autoTranslate: false });
  });
  it('falls back from invalid stored prompts without truncating or rewriting the original bytes', () => {
    for (const translationPrompt of [null, 123, '', 'No target language variable', '{{unknown}} {{targetLang}}', 'x'.repeat(MAX_PROMPT_LENGTH) + '{{targetLang}}']) {
      const original = JSON.stringify({ translationPrompt });
      values.set('fastdict.v1.preferences', original);
      expect(loadPreferences().translationPrompt).toBe(DEFAULT_TRANSLATION_PROMPT);
      expect(values.get('fastdict.v1.preferences')).toBe(original);
    }
  });
  it('bounds history, deduplicates IDs and clears records', () => {
    saveHistory(Array.from({ length: HISTORY_LIMIT + 10 }, (_, index) => history(index)));
    expect(loadHistory()).toHaveLength(HISTORY_LIMIT);
    expect(addHistory({ ...history(1), translation: 'replacement' })).toHaveLength(HISTORY_LIMIT);
    expect(loadHistory()[0].translation).toBe('replacement');
    expect(loadHistory().filter(item => item.id === '1')).toHaveLength(1);
    clearHistory(); expect(loadHistory()).toEqual([]);
  });
  it('filters malformed history and surfaces unavailable storage', () => {
    values.set('fastdict.v1.history', JSON.stringify([history(1), { createdAt: 'fake' }, { ...history(2), input: 'other' }]));
    expect(loadHistory()).toEqual([history(1)]);
    vi.stubGlobal('localStorage', { setItem: () => { throw new Error('quota'); } });
    expect(() => saveProviders([])).toThrow('无法保存');
  });
  it('keeps the newest history within the total UTF-8 byte budget', () => {
    const items = Array.from({ length: 30 }, (_, index) => ({ ...history(index), source: '汉'.repeat(60_000), translation: '译'.repeat(100_000) }));
    const retained = saveHistory(items);
    expect(retained.length).toBeLessThan(items.length);
    expect(retained[0].id).toBe(items[0].id);
    expect(new TextEncoder().encode(values.get('fastdict.v1.history')!).length).toBeLessThanOrEqual(HISTORY_BYTE_LIMIT);
    expect(loadHistory()).toEqual(retained);
  });
  it('restores long successful translations in full, including a surrogate pair at the old truncation boundary', () => {
    const translation = `${'x'.repeat(99_999)}\u{1F30F}${'后续译文'.repeat(30_000)}`;
    const item = { ...history(1), translation };
    expect(saveHistory([item])).toEqual([item]);
    expect(loadHistory()[0].translation).toBe(translation);
  });
  it('preserves previous bytes when one complete translation exceeds the serialized history budget', () => {
    saveHistory([history(1)]);
    const before = values.get('fastdict.v1.history');
    const item = { ...history(2), translation: '\u0001'.repeat(400_000) };
    expect(new TextEncoder().encode(item.translation).length).toBeLessThan(1_048_576);
    expect(() => addHistory(item)).toThrow('完整译文超过');
    expect(values.get('fastdict.v1.history')).toBe(before);
    expect(loadHistory()).toEqual([history(1)]);
  });
  it('recovers quota by evicting only the oldest records and returns the persisted list', () => {
    saveHistory([history(2), history(1)]);
    const originalSet = localStorage.setItem;
    const quota = JSON.stringify([history(3), history(2)]).length;
    localStorage.setItem = (key: string, value: string) => {
      if (value.length > quota) throw new DOMException('Quota reached', 'QuotaExceededError');
      originalSet(key, value);
    };
    const retained = addHistory(history(3));
    expect(retained.map(item => item.id)).toEqual(['3', '2']);
    expect(loadHistory()).toEqual(retained);
  });
  it('does not erase old records when even the newest record cannot be saved', () => {
    saveHistory([history(1)]);
    const before = values.get('fastdict.v1.history');
    localStorage.setItem = () => { throw new DOMException('Quota reached', 'QuotaExceededError'); };
    expect(() => addHistory(history(2))).toThrow('原有数据已保留');
    expect(values.get('fastdict.v1.history')).toBe(before);
  });
});
