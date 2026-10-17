import { createOcrEngine } from './ocrWorker';
import type { OcrEngine } from './ocrWorker';

export type OcrProgress = (progress: number, status: string) => void;
export interface OcrResult { text: string; confidence: number; }
export const OCR_TIMEOUT_MS = 45_000;
const LANGUAGES = new Set(['eng', 'chi_sim', 'chi_tra', 'jpn', 'kor']);
let worker: OcrEngine | null = null;
let workerLanguage = '';
let queue: Promise<void> = Promise.resolve();
let progressListener: OcrProgress | undefined;
let warmController: AbortController | undefined;
const activeJobs = new Set<AbortController>();

function normalizeLanguage(language: string): string {
  const languages = [...new Set(language.split('+').filter(Boolean))];
  if (!languages.length || languages.some(value => !LANGUAGES.has(value))) throw new Error('请选择支持的 OCR 语言。');
  return languages.sort((a, b) => a === 'eng' ? -1 : b === 'eng' ? 1 : a.localeCompare(b)).join('+');
}
function exclusive<T>(job: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(abortError());
  let rejectQueued: ((error: Error) => void) | undefined;
  const cancelQueued = () => rejectQueued?.(abortError());
  const run = () => {
    signal?.removeEventListener('abort', cancelQueued);
    if (signal?.aborted) throw abortError();
    return job();
  };
  const result = queue.then(run, run);
  queue = result.then(() => undefined, () => undefined);
  if (!signal) return result;
  // A cancelled waiter must settle immediately without terminating another job's worker.
  return new Promise<T>((resolve, reject) => {
    rejectQueued = reject;
    signal.addEventListener('abort', cancelQueued, { once: true });
    void result.then(resolve, reject);
  });
}
function abortError(): DOMException { return new DOMException('文字识别已停止。', 'AbortError'); }
function releaseWorker(engine = worker): void {
  if (worker === engine) { worker = null; workerLanguage = ''; }
  engine?.terminate();
}

/** One bound covers decode, model initialization, parameter setup and recognition. */
async function runJob<T>(controller: AbortController, parent: AbortSignal | undefined, task: (wait: <U>(promise: Promise<U>) => Promise<U>) => Promise<T>): Promise<T> {
  activeJobs.add(controller);
  const forward = () => controller.abort();
  parent?.addEventListener('abort', forward, { once: true });
  if (parent?.aborted) forward();
  try {
    return await exclusive(async () => {
      if (controller.signal.aborted) throw abortError();
      let timedOut = false;
      let reject!: (error: Error) => void;
      const failed = new Promise<never>((_, fail) => { reject = fail; });
      void failed.catch(() => undefined);
      const abort = () => { releaseWorker(); reject(timedOut ? new Error('OCR 处理超时，请重新截图或选择更小的图片。') : abortError()); };
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, OCR_TIMEOUT_MS);
      controller.signal.addEventListener('abort', abort, { once: true });
      const wait = async <U>(pending: Promise<U>): Promise<U> => {
        void pending.catch(() => undefined);
        if (controller.signal.aborted) throw timedOut ? new Error('OCR 处理超时，请重试。') : abortError();
        const result = await Promise.race([pending, failed]);
        if (controller.signal.aborted) throw timedOut ? new Error('OCR 处理超时，请重试。') : abortError();
        return result;
      };
      try { return await task(wait); }
      catch (error) {
        if (controller.signal.aborted) throw timedOut ? new Error('OCR 处理超时，请重试。') : abortError();
        releaseWorker();
        throw error instanceof Error ? error : new Error('文字识别失败，请重新截图或尝试其他 OCR 语言。');
      } finally {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', abort);
        progressListener = undefined;
      }
    }, controller.signal);
  } finally { parent?.removeEventListener('abort', forward); activeJobs.delete(controller); }
}

function asset(path: string): string { return new URL(`${import.meta.env.BASE_URL}ocr/${path}`, window.location.href).href; }
async function getWorker(language: string, wait: <T>(promise: Promise<T>) => Promise<T>): Promise<OcrEngine> {
  if (worker && workerLanguage === language) return worker;
  try {
    worker ??= createOcrEngine({ worker: asset('worker.min.js'), core: asset('core'), lang: asset('lang') }, (progress, status) => progressListener?.(progress, status));
    const engine = worker;
    await wait(engine.initialize(language));
    await wait(engine.setParameters());
    workerLanguage = language;
    return engine;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    if (error instanceof Error && error.message.includes('超时')) throw error;
    throw new Error('OCR 引擎加载失败。请确认本地语言模型已安装，再重试。');
  }
}

async function resizeImage(dataUrl: string, wait: <T>(promise: Promise<T>) => Promise<T>): Promise<string | HTMLCanvasElement> {
  if (!/^data:image\/(png|jpeg|jpg|webp|bmp);base64,/i.test(dataUrl)) throw new Error('请选择 PNG、JPEG、WebP 或 BMP 图片。');
  if (dataUrl.length > 80_000_000) throw new Error('图片过大，请截取需要翻译的区域。');
  const image = new Image(); image.src = dataUrl;
  try { await wait(image.decode()); }
  catch (error) {
    image.src = '';
    if (error instanceof DOMException && error.name === 'AbortError' || error instanceof Error && error.message.includes('超时')) throw error;
    throw new Error('无法读取这张图片，请重新截图或选择其他图片。');
  }
  if (!image.naturalWidth || !image.naturalHeight) throw new Error('图片没有可识别的内容。');
  const scale = Math.min(1, 2600 / Math.max(image.naturalWidth, image.naturalHeight));
  if (scale === 1) return dataUrl;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法处理图片。');
  context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** Superseded prewarming yields immediately to a new image or language. */
export async function warmOcr(language: string, signal?: AbortSignal): Promise<void> {
  const normalized = normalizeLanguage(language);
  warmController?.abort();
  const controller = new AbortController(); warmController = controller;
  try { await runJob(controller, signal, async wait => { await getWorker(normalized, wait); }); }
  finally { if (warmController === controller) warmController = undefined; }
}

export async function recognizeImage(dataUrl: string, language: string, onProgress?: OcrProgress, signal?: AbortSignal): Promise<OcrResult> {
  const normalized = normalizeLanguage(language);
  warmController?.abort();
  return runJob(new AbortController(), signal, async wait => {
    progressListener = onProgress;
    const image = await resizeImage(dataUrl, wait);
    const engine = await getWorker(normalized, wait);
    onProgress?.(0, 'recognizing text');
    const result = await wait(engine.recognize(image));
    onProgress?.(1, 'recognizing text');
    return { text: result.text.trim(), confidence: result.confidence };
  });
}

export async function disposeOcr(): Promise<void> {
  warmController?.abort();
  for (const controller of activeJobs) controller.abort();
  await exclusive(async () => { releaseWorker(); progressListener = undefined; });
}
