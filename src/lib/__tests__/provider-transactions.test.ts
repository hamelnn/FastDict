import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Provider } from '../../types';
const { invoke, vault } = vi.hoisted(() => ({ invoke: vi.fn(), vault: new Map<string, string>() }));
vi.mock('../platform', () => ({ isNative: true }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
import { DEFAULT_PREFERENCES, getProviderApiKey, loadPreferences, loadProviders, PROVIDER_LIMIT, removeProviderConfiguration, savePreferences, saveProviderConfiguration } from '../storage';

const original: Provider = { id: 'existing', name: 'Original', kind: 'openai', model: 'test', baseUrl: 'https://old.example/v1', hasKey: true };
let values: Map<string, string>;
let failMetadata: boolean;
const snapshot = () => ({ providers: loadProviders(), preferences: loadPreferences() });
beforeEach(() => {
  failMetadata = false;
  values = new Map([
    ['fastdict.v1.providers', JSON.stringify([original])],
    ['fastdict.v1.preferences', JSON.stringify({ ...DEFAULT_PREFERENCES, activeProviderId: original.id })],
  ]);
  vault.clear(); vault.set(original.id, 'old-key');
  invoke.mockReset().mockImplementation(async (command, args) => {
    if (command === 'get_api_key') return vault.get(args.providerId) ?? null;
    if (command === 'save_api_key') { vault.set(args.providerId, args.apiKey); return; }
    if (command === 'delete_api_key') { vault.delete(args.providerId); return; }
    throw new Error('Unexpected vault command');
  });
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (failMetadata) throw new DOMException('Synthetic quota failure', 'QuotaExceededError');
      values.set(key, value);
    },
    removeItem: (key: string) => values.delete(key),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('provider metadata and versioned credentials', () => {
  for (const action of ['add', 'replace', 'remove-key', 'remove-provider'] as const) {
    it(`preserves the old endpoint/key and active selection when ${action} metadata fails`, async () => {
      failMetadata = true;
      const provider = { ...original, id: action === 'add' ? 'new-provider' : original.id, baseUrl: 'https://new.example/v1' };
      const operation = action === 'remove-provider'
        ? removeProviderConfiguration(snapshot, original)
        : saveProviderConfiguration(snapshot, provider, action === 'add' || action === 'replace' ? 'new-key' : '', action === 'remove-key');
      await expect(operation).rejects.toThrow('原有数据已保留');
      // Load from persistence again: no reliance on an in-memory rollback.
      expect(loadProviders()).toEqual([original]);
      expect(loadPreferences().activeProviderId).toBe(original.id);
      expect(await getProviderApiKey(loadProviders()[0])).toBe('old-key');
      expect([...vault.entries()]).toEqual([[original.id, 'old-key']]);
      expect(values.has('fastdict.v1.configuration')).toBe(false);
    });
  }
  it('does not modify metadata or the original key when staging the new key fails', async () => {
    invoke.mockImplementationOnce(async () => { throw new Error('Vault unavailable'); });
    await expect(saveProviderConfiguration(snapshot, { ...original, baseUrl: 'https://new.example' }, 'new-key', false)).rejects.toThrow('Vault unavailable');
    expect(loadProviders()).toEqual([original]);
    expect(vault.get(original.id)).toBe('old-key');
  });
  it('commits endpoint/key reference and active selection in a single snapshot before cleaning the old key', async () => {
    const committed = await saveProviderConfiguration(snapshot, { ...original, baseUrl: 'https://new.example/v1' }, 'new-key', false);
    const loaded = loadProviders()[0];
    expect(loaded.baseUrl).toBe('https://new.example/v1');
    expect(loaded.credentialId).not.toBe(original.id);
    expect(await getProviderApiKey(loaded)).toBe('new-key');
    expect(vault.get(original.id)).toBe('old-key');
    expect(loadPreferences().activeProviderId).toBe(loaded.id);
    await committed.cleanup();
    expect(vault.has(original.id)).toBe(false);
    expect([...values.values()].join('')).not.toContain('new-key');
    expect([...values.values()].join('')).not.toContain('old-key');
  });
  it('continues using the new reference if obsolete credential cleanup fails', async () => {
    const committed = await saveProviderConfiguration(snapshot, { ...original, baseUrl: 'https://new.example' }, 'new-key', false);
    invoke.mockImplementationOnce(async () => { throw new Error('Deletion denied'); });
    await expect(committed.cleanup()).rejects.toThrow('Deletion denied');
    expect(await getProviderApiKey(loadProviders()[0])).toBe('new-key');
    expect(vault.get(original.id)).toBe('old-key');
  });
  it('keeps an explicit removed-key reference empty even if obsolete key cleanup fails', async () => {
    const committed = await saveProviderConfiguration(snapshot, original, '', true);
    invoke.mockImplementationOnce(async () => { throw new Error('Deletion denied'); });
    await expect(committed.cleanup()).rejects.toThrow();
    expect(loadProviders()[0]).toMatchObject({ hasKey: false, credentialId: null });
    expect(await getProviderApiKey(loadProviders()[0])).toBeNull();
    await saveProviderConfiguration(snapshot, loadProviders()[0], '', false);
    expect(await getProviderApiKey(loadProviders()[0])).toBeNull();
  });
  it('removes a provider before deleting its key and permits re-adding after removal', async () => {
    const removed = await removeProviderConfiguration(snapshot, original);
    expect(loadProviders()).toEqual([]);
    expect(loadPreferences().activeProviderId).toBe('');
    await removed.cleanup();
    expect(vault.size).toBe(0);
    await saveProviderConfiguration(snapshot, original, 'replacement-key', false);
    expect(await getProviderApiKey(loadProviders()[0])).toBe('replacement-key');
  });
  it('rejects the 31st service before writing a credential', async () => {
    values.set('fastdict.v1.providers', JSON.stringify(Array.from({ length: PROVIDER_LIMIT }, (_, index) => ({ ...original, id: `provider-${index}` }))));
    await expect(saveProviderConfiguration(snapshot, { ...original, id: 'over-limit' }, 'unused-key', false)).rejects.toThrow('最多可保存 30');
    expect(invoke).not.toHaveBeenCalled();
    expect(loadProviders()).toHaveLength(PROVIDER_LIMIT);
  });
  it('retains current preferences changed while a credential write was pending', async () => {
    let release!: () => void;
    invoke.mockImplementationOnce(async (_command, args) => {
      await new Promise<void>(resolve => { release = resolve; });
      vault.set(args.providerId, args.apiKey);
    });
    const saving = saveProviderConfiguration(snapshot, original, 'new-key', false);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    savePreferences({ ...loadPreferences(), autoTranslate: false, targetLang: 'ja' });
    release(); await saving;
    expect(loadPreferences()).toMatchObject({ autoTranslate: false, targetLang: 'ja', activeProviderId: original.id });
  });
  it('preserves the previous atomic snapshot if a later selection/metadata write fails', async () => {
    await saveProviderConfiguration(snapshot, original, 'new-key', false);
    const before = values.get('fastdict.v1.configuration');
    failMetadata = true;
    expect(() => savePreferences({ ...loadPreferences(), activeProviderId: 'unknown' })).toThrow();
    await expect(saveProviderConfiguration(snapshot, { ...original, id: 'second' }, 'second-key', false)).rejects.toThrow();
    expect(values.get('fastdict.v1.configuration')).toBe(before);
    expect(loadPreferences().activeProviderId).toBe(original.id);
    expect(await getProviderApiKey(loadProviders()[0])).toBe('new-key');
  });
  it('never overwrites corrupt new-format bytes by falling back to legacy data', async () => {
    values.set('fastdict.v1.configuration', '{broken');
    await expect(saveProviderConfiguration(snapshot, original, 'new-key', false)).rejects.toThrow('原有数据已保留');
    expect(values.get('fastdict.v1.configuration')).toBe('{broken');
    expect([...vault.entries()]).toEqual([[original.id, 'old-key']]);
  });
});
