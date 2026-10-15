import type { TranslationRequest } from '../types';
import { isMobile, isNative } from './platform';

export interface CodexStatus {
  available: boolean;
  authenticated: boolean;
  authMode: 'chatgpt' | 'apikey' | 'none';
  version?: string;
  modelAvailable: boolean;
  message?: string;
}

interface CodexEvent { type: 'delta'; text: string; }
const desktopMessage = '本机 Codex 仅支持桌面应用，请在 Windows 或 macOS 版使用。';
const abortError = () => new DOMException('翻译已停止。', 'AbortError');

export async function getCodexStatus(model = 'gpt-6-luna'): Promise<CodexStatus> {
  if (!isNative || isMobile) {
    return { available: false, authenticated: false, authMode: 'none', modelAvailable: false, message: desktopMessage };
  }
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<CodexStatus>('get_codex_status', { model });
}

/** Only Codex manages subscription credentials; the renderer never receives them. */
export async function translateWithCodex(request: TranslationRequest): Promise<string> {
  if (request.signal.aborted) throw abortError();
  if (!isNative || isMobile) throw new Error(desktopMessage);
  const model = request.provider.model.trim();
  if (!model || !/^[A-Za-z0-9._-]{1,200}$/.test(model)) throw new Error('请填写有效的 Codex 模型名称。');
  if (!request.text.trim()) throw new Error('请输入需要翻译的文本。');
  if (request.text.length > 60_000) throw new Error('文本过长，请分段翻译（每次最多 60,000 个字符）。');
  if (!request.targetLang.trim()) throw new Error('请选择目标语言。');
  const { Channel, invoke } = await import('@tauri-apps/api/core');
  if (request.signal.aborted) throw abortError();
  const requestId = crypto.randomUUID();
  const channel = new Channel<CodexEvent>();
  let finished = false;
  let started = false;
  let received = false;
  let rejectAbort: (error: DOMException) => void = () => undefined;
  const interrupted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const abort = () => {
    finished = true;
    if (started) void invoke('cancel_codex_translation', { requestId }).catch(() => undefined);
    rejectAbort(abortError());
  };
  channel.onmessage = event => {
    if (!finished && !request.signal.aborted && event?.type === 'delta' && typeof event.text === 'string' && event.text) {
      received = true;
      request.onDelta(event.text);
    }
  };
  request.signal.addEventListener('abort', abort, { once: true });
  try {
    started = true;
    const pending = invoke<string>('translate_with_codex', {
      requestId, model, text: request.text, sourceLang: request.sourceLang,
      targetLang: request.targetLang, onEvent: channel,
    });
    const result = await Promise.race([pending, interrupted]);
    if (request.signal.aborted) throw abortError();
    if (typeof result !== 'string' || !result.trim()) throw new Error('Codex 没有返回译文，请检查模型权限后重试。');
    if (!received) request.onDelta(result);
    return result;
  } catch (error) {
    if (request.signal.aborted) throw abortError();
    throw new Error((error instanceof Error ? error.message : String(error)).slice(0, 400));
  } finally {
    finished = true;
    channel.onmessage = () => undefined;
    request.signal.removeEventListener('abort', abort);
  }
}
