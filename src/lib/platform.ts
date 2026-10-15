import type { Screenshot } from '../types';

export const isNative = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export type OperatingSystem = 'macos' | 'windows' | 'linux' | 'ios' | 'android' | 'unknown';
export function detectOperatingSystem(environment: { buildPlatform?: string; userAgent?: string; platform?: string; maxTouchPoints?: number }): OperatingSystem {
  const build = environment.buildPlatform?.toLowerCase();
  if (build === 'macos' || build === 'darwin') return 'macos';
  if (build === 'windows' || build === 'win32') return 'windows';
  if (build === 'ios' || build === 'android' || build === 'linux') return build;
  const userAgent = environment.userAgent || '', platform = environment.platform || '';
  if (/Android/i.test(userAgent)) return 'android';
  if (/iPhone|iPad|iPod/i.test(userAgent) || (/Mac/i.test(platform) && (environment.maxTouchPoints || 0) > 1)) return 'ios';
  if (/Mac/i.test(platform) || /Macintosh/i.test(userAgent)) return 'macos';
  if (/Win/i.test(platform) || /Windows/i.test(userAgent)) return 'windows';
  if (/Linux/i.test(platform + userAgent)) return 'linux';
  return 'unknown';
}

export const operatingSystem = detectOperatingSystem({
  buildPlatform: import.meta.env.TAURI_ENV_PLATFORM,
  userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
  platform: typeof navigator === 'undefined' ? '' : navigator.platform,
  maxTouchPoints: typeof navigator === 'undefined' ? 0 : navigator.maxTouchPoints,
});
export const isMobile = operatingSystem === 'ios' || operatingSystem === 'android';
export const isMac = operatingSystem === 'macos';
export const isNativeMac = isNative && isMac;
export const isNativeWindows = isNative && operatingSystem === 'windows';
export const shortcutLabels = {
  capture: isNativeMac ? '⌥⌘S' : isMac ? '⌘ ⇧ S' : 'Ctrl ⇧ S',
  clipboard: isNativeMac ? '⌥⌘V' : isMac ? '⌘ ⇧ D' : 'Ctrl ⇧ D',
  translate: isMac ? '⌘ + Enter' : 'Ctrl + Enter',
  quit: isNativeMac ? '⌘Q' : 'Ctrl + Alt + Q',
  emergencyQuit: isNativeMac ? '⌥⌘Q' : 'Ctrl + Alt + Q',
};

async function invokeNative<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}

export async function readClipboard(): Promise<string> {
  if (isNative) return invokeNative<string>('read_clipboard');
  if (!navigator.clipboard?.readText) throw new Error('浏览器无法读取剪贴板，请在文本框中粘贴。');
  try { return await navigator.clipboard.readText(); }
  catch { throw new Error('无法读取剪贴板。请允许浏览器的剪贴板权限，或直接粘贴文本。'); }
}

export async function writeClipboard(text: string): Promise<void> {
  if (isNative) return invokeNative<void>('write_clipboard', { text });
  if (!navigator.clipboard?.writeText) throw new Error('浏览器无法写入剪贴板，请手动复制文本。');
  try { await navigator.clipboard.writeText(text); }
  catch { throw new Error('复制失败，请允许剪贴板权限或手动复制。'); }
}

export async function startCapture(): Promise<void> {
  if (isNative) return invokeNative<void>('start_capture');
  throw new Error('浏览器预览请使用屏幕共享截图；全局截图快捷键需要桌面应用。');
}

export async function showSidebar(): Promise<void> { if (isNative) await invokeNative<void>('show_sidebar'); }
export async function expandWindow(): Promise<void> { if (isNative) await invokeNative<void>('expand_window'); }
export async function hideWindow(): Promise<void> { if (isNative) await invokeNative<void>('hide_window'); }

