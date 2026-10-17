import type { Provider, ProviderKind, TranslationRequest } from '../types';
import { isNative } from './platform';
import { renderTranslationPrompt } from './prompts';

type JsonObject = Record<string, unknown>;
export interface SseEvent { event: string; data: string; }

/** Scan each network fragment once; incomplete lines are joined only at a delimiter. */
export class SseParser {
  private lineParts: string[] = [];
  private lineSize = 0;
  private pendingCr = false;
  private eventName = '';
  private data: string[] = [];
  private firstLine = true;
  private eventSize = 0;

  constructor(private readonly onEvent: (event: SseEvent) => void) {}

  feed(chunk: string): void {
    if (!chunk) return;
    let start = this.pendingCr && chunk[0] === '\n' ? 1 : 0;
    this.pendingCr = false;
    for (let i = start; i < chunk.length; i++) {
      const char = chunk[i];
      if (char !== '\r' && char !== '\n') continue;
      this.lineFragment(chunk.slice(start, i), true);
      if (char === '\r') {
        if (chunk[i + 1] === '\n') i++;
        else if (i === chunk.length - 1) this.pendingCr = true;
      }
      start = i + 1;
    }
    this.lineFragment(chunk.slice(start), false);
  }

  finish(): void {
    if (this.lineSize) this.lineFragment('', true);
    this.pendingCr = false;
    this.dispatch();
  }

  private lineFragment(fragment: string, complete: boolean): void {
    this.lineSize += fragment.length;
    if (this.lineSize + this.eventSize > 4_194_304) throw new Error('API 返回的数据过大。');
    if (fragment) this.lineParts.push(fragment);
    if (!complete) return;
    const line = this.lineParts.join('');
    this.lineParts = [];
    this.lineSize = 0;
    this.line(line);
  }

  private line(line: string): void {
    if (this.firstLine) { line = line.replace(/^\uFEFF/, ''); this.firstLine = false; }
    if (!line) { this.dispatch(); return; }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.eventName = value;
    if (field === 'data') { this.data.push(value); this.eventSize += value.length; }
    if (this.eventSize > 4_194_304) throw new Error('API 返回的数据过大。');
  }

  private dispatch(): void {
    if (this.data.length) this.onEvent({ event: this.eventName || 'message', data: this.data.join('\n') });
    this.eventName = '';
    this.data = [];
    this.eventSize = 0;
  }
}

