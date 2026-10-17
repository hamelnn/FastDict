import { afterEach, describe, expect, it, vi } from 'vitest';
import { createId } from '../id';

afterEach(() => vi.unstubAllGlobals());
describe('UUID compatibility', () => {
  it('uses native UUID generation when supported', () => {
    const randomUUID = vi.fn(() => 'native-id');
    vi.stubGlobal('crypto', { randomUUID });
    expect(createId()).toBe('native-id');
    expect(randomUUID).toHaveBeenCalledOnce();
  });
  it('generates RFC 4122 version 4 IDs without randomUUID on older WebKit', () => {
    const secureCrypto = globalThis.crypto;
    vi.stubGlobal('crypto', { getRandomValues: secureCrypto.getRandomValues.bind(secureCrypto) });
    const ids = Array.from({ length: 1000 }, createId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it('fails rather than falling back to insecure randomness if the CSPRNG is unavailable', () => {
    vi.stubGlobal('crypto', {});
    expect(createId).toThrow();
  });
});