export interface ShortcutStatus { captureShortcut: string; clipboardShortcut: string; error: string | null; quitShortcut?: string; platform?: string; }
export async function getShortcutStatus(): Promise<ShortcutStatus | null> {
  return isNative ? invokeNative<ShortcutStatus>('get_shortcut_status') : null;
}

export interface InputHandlers {
  onClipboard?: (text: string) => void;
  onImage?: (image: Screenshot) => void;
  onMode?: (mode: 'sidebar' | 'expanded') => void;
  onError?: (message: string) => void;
  onNavigate?: (view: 'settings') => void;
}

export async function listenInputs(handlers: InputHandlers): Promise<() => void> {
  if (!isNative) return () => undefined;
  const { listen } = await import('@tauri-apps/api/event');
  const cleanup: Array<() => void> = [];
  try {
    cleanup.push(await listen<string>('fastdict://clipboard', event => { if (typeof event.payload === 'string') handlers.onClipboard?.(event.payload); }));
    cleanup.push(await listen<Screenshot>('fastdict://image', event => {
      const image = event.payload;
      if (image && typeof image.dataUrl === 'string' && image.width > 0 && image.height > 0) handlers.onImage?.(image);
    }));
    if (handlers.onMode) cleanup.push(await listen<string>('fastdict://mode', event => {
      if (event.payload === 'sidebar' || event.payload === 'expanded') handlers.onMode?.(event.payload);
    }));
    if (handlers.onError) cleanup.push(await listen<string>('fastdict://error', event => {
      if (typeof event.payload === 'string') handlers.onError?.(event.payload);
    }));
    if (handlers.onNavigate) cleanup.push(await listen<string>('fastdict://navigate', event => {
      if (event.payload === 'settings') handlers.onNavigate?.('settings');
    }));
  } catch (error) { for (const unlisten of cleanup) unlisten(); throw error; }
  return () => { for (const unlisten of cleanup) unlisten(); };
}

export interface ScreenPermission { supported: boolean; granted: boolean; status: 'granted' | 'denied' | 'unsupported'; }
const unsupportedScreenPermission: ScreenPermission = { supported: false, granted: false, status: 'unsupported' };
export async function getScreenPermission(): Promise<ScreenPermission> {
  return isNativeMac ? invokeNative<ScreenPermission>('get_screen_permission') : { ...unsupportedScreenPermission };
}
export async function requestScreenPermission(): Promise<ScreenPermission> {
  return isNativeMac ? invokeNative<ScreenPermission>('request_screen_permission') : { ...unsupportedScreenPermission };
}
export async function openScreenPermissionSettings(): Promise<void> {
  if (isNativeMac) await invokeNative<void>('open_screen_permission_settings');
}

/** Browser fallback: return one frame and stop sharing immediately. */
export async function captureDisplay(): Promise<Screenshot> {
  if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('当前浏览器不支持屏幕截图，请导入图片或使用桌面应用。');
  let stream: MediaStream;
  try { stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false }); }
  catch (error) {
    if (error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'AbortError')) throw new DOMException('已取消截图。', 'AbortError');
    throw new Error('无法获取屏幕图像，请导入图片或使用桌面应用。');
  }
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  try {
    await video.play();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        video.removeEventListener('loadeddata', ready);
        video.removeEventListener('error', failed);
        if (error) reject(error); else resolve();
      };
      const ready = () => finish();
      const failed = () => finish(new Error('读取屏幕图像失败。'));
      const timeout = window.setTimeout(() => finish(new Error('读取屏幕图像超时，请重试。')), 10_000);
      video.addEventListener('loadeddata', ready, { once: true });
      video.addEventListener('error', failed, { once: true });
      if (video.readyState >= 2 && video.videoWidth > 0) ready();
    });
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) throw new Error('屏幕图像为空，请重试。');
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法创建截图。');
    context.drawImage(video, 0, 0);
    return { dataUrl: canvas.toDataURL('image/png'), width, height };
  } finally {
    for (const track of stream.getTracks()) track.stop();
    video.pause();
    video.srcObject = null;
  }
}