export function validateEndpoint(baseUrl: string): URL {
  let url: URL;
  try { url = new URL(baseUrl.trim()); } catch { throw new Error('请输入完整的 API 地址，例如 https://api.openai.com/v1。'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('API 地址必须使用 HTTPS；本机 localhost 服务可以使用 HTTP。');
  if (url.username || url.password || url.search || url.hash) throw new Error('API 地址不能包含账号、密码、查询参数或片段；API Key 请单独填写。');
  return url;
}

/** Only local OpenAI-compatible servers may omit an API key. */
export function isKeylessProvider(provider: Pick<Provider, 'kind' | 'baseUrl'>): boolean {
  if (provider.kind !== 'openai') return false;
  try {
    const url = validateEndpoint(provider.baseUrl);
    return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function providerEndpoint(provider: Pick<Provider, 'kind' | 'baseUrl' | 'model'>): string {
  if (provider.kind === 'codex') throw new Error('ChatGPT 订阅通过官方授权连接，不使用 API 地址或密钥配置。');
  const url = validateEndpoint(provider.baseUrl);
  let path = url.pathname.replace(/\/+$/, '');
  if (provider.kind === 'openai') {
    if (!path) path = '/v1';
    if (!path.endsWith('/chat/completions')) path += '/chat/completions';
  } else if (provider.kind === 'anthropic') {
    if (!path) path = '/v1';
    if (!path.endsWith('/messages')) path += path.endsWith('/v1') ? '/messages' : '/v1/messages';
  } else {
    if (!path) path = '/v1beta';
    const model = provider.model.replace(/^models\//, '');
    if (!/^[a-zA-Z0-9._-]+$/.test(model)) throw new Error('Gemini 模型名称格式不正确。');
    path = path.replace(/\/models\/[^/]+(?::(?:stream)?GenerateContent)?$/, '');
    path += `/models/${encodeURIComponent(model)}:streamGenerateContent`;
    url.searchParams.set('alt', 'sse');
  }
  url.pathname = path;
  return url.toString();
}

export function buildTranslationRequest(request: TranslationRequest): { url: string; init: RequestInit } {
  const { provider, apiKey, text, sourceLang, targetLang, signal } = request;
  const url = providerEndpoint(provider);
  if (!apiKey.trim() && !isKeylessProvider(provider)) throw new Error('请先为当前服务配置 API Key。');
  if (!provider.model.trim()) throw new Error('请填写模型名称。');
  if (!text.trim()) throw new Error('请输入需要翻译的文本。');
  if (!targetLang.trim()) throw new Error('请选择目标语言。');
  if (text.length > 60_000) throw new Error('文本过长，请分段翻译（每次最多 60,000 个字符）。');
  const system = renderTranslationPrompt(request.promptTemplate, sourceLang, targetLang);
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
  let body: JsonObject;
  if (provider.kind === 'anthropic') {
    headers['x-api-key'] = apiKey.trim();
    headers['anthropic-version'] = '2023-06-01';
    if (!isNative) headers['anthropic-dangerous-direct-browser-access'] = 'true';
    body = { model: provider.model.trim(), system, messages: [{ role: 'user', content: text }], stream: true, max_tokens: 8192, temperature: 0.2 };
  } else if (provider.kind === 'gemini') {
    headers['x-goog-api-key'] = apiKey.trim();
    body = { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text }] }], generationConfig: { temperature: 0.2, maxOutputTokens: 8192 } };
  } else {
    if (apiKey.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`;
    body = { model: provider.model.trim(), messages: [{ role: 'system', content: system }, { role: 'user', content: text }], stream: true, temperature: 0.2 };
  }
  // Redirects could forward custom key headers to a different server.
  return { url, init: { method: 'POST', headers, body: JSON.stringify(body), signal, redirect: 'error', cache: 'no-store' } };
}

function object(value: unknown): JsonObject { return value !== null && typeof value === 'object' ? value as JsonObject : {}; }
function string(value: unknown): string { return typeof value === 'string' ? value : ''; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }

export function redactError(message: string, apiKey: string): string {
  let safe = message;
  for (const key of new Set([apiKey, apiKey.trim(), encodeURIComponent(apiKey.trim())])) if (key) safe = safe.split(key).join('[已隐藏]');
  return safe.replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, '[已隐藏]').replace(/Bearer\s+[^\s,;"']+/gi, 'Bearer [已隐藏]').slice(0, 400);
}

function payloadError(payload: JsonObject, apiKey: string): Error | null {
  if (!payload.error && payload.type !== 'error') return null;
  const detail = object(payload.error);
  const raw = string(detail.message) || string(payload.message) || string(payload.error) || string(detail.type) || '服务返回错误。';
  return new Error(redactError(raw, apiKey));
}

function textParts(parts: unknown): string {
  return array(parts).map(part => { const entry = object(part); return entry.thought === true ? '' : string(entry.text); }).join('');
}

function fullText(payload: JsonObject, kind: ProviderKind): string {
  if (kind === 'gemini') return textParts(object(object(array(payload.candidates)[0]).content).parts);
  if (kind === 'anthropic') return textParts(payload.content);
  return string(object(object(array(payload.choices)[0]).message).content);
}

function streamDelta(payload: JsonObject, kind: ProviderKind): string {
  if (kind === 'gemini') return textParts(object(object(array(payload.candidates)[0]).content).parts);
  if (kind === 'anthropic') {
    if (payload.type === 'content_block_start') return string(object(payload.content_block).text);
    const delta = object(payload.delta);
    return delta.type === 'text_delta' ? string(delta.text) : '';
  }
  const choice = object(array(payload.choices)[0]);
  const delta = object(choice.delta);
  if (delta.refusal) throw new Error('模型未能翻译该内容，请尝试其他模型。');
  return string(delta.content);
}

function checkCompletion(payload: JsonObject, kind: ProviderKind): boolean {
  const reason = kind === 'anthropic' ? object(payload.delta).stop_reason ?? payload.stop_reason : kind === 'gemini' ? object(array(payload.candidates)[0]).finishReason : object(array(payload.choices)[0]).finish_reason;
  if (reason === 'length' || reason === 'max_tokens' || reason === 'MAX_TOKENS') throw new Error('翻译达到模型输出限制，请缩短原文后重试。');
  if (['content_filter', 'SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT'].includes(string(reason)) || object(payload.promptFeedback).blockReason) throw new Error('模型未能翻译该内容，请尝试其他模型。');
  const choice = object(array(payload.choices)[0]);
  const messages = [object(choice.delta), object(choice.message)];
  if (messages.some(message => message.tool_calls || message.function_call || message.refusal)
    || [...array(payload.content), object(payload.content_block)].some(part => object(part).type === 'tool_use')
    || array(object(object(array(payload.candidates)[0]).content).parts).some(part => object(part).functionCall)) {
    throw new Error('模型返回了工具调用或拒绝结果，未完成翻译，请尝试其他模型。');
  }
  if (reason === undefined || reason === null || reason === '') return false;
  const successful = kind === 'gemini' ? reason === 'STOP' : kind === 'anthropic' ? reason === 'end_turn' || reason === 'stop_sequence' : reason === 'stop';
  if (!successful) throw new Error(reason === 'CONTINUATION' ? '翻译尚未完成，服务要求续传，请缩短原文后重试。' : '模型未正常完成翻译，请重试或尝试其他模型。');
  return true;
}

function abortError(): DOMException { return new DOMException('翻译已停止。', 'AbortError'); }
function assertActive(signal: AbortSignal): void { if (signal.aborted) throw abortError(); }

async function requestFetch(url: string, init: RequestInit): Promise<Response> {
  if (isNative) {
    const { fetch } = await import('@tauri-apps/plugin-http');
    // Native transport avoids WebView CORS restrictions and keeps the response streaming.
    return fetch(url, { ...init, maxRedirections: 0 });
  }
  return globalThis.fetch(url, init);
}

// Bounds apply to the complete request, including heartbeats and JSON/error bodies.
export const API_LIMITS = { connectMs: 30_000, idleMs: 30_000, totalMs: 120_000, responseBytes: 8_388_608, jsonBytes: 4_194_304, errorBytes: 65_536, outputBytes: 1_048_576 } as const;

class ApiLifetime {
  readonly controller = new AbortController();
  private failure?: Error;
  private reject!: (error: Error) => void;
  private readonly failed = new Promise<never>((_, reject) => { this.reject = reject; });
  private idle?: ReturnType<typeof setTimeout>;
  private readonly total: ReturnType<typeof setTimeout>;
  private readonly abort = () => this.fail(abortError());
  constructor(private readonly parent: AbortSignal) {
    // A timeout can fire while a callback runs; retain a handler until the next wait.
    void this.failed.catch(() => undefined);
    this.total = setTimeout(() => this.fail(new Error('翻译请求超时，请缩短原文或稍后重试。')), API_LIMITS.totalMs);
    this.reset(API_LIMITS.connectMs);
    parent.addEventListener('abort', this.abort, { once: true });
    if (parent.aborted) this.abort();
  }
  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.controller.abort();
    this.reject(error);
  }
  reset(ms: number = API_LIMITS.idleMs): void {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.fail(new Error('翻译服务长时间未响应，请重试。')), ms);
  }
  check(): void { if (this.parent.aborted) throw abortError(); if (this.failure) throw this.failure; }
  async wait<T>(pending: Promise<T>): Promise<T> {
    // The operation may synchronously trigger abort before it returns a promise.
    void pending.catch(() => undefined);
    this.check();
    const result = await Promise.race([pending, this.failed]);
    this.check();
    return result;
  }
  close(): void {
    clearTimeout(this.idle); clearTimeout(this.total);
    this.parent.removeEventListener('abort', this.abort);
    this.controller.abort();
  }
}

/** Reader cancellation must not wait on a faulty transport's cancel promise. */
function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void { void reader.cancel().catch(() => undefined); }

async function readBounded(response: Response, limit: number, lifetime: ApiLifetime): Promise<string> {
  if (!response.body) throw new Error('API 未返回可读取的翻译数据。');
  const reader = response.body.getReader();
  const abort = () => cancelReader(reader);
  lifetime.controller.signal.addEventListener('abort', abort, { once: true });
  const decoder = new TextDecoder();
  let text = '', bytes = 0;
  try {
    while (true) {
      const chunk = await lifetime.wait(reader.read());
      if (chunk.done) return text + decoder.decode();
      bytes += chunk.value.byteLength;
      if (bytes > limit) throw new Error('API 返回的数据过大，请缩短原文或更换服务。');
      lifetime.reset();
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    lifetime.controller.signal.removeEventListener('abort', abort);
    cancelReader(reader);
    // A transport may leave a read outstanding after cancellation.
    try { reader.releaseLock(); } catch { /* Reader closes with its transport. */ }
  }
}

export async function translate(request: TranslationRequest): Promise<string> {
  assertActive(request.signal);
  if (request.provider.kind === 'codex') {
    const { translateWithCodex } = await import('./codex');
    return translateWithCodex(request);
  }
  const { url, init } = buildTranslationRequest(request);
  const lifetime = new ApiLifetime(request.signal);
  try {
    const fetching = requestFetch(url, { ...init, signal: lifetime.controller.signal });
    // If the transport ignores abort and resolves late, discard its body too.
    void fetching.then(response => { if (lifetime.controller.signal.aborted) void response.body?.cancel().catch(() => undefined); }, () => undefined);
    let response: Response;
    try { response = await lifetime.wait(fetching); }
    catch { lifetime.check(); throw new Error('无法连接翻译服务。请检查 API 地址和网络；浏览器预览还需要服务支持 CORS。'); }
    lifetime.reset();
    if (!response.ok) {
      const raw = await readBounded(response, API_LIMITS.errorBytes, lifetime);
      let detail = '';
      try { detail = payloadError(object(JSON.parse(raw)), request.apiKey)?.message || ''; } catch { /* Never display raw HTML or key-bearing bodies. */ }
      const hint = response.status === 401 || response.status === 403 ? '请检查 API Key 与模型权限。' : response.status === 429 ? '请求过于频繁或余额不足，请稍后重试。' : response.status >= 500 ? '服务暂时不可用，请稍后重试。' : '请检查 API 地址与模型名称。';
      throw new Error(`API 请求失败（${response.status}）。${detail ? ` ${detail}` : ` ${hint}`}`);
    }
    let result = '', outputBytes = 0;
    const encoder = new TextEncoder();
    const append = (delta: string) => {
      if (!delta) return;
      lifetime.check();
      outputBytes += encoder.encode(delta).byteLength;
      if (outputBytes > API_LIMITS.outputBytes) throw new Error('翻译结果过长，请缩短原文后重试。');
      result += delta;
      request.onDelta(delta);
    };
    if (response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
      const raw = await readBounded(response, API_LIMITS.jsonBytes, lifetime);
      let payload: JsonObject;
      try { payload = object(JSON.parse(raw)); } catch { throw new Error('API 返回了无法解析的数据，请检查服务类型。'); }
      const error = payloadError(payload, request.apiKey); if (error) throw error;
      if (!checkCompletion(payload, request.provider.kind)) throw new Error('API 未确认翻译完成，请重试或尝试其他服务。');
      append(fullText(payload, request.provider.kind));
    } else {
      if (!response.body) throw new Error('API 未返回可读取的翻译数据。');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let done = false, completed = false, bytes = 0;
      const parser = new SseParser(event => {
        if (done) return;
        if (event.data.trim() === '[DONE]') {
          if (request.provider.kind !== 'openai' || !completed) throw new Error('API 未确认翻译完成，请重试或尝试其他服务。');
          done = true; return;
        }
        let payload: JsonObject;
        try { payload = object(JSON.parse(event.data)); } catch { throw new Error('API 流式响应格式不正确，请检查服务类型和 API 地址。'); }
        const error = payloadError(payload, request.apiKey); if (error) throw error;
        const terminal = checkCompletion(payload, request.provider.kind);
        append(streamDelta(payload, request.provider.kind));
        completed ||= terminal;
        if (request.provider.kind === 'anthropic' && payload.type === 'message_stop') {
          if (!completed) throw new Error('API 未确认翻译完成，请重试或尝试其他服务。');
          done = true;
        }
      });
      const abort = () => cancelReader(reader);
      lifetime.controller.signal.addEventListener('abort', abort, { once: true });
      try {
        while (!done) {
          const chunk = await lifetime.wait(reader.read());
          if (chunk.done) { parser.feed(decoder.decode()); parser.finish(); break; }
          bytes += chunk.value.byteLength;
          if (bytes > API_LIMITS.responseBytes) throw new Error('API 返回的数据过大，请缩短原文或更换服务。');
          lifetime.reset();
          parser.feed(decoder.decode(chunk.value, { stream: true }));
        }
        if (!completed) throw new Error('翻译连接提前断开，请重试。');
      } finally {
        lifetime.controller.signal.removeEventListener('abort', abort);
        cancelReader(reader);
        try { reader.releaseLock(); } catch { /* Transport may still own an outstanding read. */ }
      }
    }
    lifetime.check();
    if (!result.trim()) throw new Error('模型没有返回翻译文本，请检查模型名称或尝试其他服务。');
    return result;
  } catch (error) {
    lifetime.check();
    if (error instanceof Error) throw new Error(redactError(error.message, request.apiKey));
    throw new Error('读取翻译响应失败，请重试。');
  } finally { lifetime.close(); }
}
