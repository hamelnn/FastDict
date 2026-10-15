import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  engine: { recognize: vi.fn(), reinitialize: vi.fn(), setParameters: vi.fn(), terminate: vi.fn() },
  createWorker: vi.fn(),
}));
vi.mock('tesseract.js', () => ({ createWorker: fake.createWorker, OEM: { LSTM_ONLY: 1 }, PSM: { AUTO: '3' } }));
import { disposeOcr, recognizeImage, warmOcr } from '../ocr';

const IMAGE = 'data:image/png;base64,ZmFrZQ==';
beforeEach(async () => {
  await disposeOcr();
  vi.clearAllMocks();
  fake.createWorker.mockResolvedValue(fake.engine);
  fake.engine.recognize.mockResolvedValue({ data: { text: ' Hello world \n', confidence: 92 } });
  fake.engine.setParameters.mockResolvedValue({});
  fake.engine.reinitialize.mockResolvedValue({});
  fake.engine.terminate.mockResolvedValue({});
  vi.stubGlobal('window', { location: { href: 'https://fastdict.example/' }, setTimeout, clearTimeout });
  vi.stubGlobal('Image', class { naturalWidth = 1200; naturalHeight = 800; src = ''; decode() { return Promise.resolve(); } });
});
afterEach(async () => { await disposeOcr(); vi.unstubAllGlobals(); });

describe('persistent OCR pipeline', () => {
  it('prewarms one local worker and reuses it for successive screenshots', async () => {
    await warmOcr('eng');
    expect(await recognizeImage(IMAGE, 'eng')).toEqual({ text: 'Hello world', confidence: 92 });
    await recognizeImage(IMAGE, 'eng');
    expect(fake.createWorker).toHaveBeenCalledTimes(1);
    expect(fake.engine.recognize).toHaveBeenCalledTimes(2);
    expect(fake.createWorker.mock.calls[0][2]).toMatchObject({ workerPath: 'https://fastdict.example/ocr/worker.min.js', langPath: 'https://fastdict.example/ocr/lang', corePath: 'https://fastdict.example/ocr/core', workerBlobURL: false });
  });
  it('serializes overlapping requests and delivers the correct result to each caller', async () => {
    let active = 0;
    let maximumActive = 0;
    fake.engine.recognize.mockImplementation(async (image: string) => {
      active++; maximumActive = Math.max(maximumActive, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      return { data: { text: image.endsWith('YQ==') ? 'first' : 'second', confidence: 90 } };
    });
    const results = await Promise.all([recognizeImage('data:image/png;base64,YQ==', 'eng'), recognizeImage('data:image/png;base64,Yg==', 'eng')]);
    expect(results.map(result => result.text)).toEqual(['first', 'second']);
    expect(maximumActive).toBe(1); expect(fake.createWorker).toHaveBeenCalledTimes(1);
  });
  it('changes languages by reinitializing the existing worker', async () => {
    await warmOcr('eng');
    await recognizeImage(IMAGE, 'chi_sim+eng');
    expect(fake.createWorker).toHaveBeenCalledTimes(1);
    expect(fake.engine.reinitialize).toHaveBeenCalledWith('eng+chi_sim', 1);
    await recognizeImage(IMAGE, 'eng+chi_sim+eng');
    expect(fake.engine.reinitialize).toHaveBeenCalledTimes(1);
  });
  it('rejects unsupported languages and invalid images before loading a worker', async () => {
    await expect(warmOcr('../../model')).rejects.toThrow('OCR 语言');
    await expect(recognizeImage('https://remote.example/image.png', 'eng')).rejects.toThrow('图片');
    expect(fake.createWorker).not.toHaveBeenCalled();
  });
  it('keeps the request queue usable after a recognition failure', async () => {
    fake.engine.recognize.mockRejectedValueOnce(new Error('failed'));
    await expect(recognizeImage(IMAGE, 'eng')).rejects.toThrow('failed');
    expect(await recognizeImage(IMAGE, 'eng')).toMatchObject({ text: 'Hello world' });
  });
  it('reports initialization failures instead of hanging on missing language files', async () => {
    fake.createWorker.mockImplementationOnce((_language: string, _mode: number, options: { errorHandler: (error: unknown) => void }) => {
      queueMicrotask(() => options.errorHandler(new Error('missing model')));
      return new Promise(() => undefined);
    });
    await expect(warmOcr('eng')).rejects.toThrow('OCR 引擎加载失败');
    await warmOcr('eng');
    expect(fake.createWorker).toHaveBeenCalledTimes(2);
  });
  it('releases the worker explicitly and creates a fresh one when next used', async () => {
    await warmOcr('eng'); await disposeOcr(); await warmOcr('eng');
    expect(fake.engine.terminate).toHaveBeenCalledTimes(1);
    expect(fake.createWorker).toHaveBeenCalledTimes(2);
  });
  it('cleans up a worker that finishes loading after initialization already failed', async () => {
    let finishLoading!: (engine: typeof fake.engine) => void;
    fake.createWorker.mockImplementationOnce((_language: string, _mode: number, options: { errorHandler: (error: unknown) => void }) => {
      queueMicrotask(() => options.errorHandler(new Error('model load failed')));
      return new Promise(resolve => { finishLoading = resolve; });
    });
    await expect(warmOcr('eng')).rejects.toThrow('OCR 引擎加载失败');
    finishLoading(fake.engine);
    await Promise.resolve();
    expect(fake.engine.terminate).toHaveBeenCalledTimes(1);
    await warmOcr('eng');
    expect(fake.createWorker).toHaveBeenCalledTimes(2);
  });
  it('stops a running OCR worker and skips aborted jobs waiting in the queue', async () => {
    let signalStarted: () => void = () => undefined;
    const started = new Promise<void>(resolve => { signalStarted = resolve; });
    fake.engine.recognize.mockImplementationOnce(() => { signalStarted(); return new Promise(() => undefined); });
    const firstController = new AbortController();
    const first = recognizeImage(IMAGE, 'eng', undefined, firstController.signal);
    const queuedController = new AbortController();
    const obsolete = recognizeImage(IMAGE, 'eng', undefined, queuedController.signal);
    const checks = [expect(first).rejects.toMatchObject({ name: 'AbortError' }), expect(obsolete).rejects.toMatchObject({ name: 'AbortError' })];
    await started;
    queuedController.abort(); firstController.abort();
    await Promise.all(checks);
    expect(fake.engine.terminate).toHaveBeenCalledTimes(1);
    expect(fake.engine.recognize).toHaveBeenCalledTimes(1);
    expect(await recognizeImage(IMAGE, 'eng')).toMatchObject({ text: 'Hello world' });
    expect(fake.createWorker).toHaveBeenCalledTimes(2);
  });
});
