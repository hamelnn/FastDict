import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderKind, TranslationRequest } from '../../types';
import { API_LIMITS, translate } from '../translation';

function request(kind: ProviderKind = 'openai', overrides: Partial<TranslationRequest> = {}): TranslationRequest {
  return { provider: { id: 'synthetic', name: 'Synthetic', kind, baseUrl: 'https://test.example/v1', model: 'test', hasKey: true }, apiKey: 'synthetic-key', text: 'hello', sourceLang: 'auto', targetLang: 'zh', signal: new AbortController().signal, onDelta: vi.fn(), ...overrides };
}
function payload(kind: ProviderKind, reason?: unknown, text = '') {
  return kind === 'gemini' ? { candidates: [{ content: { parts: [{ text }] }, finishReason: reason }] }
    : kind === 'anthropic' ? { type: 'message_delta', delta: { type: 'text_delta', text, stop_reason: reason }, content: [{ text }], stop_reason: reason }
    : { choices: [{ delta: { content: text }, message: { content: text }, finish_reason: reason }] };
}
function sse(packets: unknown[]): Response {
  return new Response(packets.map(packet => `data: ${JSON.stringify(packet)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('provider completion allowlists', () => {
  it.each([
    ['openai', 'stop'], ['gemini', 'STOP'], ['anthropic', 'end_turn'], ['anthropic', 'stop_sequence'],
  ] as const)('accepts only the supported %s success %s in JSON and SSE', async (kind, reason) => {
    for (const response of [Response.json(payload(kind, reason, '你好')), sse([payload(kind, undefined, '你'), payload(kind, reason, '好')])]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
      expect(await translate(request(kind))).toBe('你好');
    }
  });
  it.each([
    ['openai', 'length'], ['openai', 'content_filter'], ['openai', 'tool_calls'], ['openai', 'function_call'], ['openai', 'new_reason'],
    ['gemini', 'CONTINUATION'], ['gemini', 'OTHER'], ['gemini', 'LANGUAGE'], ['gemini', 'SPII'], ['gemini', 'MALFORMED_RESPONSE'], ['gemini', 'UNEXPECTED_TOOL_CALL'], ['gemini', 'MAX_TOKENS'], ['gemini', 'new_reason'],
    ['anthropic', 'max_tokens'], ['anthropic', 'tool_use'], ['anthropic', 'pause_turn'], ['anthropic', 'refusal'], ['anthropic', 'model_context_window_exceeded'], ['anthropic', 'new_reason'],
  ] as const)('rejects %s termination %s with and without partial text in SSE and JSON', async (kind, reason) => {
    for (const partial of ['', 'partial']) {
      for (const response of [Response.json(payload(kind, reason, partial)), sse([payload(kind, undefined, partial), payload(kind, reason)])]) {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
        await expect(translate(request(kind))).rejects.toThrow();
      }
    }
  });
  it.each(['openai', 'gemini', 'anthropic'] as const)('does not infer %s success from a missing/invalid JSON terminal', async kind => {
    for (const reason of [undefined, null, '', 42, {}, []]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(payload(kind, reason, 'partial'))));
      await expect(translate(request(kind))).rejects.toThrow();
    }
  });
  it('treats DONE and message_stop as framing rather than successful translation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\ndata: [DONE]\n\n')));
    await expect(translate(request())).rejects.toThrow('未确认');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sse([payload('anthropic', undefined, 'partial'), { type: 'message_stop' }])));
    await expect(translate(request('anthropic'))).rejects.toThrow('未确认');
  });
  it('rejects tool content even if a server also supplies a normal finish reason', async () => {
    const fixtures: [ProviderKind, unknown][] = [
      ['openai', { choices: [{ delta: { content: 'partial', tool_calls: [{ id: 'tool' }] }, finish_reason: 'stop' }] }],
      ['anthropic', { type: 'content_block_start', content_block: { type: 'tool_use' }, delta: { stop_reason: 'end_turn' } }],
      ['gemini', { candidates: [{ content: { parts: [{ text: 'partial' }, { functionCall: { name: 'tool' } }] }, finishReason: 'STOP' }] }],
    ];
    for (const [kind, body] of fixtures) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sse([body])));
      await expect(translate(request(kind))).rejects.toThrow('工具');
    }
  });
});

describe('whole API lifetime and byte budgets', () => {
  it('times out connection even when fetch ignores abort and cancels a late body', async () => {
    vi.useFakeTimers();
    let resolve!: (response: Response) => void;
    let transportSignal!: AbortSignal;
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => { transportSignal = init.signal as AbortSignal; return new Promise<Response>(done => { resolve = done; }); }));
    const pending = translate(request()); const check = expect(pending).rejects.toThrow('响应');
    await vi.advanceTimersByTimeAsync(API_LIMITS.connectMs);
    await check; expect(transportSignal.aborted).toBe(true);
    const cancel = vi.fn(); resolve(new Response(new ReadableStream({ cancel })));
    await Promise.resolve(); await Promise.resolve();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it('times out an idle reader without waiting for its cancel promise', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel }))));
    const pending = translate(request()); const check = expect(pending).rejects.toThrow('响应');
    await vi.advanceTimersByTimeAsync(API_LIMITS.idleMs + 1); await check;
    expect(cancel).toHaveBeenCalled();
  });
  it('enforces a total deadline even when heartbeats keep the idle deadline alive', async () => {
    vi.useFakeTimers();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({ start(value) { controller = value; }, cancel }))));
    const pending = translate(request()); const check = expect(pending).rejects.toThrow('超时');
    await vi.advanceTimersByTimeAsync(1);
    for (let elapsed = 0; elapsed < 110_000; elapsed += 10_000) {
      controller.enqueue(new TextEncoder().encode(': heartbeat\n\n'));
      await vi.advanceTimersByTimeAsync(10_000);
    }
    await vi.advanceTimersByTimeAsync(10_000); await check;
    expect(cancel).toHaveBeenCalled();
  });
  it('manual cancellation wins at the deadline boundary and closes the transport', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel }))));
    const controller = new AbortController();
    const pending = translate(request('openai', { signal: controller.signal }));
    const check = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(API_LIMITS.idleMs - 1);
    controller.abort(); await vi.advanceTimersByTimeAsync(1); await check;
    expect(cancel).toHaveBeenCalled();
  });
  it('handles a transport that synchronously cancels the user request and rejects', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn(() => { controller.abort(); return Promise.reject(new Error('transport was cancelled')); }));
    await expect(translate(request('openai', { signal: controller.signal }))).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
  });
  it.each(['json', 'error', 'heartbeat', 'output'] as const)('bounds cumulative %s bytes and closes the reader', async type => {
    const cancel = vi.fn();
    const encoder = new TextEncoder();
    const chunk = encoder.encode(type === 'heartbeat' ? `: ${'h'.repeat(65_000)}\n\n` : type === 'output' ? `data: ${JSON.stringify(payload('openai', undefined, '译'.repeat(16_384)))}\n\n` : ' '.repeat(65_536));
    let reads = 0;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({ pull(controller) { reads++; controller.enqueue(chunk); }, cancel }), {
      status: type === 'error' ? 500 : 200, headers: { 'Content-Type': type === 'json' || type === 'error' ? 'application/json' : 'text/event-stream' },
    })));
    await expect(translate(request())).rejects.toThrow(type === 'output' ? '结果过长' : '数据过大');
    expect(cancel).toHaveBeenCalled();
    expect(reads).toBeLessThan(150);
  });
});
