/**
 * Browser adapter for the bundled Tesseract.js 6 worker protocol. Unlike its
 * createWorker() promise, this owns the native Worker before loading models,
 * so rejected or unanswered initialization always has a termination handle.
 */
export interface OcrEngine {
  initialize(language: string): Promise<void>;
  setParameters(): Promise<void>;
  recognize(image: string | HTMLCanvasElement): Promise<{ text: string; confidence: number }>;
  terminate(): void;
}
interface WorkerReply { jobId: string; status: 'resolve' | 'reject' | 'progress'; data: unknown; }
interface PendingJob { resolve: (data: unknown) => void; reject: (error: Error) => void; }
let engineId = 0;

export function createOcrEngine(paths: { worker: string; core: string; lang: string }, progress: (progress: number, status: string) => void): OcrEngine {
  const native = new Worker(paths.worker);
  const workerId = `fastlingo-ocr-${++engineId}`;
  const pending = new Map<string, PendingJob>();
  const loadedLanguages = new Set<string>();
  let sequence = 0, terminated = false, loaded = false;
  const terminate = () => {
    if (terminated) return;
    terminated = true;
    native.removeEventListener('message', onMessage);
    native.removeEventListener('error', onError);
    native.removeEventListener('messageerror', onError);
    native.terminate();
    for (const job of pending.values()) job.reject(new Error('OCR 引擎已停止。'));
    pending.clear();
  };
  const onError = () => terminate();
  const onMessage = (event: MessageEvent<WorkerReply>) => {
    if (terminated || !event.data) return;
    const reply = event.data, task = pending.get(reply.jobId);
    if (!task) return;
    if (reply.status === 'progress') {
      const data = reply.data as { progress?: unknown; status?: unknown };
      progress(typeof data?.progress === 'number' ? Math.max(0, Math.min(1, data.progress)) : 0, typeof data?.status === 'string' ? data.status : '');
    } else if (reply.status === 'resolve') {
      pending.delete(reply.jobId); task.resolve(reply.data);
    } else if (reply.status === 'reject') {
      pending.delete(reply.jobId);
      task.reject(new Error('OCR 引擎处理失败，请检查本地语言模型。'));
      terminate();
    }
  };
  native.addEventListener('message', onMessage);
  native.addEventListener('error', onError);
  native.addEventListener('messageerror', onError);
  const job = (action: string, payload: unknown, transfer: Transferable[] = []): Promise<unknown> => {
    if (terminated) return Promise.reject(new Error('OCR 引擎已停止。'));
    const jobId = `${workerId}-${++sequence}`;
    return new Promise((resolve, reject) => {
      pending.set(jobId, { resolve, reject });
      try { native.postMessage({ workerId, jobId, action, payload }, transfer); }
      catch { pending.delete(jobId); reject(new Error('无法向 OCR 引擎发送图片。')); terminate(); }
    });
  };
  return {
    async initialize(language) {
      if (!loaded) {
        await job('load', { options: { lstmOnly: true, corePath: paths.core, logging: false } });
        loaded = true;
      }
      const missing = language.split('+').filter(value => !loadedLanguages.has(value));
      if (missing.length) {
        await job('loadLanguage', { langs: missing, options: { langPath: paths.lang, cacheMethod: 'write', gzip: true, lstmOnly: true } });
        for (const value of missing) loadedLanguages.add(value);
      }
      await job('initialize', { langs: language, oem: 1, config: {} });
    },
    async setParameters() { await job('setParameters', { params: { tessedit_pageseg_mode: '3', preserve_interword_spaces: '1' } }); },
    async recognize(image) {
      const dataUrl = typeof image === 'string' ? image : image.toDataURL('image/png');
      const decoded = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
      const bytes = new Uint8Array(decoded.length);
      for (let index = 0; index < decoded.length; index++) bytes[index] = decoded.charCodeAt(index);
      // Recognition owns this buffer; transfer it instead of copying the image on the UI thread.
      const result = await job('recognize', { image: bytes, options: {}, output: { text: true } }, [bytes.buffer]) as { text?: unknown; confidence?: unknown };
      if (typeof result?.text !== 'string' || typeof result.confidence !== 'number') throw new Error('OCR 未返回有效识别结果。');
      return { text: result.text, confidence: result.confidence };
    },
    terminate,
  };
}
