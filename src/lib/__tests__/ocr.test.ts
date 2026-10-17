import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { disposeOcr, OCR_TIMEOUT_MS, recognizeImage, warmOcr } from '../ocr';

interface Packet { workerId: string; jobId: string; action: string; payload: Record<string, unknown>; }
const IMAGE = 'data:image/png;base64,ZmFrZQ==';
let workers: FakeWorker[] = [];
let respond: (packet: Packet) => unknown | Promise<unknown>;
let decode: () => Promise<void>;
class FakeWorker extends EventTarget {
  readonly requests: Packet[] = [];
  readonly transferCounts: number[] = [];
  terminated = false;
  terminate = vi.fn(() => { this.terminated = true; });
  constructor(readonly url: string) { super(); workers.push(this); }
  postMessage(packet: Packet, transfer: Transferable[] = []) {
    this.transferCounts.push(transfer.length);
    const received = structuredClone(packet, { transfer });
    this.requests.push(received);
    void Promise.resolve().then(() => respond(received)).then(data => this.reply(received, 'resolve', data), error => this.reply(received, 'reject', String(error)));
  }
  private reply(packet: Packet, status: string, data: unknown) {
    const event = new Event('message');
    Object.assign(event, { data: { ...packet, status, data } });
    this.dispatchEvent(event);
  }
}
function actions(action: string): Packet[] { return workers.flatMap(worker => worker.requests).filter(request => request.action === action); }
async function waitForAction(action: string, count = 1) { await vi.waitFor(() => expect(actions(action)).toHaveLength(count), { interval: 1 }); }
beforeEach(async () => {
  await disposeOcr(); workers = [];
  respond = packet => packet.action === 'recognize' ? { text: ' Hello world \n', confidence: 92 } : {};
  decode = () => Promise.resolve();
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('window', { location: { href: 'https://fastdict.example/' } });
  vi.stubGlobal('Image', class { naturalWidth = 1200; naturalHeight = 800; src = ''; decode() { return decode(); } });
});
afterEach(async () => { await disposeOcr(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('owned OCR worker pipeline', () => {
  it('prewarms and reuses the local worker while emitting the expected Tesseract protocol', async () => {
    await warmOcr('eng');
    expect(await recognizeImage(IMAGE, 'eng')).toEqual({ text: 'Hello world', confidence: 92 });
    await recognizeImage(IMAGE, 'eng');
    expect(workers).toHaveLength(1);
    expect(workers[0].url).toBe('https://fastdict.example/ocr/worker.min.js');
    expect(actions('load')[0].payload).toMatchObject({ options: { lstmOnly: true, corePath: 'https://fastdict.example/ocr/core' } });
    expect(actions('loadLanguage')[0].payload).toMatchObject({ langs: ['eng'], options: { langPath: 'https://fastdict.example/ocr/lang', gzip: true, cacheMethod: 'write' } });
    expect(actions('recognize')).toHaveLength(2);
    expect(actions('recognize')[0].payload).toMatchObject({ image: new Uint8Array([102, 97, 107, 101]), output: { text: true } });
    expect(workers[0].transferCounts.filter(count => count > 0)).toEqual([1, 1]);
  });
  it('serializes overlapping requests and preserves their own result', async () => {
    let active = 0, maximum = 0;
    respond = async packet => {
      if (packet.action !== 'recognize') return {};
      active++; maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 2)); active--;
      return { text: String.fromCharCode(...packet.payload.image as Uint8Array), confidence: 90 };
    };
    const results = await Promise.all([recognizeImage('data:image/png;base64,YQ==', 'eng'), recognizeImage('data:image/png;base64,Yg==', 'eng')]);
    expect(results.map(result => result.text)).toEqual(['a', 'b']);
    expect(maximum).toBe(1); expect(workers).toHaveLength(1);
  });
  it.each(['already-aborted', 'aborted-while-queued'])('settles %s work immediately while keeping the active recognition alive', async mode => {
    let finishActive!: (result: { text: string; confidence: number }) => void;
    respond = packet => packet.action === 'recognize' ? new Promise(resolve => { finishActive = resolve; }) : {};
    const active = recognizeImage(IMAGE, 'eng');
    await waitForAction('recognize');
    const controller = new AbortController();
    if (mode === 'already-aborted') controller.abort();
    const queued = recognizeImage(IMAGE, 'eng', undefined, controller.signal);
    const check = expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await check;
    expect(workers[0].terminate).not.toHaveBeenCalled();
    expect(actions('recognize')).toHaveLength(1);
    finishActive({ text: 'active result', confidence: 90 });
    expect(await active).toMatchObject({ text: 'active result' });
    respond = packet => packet.action === 'recognize' ? { text: 'next result', confidence: 90 } : {};
    expect(await recognizeImage(IMAGE, 'eng')).toMatchObject({ text: 'next result' });
    expect(actions('recognize')).toHaveLength(2);
    expect(workers).toHaveLength(1);
  });
  it('loads only the new language before reinitializing the existing worker', async () => {
    await warmOcr('eng');
    await recognizeImage(IMAGE, 'chi_sim+eng');
    await recognizeImage(IMAGE, 'eng+chi_sim+eng');
    expect(workers).toHaveLength(1);
    expect(actions('loadLanguage').map(packet => packet.payload.langs)).toEqual([['eng'], ['chi_sim']]);
    expect(actions('initialize').map(packet => packet.payload.langs)).toEqual(['eng', 'eng+chi_sim']);
  });
  it('rejects unsupported languages and invalid images before spawning a worker', async () => {
    await expect(warmOcr('../../model')).rejects.toThrow('OCR 语言');
    await expect(recognizeImage('https://remote.example/image.png', 'eng')).rejects.toThrow('图片');
    expect(workers).toHaveLength(0);
  });
  it('terminates real owned resources for repeated language failures and then recovers', async () => {
    respond = packet => { if (packet.action === 'loadLanguage') throw new Error('404 or corrupt model'); return {}; };
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(warmOcr('eng')).rejects.toThrow('OCR 引擎加载失败');
      expect(workers.filter(worker => !worker.terminated)).toHaveLength(0);
      expect(workers[attempt].terminate).toHaveBeenCalledTimes(1);
    }
    respond = packet => packet.action === 'recognize' ? { text: 'recovered', confidence: 90 } : {};
    expect(await recognizeImage(IMAGE, 'eng')).toMatchObject({ text: 'recovered' });
  });
  it.each(['load', 'loadLanguage', 'initialize', 'setParameters', 'recognize'])('cancels a permanently pending %s and admits the next screenshot', async action => {
    respond = packet => packet.action === action ? new Promise(() => undefined) : {};
    const controller = new AbortController();
    const pending = recognizeImage(IMAGE, 'eng', undefined, controller.signal);
    const check = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await waitForAction(action);
    controller.abort(); await check;
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
    respond = packet => packet.action === 'recognize' ? { text: 'fresh', confidence: 90 } : {};
    expect(await recognizeImage(IMAGE, 'eng')).toMatchObject({ text: 'fresh' });
    expect(workers).toHaveLength(2);
  });
  it('aborts a pending language switch on the existing worker', async () => {
    await warmOcr('eng');
    respond = packet => packet.action === 'loadLanguage' ? new Promise(() => undefined) : {};
    const controller = new AbortController();
    const pending = recognizeImage(IMAGE, 'chi_sim', undefined, controller.signal);
    const check = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await waitForAction('loadLanguage', 2); controller.abort(); await check;
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
    respond = packet => packet.action === 'recognize' ? { text: 'fresh', confidence: 90 } : {};
    expect(await recognizeImage(IMAGE, 'eng')).toMatchObject({ text: 'fresh' });
  });
  it.each(['load', 'loadLanguage', 'initialize', 'setParameters', 'recognize'])('times out a stalled %s and terminates its native worker', async action => {
    vi.useFakeTimers();
    respond = packet => packet.action === action ? new Promise(() => undefined) : {};
    const pending = recognizeImage(IMAGE, 'eng');
    const check = expect(pending).rejects.toThrow('超时');
    await vi.advanceTimersByTimeAsync(1);
    expect(actions(action)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(OCR_TIMEOUT_MS);
    await check;
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
  });
  it('cancels decoding before a worker is created, then releases the serial queue', async () => {
    decode = () => new Promise(() => undefined);
    const controller = new AbortController();
    const pending = recognizeImage(IMAGE, 'eng', undefined, controller.signal);
    const check = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve(); controller.abort(); await check;
    expect(workers).toHaveLength(0);
    decode = () => Promise.resolve();
    expect(await recognizeImage(IMAGE, 'eng')).toMatchObject({ text: 'Hello world' });
  });
  it('new screenshots preempt an obsolete prewarm instead of queuing behind it', async () => {
    respond = packet => packet.action === 'load' ? new Promise(() => undefined) : {};
    const warming = warmOcr('eng');
    const check = expect(warming).rejects.toMatchObject({ name: 'AbortError' });
    await waitForAction('load');
    respond = packet => packet.action === 'recognize' ? { text: 'urgent', confidence: 90 } : {};
    const next = recognizeImage(IMAGE, 'eng');
    await check;
    expect(await next).toMatchObject({ text: 'urgent' });
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
  });
  it('disposal interrupts active initialization rather than waiting on it', async () => {
    respond = () => new Promise(() => undefined);
    const warming = warmOcr('eng');
    const check = expect(warming).rejects.toMatchObject({ name: 'AbortError' });
    await waitForAction('load'); await disposeOcr(); await check;
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
  });
  it('caller cancellation interrupts prewarming and skips already aborted queued work', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(warmOcr('eng', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(recognizeImage(IMAGE, 'eng', undefined, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(workers).toHaveLength(0);
  });
  it('handles cancellation synchronously triggered by the progress callback before recognition', async () => {
    const controller = new AbortController();
    await expect(recognizeImage(IMAGE, 'eng', () => controller.abort(), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
    expect(actions('recognize')).toHaveLength(0);
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
  });
});
