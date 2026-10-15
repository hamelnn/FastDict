import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranslationRequest } from '../../types';

const native = vi.hoisted(() => ({
  invoke: vi.fn(), desktop: true, mobile: false,
  channels: [] as { onmessage: (event: unknown) => void }[],
}));
vi.mock('../platform', () => ({ get isNative() { return native.desktop; }, get isMobile() { return native.mobile; } }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: native.invoke,
  Channel: class {
    onmessage: (event: unknown) => void = () => undefined;
    constructor() { native.channels.push(this); }
  },
}));
import { getCodexStatus, translateWithCodex } from '../codex';
import { buildTranslationRequest, translate } from '../translation';

function request(overrides: Partial<TranslationRequest> = {}): TranslationRequest {
  return {
    provider: { id: 'codex-local', name: 'Codex', kind: 'codex', model: 'gpt-6-luna', baseUrl: '', hasKey: false },
    apiKey: '', text: 'Hello', sourceLang: 'auto', targetLang: '简体中文',
    signal: new AbortController().signal, onDelta: vi.fn(), ...overrides,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
beforeEach(() => { native.invoke.mockReset(); native.channels.length = 0; native.desktop = true; native.mobile = false; });
afterEach(() => vi.unstubAllGlobals());

describe('Codex subscription bridge', () => {
  it('checks the selected model without handling credentials or starting translation', async () => {
    const status = { available: true, authenticated: true, authMode: 'chatgpt', version: 'test', modelAvailable: true };
    native.invoke.mockResolvedValue(status);
    expect(await getCodexStatus()).toEqual(status);
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith('get_codex_status', { model: 'gpt-6-luna' });
    await getCodexStatus('custom-model');
    expect(native.invoke).toHaveBeenLastCalledWith('get_codex_status', { model: 'custom-model' });
  });
  it('streams the first delta before completion and never sends a key or HTTP address', async () => {
    const done = deferred<string>();
    native.invoke.mockReturnValue(done.promise);
    const onDelta = vi.fn();
    const pending = translateWithCodex(request({ onDelta, apiKey: 'unused-do-not-send' }));
    await vi.waitFor(() => expect(native.channels).toHaveLength(1));
    native.channels[0].onmessage({ type: 'delta', text: '你好' });
    expect(onDelta).toHaveBeenCalledExactlyOnceWith('你好');
    const [command, args] = native.invoke.mock.calls[0];
    expect(command).toBe('translate_with_codex');
    expect(args).toMatchObject({ model: 'gpt-6-luna', text: 'Hello', sourceLang: 'auto', targetLang: '简体中文' });
    expect(args).not.toHaveProperty('apiKey'); expect(args).not.toHaveProperty('baseUrl');
    done.resolve('你好');
    expect(await pending).toBe('你好');
    native.channels[0].onmessage({ type: 'delta', text: 'late' });
    expect(onDelta).toHaveBeenCalledTimes(1);
  });
  it('cancels an idle native request immediately and ignores late deltas', async () => {
    const done = deferred<string>();
    native.invoke.mockImplementation(command => command === 'translate_with_codex' ? done.promise : Promise.resolve());
    const controller = new AbortController(), onDelta = vi.fn();
    const pending = translateWithCodex(request({ signal: controller.signal, onDelta }));
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(native.invoke).toHaveBeenCalled());
    const requestId = native.invoke.mock.calls[0][1].requestId;
    controller.abort(); await rejected;
    expect(native.invoke).toHaveBeenLastCalledWith('cancel_codex_translation', { requestId });
    native.channels[0].onmessage({ type: 'delta', text: 'late' });
    done.resolve('late'); await done.promise;
    expect(onDelta).not.toHaveBeenCalled();
  });
  it('rejects cancelled or invalid input before invoking native code', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(translateWithCodex(request({ signal: controller.signal }))).rejects.toMatchObject({ name: 'AbortError' });
    await expect(translateWithCodex(request({ text: ' ' }))).rejects.toThrow('文本');
    await expect(translateWithCodex(request({ text: 'x'.repeat(60_001) }))).rejects.toThrow('过长');
    await expect(translateWithCodex(request({ provider: { ...request().provider, model: '--bad model' } }))).rejects.toThrow('模型名称');
    expect(native.invoke).not.toHaveBeenCalled();
  });
  it('keeps a late native failure handled after the caller has cancelled', async () => {
    const done = deferred<string>();
    native.invoke.mockImplementation(command => command === 'translate_with_codex' ? done.promise : Promise.resolve());
    const controller = new AbortController();
    const pending = translateWithCodex(request({ signal: controller.signal }));
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(native.invoke).toHaveBeenCalled());
    controller.abort(); await rejected;
    done.reject(new Error('Codex interrupted'));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(native.invoke.mock.calls.filter(([command]) => command === 'cancel_codex_translation')).toHaveLength(1);
  });
  it('keeps the service unavailable on browser and mobile', async () => {
    for (const [desktop, mobile] of [[false, false], [true, true]]) {
      native.desktop = desktop; native.mobile = mobile;
      expect(await getCodexStatus()).toMatchObject({ available: false, authenticated: false, authMode: 'none' });
      await expect(translateWithCodex(request())).rejects.toThrow('仅支持桌面');
    }
    expect(native.invoke).not.toHaveBeenCalled();
  });
  it('routes Codex outside HTTP and rejects empty native output', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    native.invoke.mockResolvedValue('你好');
    expect(await translate(request())).toBe('你好');
    expect(fetch).not.toHaveBeenCalled();
    expect(() => buildTranslationRequest(request())).toThrow('不使用 API');
    native.invoke.mockResolvedValue(' ');
    await expect(translateWithCodex(request())).rejects.toThrow('没有返回译文');
  });
});
