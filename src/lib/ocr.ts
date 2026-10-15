import type { Worker } from 'tesseract.js';

export type OcrProgress = (progress: number, status: string) => void;
export interface OcrResult { text: string; confidence: number; }

const LANGUAGES = new Set(['eng', 'chi_sim', 'chi_tra', 'jpn', 'kor']);
let worker: Worker | null = null;
let workerLanguage = '';
let queue: Promise<void> = Promise.resolve();
let progressListener: OcrProgress | undefined;

function normalizeLanguage(language: string): string {
  const languages = [...new Set(language.split('+').filter(Boolean))];
  if (!languages.length || languages.some(value => !LANGUAGES.has(value))) throw new Error('请选择支持的 OCR 语言。');
  return languages.sort((a, b) => a === 'eng' ? -1 : b === 'eng' ? 1 : a.localeCompare(b)).join('+');
}

function exclusive<T>(job: () => Promise<T>): Promise<T> {
  const result = queue.then(job, job);
  queue = result.then(() => undefined, () => undefined);
  return result;
}

function assertActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('文字识别已停止。', 'AbortError');
}

async function recognizeAbortable(engine: Worker, image: string | HTMLCanvasElement, signal?: AbortSignal) {
  assertActive(signal);
  if (!signal) return engine.recognize(image, {}, { text: true });
  return new Promise<Awaited<ReturnType<Worker['recognize']>>>((resolve, reject) => {
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      // Termination releases the worker CPU immediately. A new capture lazily
      // recreates it from local/cached models, instead of waiting for stale OCR.
      void engine.terminate().catch(() => undefined).then(() => {
        if (worker === engine) { worker = null; workerLanguage = ''; }
        reject(new DOMException('文字识别已停止。', 'AbortError'));
      });
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    void engine.recognize(image, {}, { text: true }).then(result => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      resolve(result);
    }, error => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      reject(error);
    });
  });
}

function asset(path: string): string {
  return new URL(`${import.meta.env.BASE_URL}ocr/${path}`, window.location.href).href;
}

async function getWorker(language: string): Promise<Worker> {
  if (worker && workerLanguage === language) return worker;
  const { createWorker, OEM, PSM } = await import('tesseract.js');
  try {
    if (worker) {
      await worker.reinitialize(language, OEM.LSTM_ONLY);
    } else {
      let initializationFailed = false;
      let rejectInitialization: (error: unknown) => void = () => undefined;
      const failed = new Promise<never>((_, reject) => { rejectInitialization = reject; });
      const failInitialization = (error: unknown) => { initializationFailed = true; rejectInitialization(error); };
      const timer = window.setTimeout(() => failInitialization(new Error('OCR 加载超时。')), 45_000);
      const creating = createWorker(language, OEM.LSTM_ONLY, {
        workerPath: asset('worker.min.js'), corePath: asset('core'), langPath: asset('lang'),
        workerBlobURL: false, gzip: true, cacheMethod: 'write',
        // Tesseract can leave initialization pending on a language-load failure.
        errorHandler: failInitialization,
        logger: event => {
          const progress = typeof event.progress === 'number' ? Math.max(0, Math.min(1, event.progress)) : 0;
          progressListener?.(progress, event.status);
        },
      });
      void creating.then(engine => { if (initializationFailed) void engine.terminate().catch(() => undefined); }, () => undefined);
      try { worker = await Promise.race([creating, failed]); }
      finally { window.clearTimeout(timer); rejectInitialization = () => undefined; }
    }
    await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO, preserve_interword_spaces: '1' });
    workerLanguage = language;
    return worker;
  } catch {
    if (worker) { try { await worker.terminate(); } catch { /* Worker may already be broken. */ } }
    worker = null;
    workerLanguage = '';
    throw new Error('OCR 引擎加载失败。请确认本地语言模型已安装，再重试。');
  }
}

async function resizeImage(dataUrl: string): Promise<string | HTMLCanvasElement> {
  if (!/^data:image\/(png|jpeg|jpg|webp|bmp);base64,/i.test(dataUrl)) throw new Error('请选择 PNG、JPEG、WebP 或 BMP 图片。');
  if (dataUrl.length > 80_000_000) throw new Error('图片过大，请截取需要翻译的区域。');
  const image = new Image();
  image.src = dataUrl;
  try { await image.decode(); } catch { throw new Error('无法读取这张图片，请重新截图或选择其他图片。'); }
  if (!image.naturalWidth || !image.naturalHeight) throw new Error('图片没有可识别的内容。');
  const scale = Math.min(1, 2600 / Math.max(image.naturalWidth, image.naturalHeight));
  if (scale === 1) return dataUrl;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法处理图片。');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export async function warmOcr(language: string): Promise<void> {
  const normalized = normalizeLanguage(language);
  await exclusive(async () => { await getWorker(normalized); });
}

/** One persistent worker is shared by captures; serialized jobs avoid cross-image results. */
export async function recognizeImage(dataUrl: string, language: string, onProgress?: OcrProgress, signal?: AbortSignal): Promise<OcrResult> {
  const normalized = normalizeLanguage(language);
  return exclusive(async () => {
    assertActive(signal);
    progressListener = onProgress;
    try {
      // Decode first: a bad image must not release the lock while a worker initializes.
      const image = await resizeImage(dataUrl);
      assertActive(signal);
      const engine = await getWorker(normalized);
      assertActive(signal);
      onProgress?.(0, 'recognizing text');
      const result = await recognizeAbortable(engine, image, signal);
      assertActive(signal);
      onProgress?.(1, 'recognizing text');
      return { text: result.data.text.trim(), confidence: result.data.confidence };
    } catch (error) {
      if (error instanceof Error) throw error;
      throw new Error('文字识别失败，请重新截图或尝试其他 OCR 语言。');
    } finally { progressListener = undefined; }
  });
}

export async function disposeOcr(): Promise<void> {
  await exclusive(async () => {
    if (worker) await worker.terminate();
    worker = null;
    workerLanguage = '';
    progressListener = undefined;
  });
}
