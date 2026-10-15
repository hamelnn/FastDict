import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HistoryItem, Provider } from '../../types';
import { addHistory, clearHistory, DEFAULT_PREFERENCES, deleteApiKey, getApiKey, getDefaultProviders, HISTORY_LIMIT, loadHistory, loadPreferences, loadProviders, saveApiKey, saveHistory, savePreferences, saveProviders } from '../storage';

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
  it('recovers from missing or malformed settings without mutating defaults', () => {
    expect(loadPreferences()).toEqual(DEFAULT_PREFERENCES);
    values.set('fastdict.v1.preferences', '{invalid');
    expect(loadPreferences()).toEqual(DEFAULT_PREFERENCES);
    const providers = getDefaultProviders(); providers[0].name = 'changed';
    expect(getDefaultProviders()[0].name).toBe('OpenAI');
  });
  it('persists configuration metadata but strips unexpected key fields', async () => {
    const provider = { ...getDefaultProviders()[0], id: 'session-test', apiKey: 'secret-value', key: 'another-secret' } as Provider;
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
    const provider = { ...getDefaultProviders()[0], hasKey: true };
    values.set('fastdict.v1.providers', JSON.stringify([provider, provider, { ...provider, id: '../../bad' }, { ...provider, id: 'unknown', kind: 'fake' }]));
    expect(loadProviders()).toEqual([{ ...provider, hasKey: false }]);
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
});
