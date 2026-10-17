import type { TranslationRequest } from '../types';
import { isMobile, isNative } from './platform';
import { createId } from './id';
import { renderTranslationPrompt } from './prompts';

export interface ChatGPTStatus {
  available: boolean;
  connected: boolean;
  planEnabled: boolean;
  accountLabel?: string;
  modelAvailable: boolean;
  models?: { slug: string; displayName: string }[];
  profiles?: { id: string; label: string; active: boolean; connected: boolean; planEnabled: boolean }[];
  message?: string;
}
// The stored provider kind and these aliases keep existing configurations compatible.
export type CodexStatus = ChatGPTStatus;

interface ChatGPTEvent { type: 'delta'; text: string; }
const desktopMessage = 'ChatGPT 订阅翻译仅支持桌面应用，请在 Windows 或 macOS 版使用。';
const abortError = () => new DOMException('翻译已停止。', 'AbortError');

function normalizedStatus(value: ChatGPTStatus): ChatGPTStatus {
  return {
    available: value.available === true, connected: value.connected === true,
    planEnabled: value.planEnabled === true, modelAvailable: value.modelAvailable === true,
    ...(typeof value.accountLabel === 'string' ? { accountLabel: value.accountLabel.slice(0, 200) } : {}),
    ...(typeof value.message === 'string' ? { message: value.message.slice(0, 400) } : {}),
    ...(Array.isArray(value.models) ? { models: value.models.slice(0, 1000).flatMap(model =>
      typeof model?.slug === 'string' && typeof model.displayName === 'string'
        ? [{ slug: model.slug.slice(0, 200), displayName: model.displayName.slice(0, 200) }] : []) } : {}),
    ...(Array.isArray(value.profiles) ? { profiles: value.profiles.slice(0, 100).flatMap(profile =>
      typeof profile?.id === 'string' && typeof profile.label === 'string'
        ? [{ id: profile.id.slice(0, 200), label: profile.label.slice(0, 200), active: profile.active === true, connected: profile.connected === true, planEnabled: profile.planEnabled === true }] : []) } : {}),
  };
}

export async function getCodexStatus(model = 'gpt-6-luna'): Promise<ChatGPTStatus> {
  if (!isNative || isMobile) {
    return { available: false, connected: false, planEnabled: false, modelAvailable: false, message: desktopMessage };
  }
  const { invoke } = await import('@tauri-apps/api/core');
  return normalizedStatus(await invoke<ChatGPTStatus>('get_chatgpt_status', { model }));
}

export async function getChatGPTConnection(model = 'gpt-6-luna'): Promise<ChatGPTStatus> {
  if (!isNative || isMobile) return { available: false, connected: false, planEnabled: false, modelAvailable: false, message: desktopMessage };
  const { invoke } = await import('@tauri-apps/api/core');
  return normalizedStatus(await invoke<ChatGPTStatus>('get_chatgpt_status', { model, queryCatalog: false }));
}

export async function signInChatGPT(model = 'gpt-6-luna', newAccount = false): Promise<ChatGPTStatus> {
  if (!isNative || isMobile) throw new Error(desktopMessage);
  const { invoke } = await import('@tauri-apps/api/core');
  return normalizedStatus(await invoke<ChatGPTStatus>('sign_in_chatgpt', { model, newAccount }));
}

export async function selectChatGPTProfile(profileId: string, model = 'gpt-6-luna'): Promise<ChatGPTStatus> {
  if (!isNative || isMobile) throw new Error(desktopMessage);
  const { invoke } = await import('@tauri-apps/api/core');
  return normalizedStatus(await invoke<ChatGPTStatus>('select_chatgpt_profile', { profileId, model }));
}

export async function cancelChatGPTSignIn(): Promise<ChatGPTStatus> {
  if (!isNative || isMobile) return { available: false, connected: false, planEnabled: false, modelAvailable: false, message: desktopMessage };
  const { invoke } = await import('@tauri-apps/api/core');
  return normalizedStatus(await invoke<ChatGPTStatus>('cancel_chatgpt_sign_in'));
}

export async function forgetChatGPTProfile(profileId: string, model = 'gpt-6-luna'): Promise<ChatGPTStatus> {
  if (!isNative || isMobile) throw new Error(desktopMessage);
  const { invoke } = await import('@tauri-apps/api/core');
  return normalizedStatus(await invoke<ChatGPTStatus>('forget_chatgpt_profile', { profileId, model }));
}

export async function disconnectChatGPT(): Promise<ChatGPTStatus> {
  if (!isNative || isMobile) throw new Error(desktopMessage);
  const { invoke } = await import('@tauri-apps/api/core');
  return normalizedStatus(await invoke<ChatGPTStatus>('disconnect_chatgpt'));
}

export async function openChatGPTUsage(): Promise<void> {
  if (!isNative || isMobile) throw new Error(desktopMessage);
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('open_chatgpt_usage');
}

/** OAuth and inference tokens stay in the native process and system credential store. */
export async function translateWithCodex(request: TranslationRequest): Promise<string> {
  if (request.signal.aborted) throw abortError();
  if (!isNative || isMobile) throw new Error(desktopMessage);
  const model = request.provider.model.trim();
  if (!model || !/^[A-Za-z0-9._-]{1,200}$/.test(model)) throw new Error('请填写有效的 ChatGPT 模型名称。');
  if (!request.text.trim()) throw new Error('请输入需要翻译的文本。');
  if (request.text.length > 60_000) throw new Error('文本过长，请分段翻译（每次最多 60,000 个字符）。');
  if (!request.targetLang.trim()) throw new Error('请选择目标语言。');
  const instructions = renderTranslationPrompt(request.promptTemplate, request.sourceLang, request.targetLang);
  const { Channel, invoke } = await import('@tauri-apps/api/core');
  if (request.signal.aborted) throw abortError();
  const requestId = createId();
  const channel = new Channel<ChatGPTEvent>();
  let finished = false;
  let started = false;
  let received = false;
  let rejectAbort: (error: DOMException) => void = () => undefined;
  const interrupted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const abort = () => {
    finished = true;
    if (started) void invoke('cancel_chatgpt_translation', { requestId }).catch(() => undefined);
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
    const pending = invoke<string>('translate_with_chatgpt', {
      requestId, model, text: request.text, sourceLang: request.sourceLang,
      targetLang: request.targetLang, instructions, onEvent: channel,
    });
    const result = await Promise.race([pending, interrupted]);
    if (request.signal.aborted) throw abortError();
    if (typeof result !== 'string' || !result.trim()) throw new Error('ChatGPT 没有返回译文，请检查模型权限后重试。');
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

export const getChatGPTStatus = getCodexStatus;
export const translateWithChatGPT = translateWithCodex;
