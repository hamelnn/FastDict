import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AddressInfo, Socket } from 'node:net';

interface ApiRequest {
  source: string;
  authorization?: string;
  body: { model?: string; stream?: boolean; messages?: Array<{ role?: string; content?: string }> };
}
interface HeldStream { response: ServerResponse; closed: boolean; release: () => void; }

let server: Server;
let apiUrl: string;
const connections = new Set<Socket>();
const requests: ApiRequest[] = [];
const heldStreams = new Map<string, HeldStream>();
const fakeKey = 'e2e-private-secret-never-persist';

function delta(response: ServerResponse, text: string): void {
  response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\r\n\r\n`);
}
function finish(response: ServerResponse): void {
  if (response.destroyed || response.writableEnded) return;
  response.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\r\n\r\ndata: [DONE]\r\n\r\n');
}

test.beforeAll(async () => {
  // Exercise the app's real fetch and parser against a local HTTP server.
  // No production path is replaced, and no paid provider or real key is used.
  server = createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Private-Network', 'true');
    if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404); response.end(); return; }
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      let body: ApiRequest['body'];
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ApiRequest['body']; }
      catch { response.writeHead(400); response.end(); return; }
      const source = body.messages?.at(-1)?.content || '';
      requests.push({ source, authorization: request.headers.authorization, body });
      if (source === 'Check rejected key') {
        response.writeHead(401, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: `Invalid API key: ${request.headers.authorization?.replace(/^Bearer /, '')}` } }));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform' });
      response.flushHeaders();
      if (source === 'Stream slowly' || source === 'Old request') {
        delta(response, source === 'Stream slowly' ? '第一段' : '旧译');
        const held: HeldStream = {
          response, closed: false,
          release: () => {
            if (response.destroyed || response.writableEnded) return;
            delta(response, source === 'Stream slowly' ? '，实时呈现。' : '，过期结果。');
            finish(response);
          },
        };
        response.once('close', () => { held.closed = true; });
        heldStreams.set(source, held);
        return;
      }
      delta(response, source === 'New request' ? '新译完成。' : /hello world/i.test(source) ? '你好，世界。' : '翻译已完成。');
      finish(response);
    });
  });
  server.on('connection', socket => { connections.add(socket); socket.once('close', () => connections.delete(socket)); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

test.beforeEach(async ({ page }) => {
  requests.length = 0;
  heldStreams.clear();
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: '待翻译文本' })).toBeVisible();
});

test.afterAll(async () => {
  for (const held of heldStreams.values()) held.response.destroy();
  for (const connection of connections) connection.destroy();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

async function navigate(page: Page, destination: '即时翻译' | '偏好设置' | '翻译记录'): Promise<void> {
  if ((page.viewportSize()?.width || 1120) < 680) await page.getByRole('button', { name: '打开菜单', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(`^${destination}`) }).click();
}

async function configureLocalApi(page: Page, name = '本机测试模型', key?: string): Promise<void> {
  await navigate(page, '偏好设置');
  await page.getByRole('button', { name: '添加服务', exact: true }).click();
  await page.getByRole('dialog', { name: '添加翻译服务', exact: true }).getByRole('button', { name: /本地 Ollama/ }).click();
  const dialog = page.getByRole('dialog', { name: 'API 服务配置', exact: true });
  await dialog.getByLabel('服务名称', { exact: true }).fill(name);
  await dialog.getByLabel(/^API 地址/).fill(apiUrl);
  await dialog.getByLabel('模型名称', { exact: true }).fill('e2e-translator');
  if (key) await dialog.getByPlaceholder('粘贴你的 API Key').fill(key);
  await dialog.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(dialog).toBeHidden();
  await navigate(page, '即时翻译');
  await expect(page.getByLabel('翻译服务', { exact: true })).toHaveValue(/.+/);
  await expect(page.getByLabel('翻译服务', { exact: true })).toContainText(name);
}

async function screenshot(page: Page, info: TestInfo, name: string): Promise<void> {
  await expect(page.getByRole('status')).toBeHidden({ timeout: 5000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  const path = info.outputPath(name);
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  await info.attach(name, { path, contentType: 'image/png' });
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({ width: window.innerWidth, scroll: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width + 1);
}

test('first launch has zero services and choosing a template does not save until confirmed', async ({ page }) => {
  const guide = page.getByRole('region', { name: '添加翻译服务引导' });
  await expect(guide.getByRole('heading', { name: '配置翻译服务后开始' })).toBeVisible();
  await expect(page.locator('.provider-row')).toHaveCount(0);
  await expect(page.getByLabel('翻译服务', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('翻译服务', { exact: true })).toContainText('请先添加服务');
  expect(await page.evaluate(() => localStorage.getItem('fastdict.v1.providers'))).toBeNull();
  await mkdir(resolve('native-test-results'), { recursive: true });
  await page.screenshot({ path: resolve('native-test-results/fastlingo-onboarding.png'), fullPage: true });
  await guide.getByRole('button', { name: '添加翻译服务', exact: true }).click();
  await page.getByRole('dialog', { name: '添加翻译服务', exact: true }).getByRole('button', { name: /本地 Ollama/ }).click();
  const editor = page.getByRole('dialog', { name: 'API 服务配置', exact: true });
  await expect(editor).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('fastdict.v1.providers'))).toBeNull();
  await editor.getByRole('button', { name: '取消', exact: true }).click();
  await page.reload();
  await expect(guide).toBeVisible();
  await expect(page.locator('.provider-row')).toHaveCount(0);
  await navigate(page, '偏好设置');
  await page.getByRole('button', { name: '高级设置', exact: true }).click();
  const desktop = page.getByRole('region', { name: '桌面行为' });
  await expect(desktop.getByLabel('关闭主窗口时', { exact: true })).toBeDisabled();
  await expect(desktop.getByRole('switch', { name: '开机启动', exact: true })).toBeDisabled();
  expect(requests).toEqual([]);
});

test('removing the last explicitly configured service returns to onboarding after reload', async ({ page }) => {
  await configureLocalApi(page);
  await expect(page.getByRole('region', { name: '添加翻译服务引导' })).toHaveCount(0);
  await navigate(page, '偏好设置');
  await page.locator('.settings-provider').filter({ hasText: '本机测试模型' }).click();
  const editor = page.getByRole('dialog', { name: 'API 服务配置', exact: true });
  await editor.getByRole('button', { name: '移除服务', exact: true }).click();
  await editor.getByRole('button', { name: '确认移除', exact: true }).click();
  await expect(editor).toBeHidden();
  await expect(page.locator('.settings-provider')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('region', { name: '添加翻译服务引导' })).toBeVisible();
  await expect(page.locator('.provider-row')).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('fastdict.v1.configuration')!).providers)).toEqual([]);
  expect(requests).toEqual([]);
});

test('configures a keyless local API, renders streamed text immediately, and restores history', async ({ page }, info) => {
  await configureLocalApi(page);
  await page.getByRole('textbox', { name: '待翻译文本' }).fill('Stream slowly');
  await page.getByRole('button', { name: '翻译', exact: true }).click();
  const output = page.locator('.translation-output');
  await expect(output).toHaveText('第一段');
  // The HTTP response is deliberately still open: this proves first-token rendering.
  await expect(page.getByRole('button', { name: '停止', exact: true })).toBeVisible();
  expect(heldStreams.get('Stream slowly')?.closed).toBe(false);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('fastdict.v1.history') || '[]').length)).toBe(0);
  expect(requests[0].authorization).toBeUndefined();
  expect(requests[0].body).toMatchObject({ model: 'e2e-translator', stream: true });
  expect(requests[0].body.messages?.[0].content).toContain('zh-CN');

  heldStreams.get('Stream slowly')!.release();
  await expect(output).toHaveText('第一段，实时呈现。');
  await expect(page.getByRole('button', { name: '停止', exact: true })).toBeHidden();
  await expect(page.getByText(/已完成 ·/)).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await screenshot(page, info, 'desktop-1120.png');

  await page.reload();
  await navigate(page, '翻译记录');
  const card = page.locator('.history-card');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('Stream slowly');
  await expect(card).toContainText('第一段，实时呈现。');
  await card.getByRole('button', { name: /^查看/ }).click();
  await expect(page.getByRole('textbox', { name: '待翻译文本' })).toHaveValue('Stream slowly');
  await expect(page.locator('.translation-output')).toHaveText('第一段，实时呈现。');
  await expect(page.getByLabel('目标语言', { exact: true })).toHaveValue('zh-CN');
});

test('keyboard cancellation closes the old stream and preserves the newer result', async ({ page }) => {
  await configureLocalApi(page);
  const source = page.getByRole('textbox', { name: '待翻译文本' });
  await source.fill('Old request');
  await source.press('Control+Enter');
  await expect(page.locator('.translation-output')).toHaveText('旧译');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '停止', exact: true })).toBeHidden();
  await expect.poll(() => heldStreams.get('Old request')?.closed).toBe(true);
  await source.fill('New request');
  await source.press('Control+Enter');
  await expect(page.locator('.translation-output')).toHaveText('新译完成。');
  await expect(page.getByText(/已完成 ·/)).toBeVisible();
  heldStreams.get('Old request')!.release();
  await navigate(page, '翻译记录');
  await expect(page.locator('.history-card')).toHaveCount(1);
  await expect(page.locator('.history-card')).toContainText('New request');
  await expect(page.locator('.history-card')).not.toContainText('Old request');
  await page.locator('.history-card').getByRole('button', { name: /^查看/ }).click();
  await expect(page.locator('.translation-output')).toHaveText('新译完成。');
});

test('shows HTTP 401 errors with key redaction and keeps keys out of persistent browser storage', async ({ page }) => {
  await configureLocalApi(page, '私有测试 API', fakeKey);
  await page.getByRole('textbox', { name: '待翻译文本' }).fill('Check rejected key');
  await page.getByRole('button', { name: '翻译', exact: true }).click();
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('401');
  await expect(alert).toContainText('[已隐藏]');
  await expect(alert).not.toContainText(fakeKey);
  expect(requests[0].authorization).toBe(`Bearer ${fakeKey}`);
  const stored = await page.evaluate(() => Object.values(localStorage).join('\n'));
  expect(stored).not.toContain(fakeKey);
  await page.reload();
  await navigate(page, '偏好设置');
  // The local server remains usable without a key; the browser session secret
  // must still be absent after reload, independently of that readiness label.
  const provider = page.locator('.settings-provider').filter({ hasText: '私有测试 API' });
  await expect(provider).toContainText('已配置');
  await provider.click();
  const editor = page.getByRole('dialog', { name: 'API 服务配置', exact: true });
  await expect(editor.getByPlaceholder('粘贴你的 API Key')).toHaveValue('');
  await editor.getByRole('button', { name: '取消', exact: true }).click();
  await navigate(page, '即时翻译');
  await page.getByRole('textbox', { name: '待翻译文本' }).fill('Hello world');
  await page.getByRole('button', { name: '翻译', exact: true }).click();
  await expect(page.locator('.translation-output')).toHaveText('你好，世界。');
  expect(requests.at(-1)?.authorization).toBeUndefined();
});

test('persists translation locale, OCR language and automatic translation choices after reload', async ({ page }) => {
  await page.getByLabel('源语言', { exact: true }).selectOption('en');
  await page.getByLabel('目标语言', { exact: true }).selectOption('ja');
  await navigate(page, '偏好设置');
  await page.getByRole('button', { name: '高级设置', exact: true }).click();
  await page.getByLabel('OCR 识别语言', { exact: true }).selectOption('eng+chi_sim');
  await page.getByRole('button', { name: '返回设置', exact: true }).click();
  await page.getByRole('switch', { name: '粘贴与导入后自动翻译', exact: true }).click();
  await page.reload();
  await expect(page.getByLabel('源语言', { exact: true })).toHaveValue('en');
  await expect(page.getByLabel('目标语言', { exact: true })).toHaveValue('ja');
  await navigate(page, '偏好设置');
  await expect(page.getByRole('switch', { name: '粘贴与导入后自动翻译', exact: true })).toHaveAttribute('aria-checked', 'false');
  await page.getByRole('button', { name: '高级设置', exact: true }).click();
  await expect(page.getByLabel('OCR 识别语言', { exact: true })).toHaveValue('eng+chi_sim');
});

test('recognizes a real PNG using packaged Tesseract WASM and automatically translates its text', async ({ page }, info) => {
  const ocrRequests: string[] = [];
  const pageErrors: string[] = [];
  page.on('request', request => { if (request.url().includes('/ocr/')) ocrRequests.push(request.url()); });
  page.on('pageerror', error => pageErrors.push(error.message));
  await configureLocalApi(page);
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 960; canvas.height = 220;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#000000'; context.font = '80px Arial'; context.fillText('Hello world', 40, 135);
    return canvas.toDataURL('image/png');
  });
  await page.locator('input[type="file"]').setInputFiles({ name: 'hello-world.png', mimeType: 'image/png', buffer: Buffer.from(dataUrl.split(',')[1], 'base64') });
  await expect(page.getByRole('textbox', { name: '待翻译文本' })).toHaveValue(/hello world/i, { timeout: 60_000 });
  await expect(page.locator('.translation-output')).toHaveText('你好，世界。');
  await expect(page.getByText(/识别置信度 \d+%/)).toBeVisible();
  expect(requests.at(-1)?.source).toMatch(/hello world/i);
  expect(requests.at(-1)?.source).not.toContain('data:image');
  expect(ocrRequests.some(url => url.endsWith('/ocr/worker.min.js'))).toBe(true);
  expect(ocrRequests.some(url => /\/ocr\/core\/tesseract-core-(?:simd-)?lstm\.wasm\.js$/.test(url))).toBe(true);
  expect(ocrRequests.some(url => url.endsWith('/ocr/lang/eng.traineddata.gz'))).toBe(true);
  expect(ocrRequests.every(url => url.startsWith('http://127.0.0.1:1420/ocr/'))).toBe(true);
  expect(pageErrors).toEqual([]);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('fastdict.v1.history') || '[]')[0]?.input)).toBe('image');
  await expectNoHorizontalOverflow(page);
  await screenshot(page, info, 'real-ocr.png');
});

test('captures a display frame, crops scaled pixel coordinates and recognizes only the selected region', async ({ page }, info) => {
  await page.addInitScript(() => {
    // The fixture supplies a real video MediaStream; capture, scaling, cropping,
    // local OCR and API transport all run through the production UI.
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, value: async () => {
      const canvas = document.createElement('canvas'); canvas.width = 1400; canvas.height = 975;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#000000'; context.font = '80px Arial'; context.fillText('Hello world', 400, 430);
      context.fillText('OUTSIDE REGION', 40, 820);
      const stream = canvas.captureStream(1);
      (window as unknown as { e2eCaptureTrack: MediaStreamTrack }).e2eCaptureTrack = stream.getVideoTracks()[0];
      setTimeout(() => { context.fillStyle = '#ffffff'; context.fillRect(0, 0, 1, 1); }, 0);
      return stream;
    } });
  });
  await page.reload();
  await configureLocalApi(page);
  await navigate(page, '偏好设置');
  await page.getByRole('switch', { name: '粘贴与导入后自动翻译', exact: true }).click();
  await expect(page.getByRole('switch', { name: '粘贴与导入后自动翻译', exact: true })).toHaveAttribute('aria-checked', 'false');
  await navigate(page, '即时翻译');
  await page.getByRole('button', { name: '浏览器截图体验', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '选择截图区域', exact: true });
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { e2eCaptureTrack: MediaStreamTrack }).e2eCaptureTrack.readyState)).toBe('ended');
  const bounds = await dialog.getByRole('img', { name: '待选择的屏幕截图', exact: true }).boundingBox();
  expect(bounds).not.toBeNull();
  const image = bounds!;
  const sx = image.width / 1400, sy = image.height / 975;
  await page.mouse.move(image.x + 330 * sx, image.y + 320 * sy);
  await page.mouse.down();
  await page.mouse.move(image.x + 1080 * sx, image.y + 520 * sy, { steps: 10 });
  await page.mouse.up();
  await expect(dialog.getByRole('button', { name: '翻译选区', exact: true })).toBeEnabled();
  await screenshot(page, info, 'crop-selection.png');
  await dialog.getByRole('button', { name: '翻译选区', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('textbox', { name: '待翻译文本' })).toHaveValue(/hello world/i, { timeout: 60_000 });
  await expect(page.getByRole('textbox', { name: '待翻译文本' })).not.toHaveValue(/outside region/i);
  await expect(page.locator('.translation-output')).toHaveText('你好，世界。');
  const cropped = await page.getByRole('img', { name: '识别图片', exact: true }).evaluate((element: HTMLImageElement) => ({ width: element.naturalWidth, height: element.naturalHeight }));
  expect(Math.abs(cropped.width - 750)).toBeLessThanOrEqual(2);
  expect(Math.abs(cropped.height - 200)).toBeLessThanOrEqual(2);
  expect(requests.at(-1)?.source).not.toMatch(/outside region/i);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('fastdict.v1.configuration')!).preferences.autoTranslate)).toBe(false);
});

test.describe('mobile viewport', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test('supports provider settings, translation and sidebar navigation without horizontal overflow', async ({ page }, info) => {
    await configureLocalApi(page, '移动端本机模型');
    await page.getByRole('textbox', { name: '待翻译文本' }).fill('Hello world');
    await page.getByRole('button', { name: '翻译', exact: true }).click();
    await expect(page.locator('.translation-output')).toHaveText('你好，世界。');
    await expect(page.getByText(/已完成 ·/)).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await screenshot(page, info, 'mobile-390.png');
    await navigate(page, '翻译记录');
    await expect(page.locator('.history-card')).toContainText('Hello world');
    await expectNoHorizontalOverflow(page);
  });
});

interface NativeCaptureCall { command: string; args: Record<string, unknown>; }
interface NativeCaptureTestState {
  calls: NativeCaptureCall[];
  screenSharingAttempts: number;
  emit: (event: string, payload: unknown) => void;
  resolveFinish: (sessionId: number) => void;
  rejectCancel: (sessionId: number) => void;
  holdImageDecode: () => void;
  releaseImageDecode: () => void;
  pendingImageDecodes: () => number;
}

async function installNativeCaptureMock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const canvas = document.createElement('canvas'); canvas.width = 1920; canvas.height = 1080;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#000000'; context.font = '72px Arial'; context.fillText('Hello world', 400, 430);
    const dataUrl = canvas.toDataURL('image/png');
    const callbacks = new Map<number, (event: unknown) => void>();
    const listeners = new Map<string, Set<number>>();
    const finishResolvers = new Map<number, () => void>();
    const cancelRejectors = new Map<number, (error: Error) => void>();
    const decodeResolvers: Array<() => void> = [];
    let imageDecodeHeld = false;
    const decodeImage = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = async function () {
      await decodeImage.call(this);
      if (imageDecodeHeld && this.alt === '待选择的屏幕截图') {
        await new Promise<void>(resolve => { decodeResolvers.push(resolve); });
      }
    };
    let nextCallback = 1;
    let activeSessionId = 0;
    const state: NativeCaptureTestState = {
      calls: [], screenSharingAttempts: 0,
      emit: (event, payload) => {
        if (event === 'fastdict://capture-start') activeSessionId = (payload as { sessionId: number }).sessionId;
        for (const id of listeners.get(event) || []) callbacks.get(id)?.({ event, id, payload });
      },
      resolveFinish: sessionId => finishResolvers.get(sessionId)?.(),
      rejectCancel: sessionId => cancelRejectors.get(sessionId)?.(new Error('Old capture cancellation failed')),
      holdImageDecode: () => { imageDecodeHeld = true; },
      releaseImageDecode: () => {
        imageDecodeHeld = false;
        decodeResolvers.splice(0).forEach(resolve => resolve());
      },
      pendingImageDecodes: () => decodeResolvers.length,
    };
    const internals = {
      metadata: { currentWindow: { label: 'capture' }, currentWebview: { label: 'capture' } },
      transformCallback: (callback: (event: unknown) => void) => { const id = nextCallback++; callbacks.set(id, callback); return id; },
      unregisterCallback: (id: number) => { callbacks.delete(id); },
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        state.calls.push({ command, args: { ...args } });
        if (command === 'plugin:event|listen') {
          const event = args.event as string, id = args.handler as number;
          if (!listeners.has(event)) listeners.set(event, new Set());
          listeners.get(event)!.add(id);
          return id;
        }
        if (command === 'plugin:event|unlisten') { listeners.get(args.event as string)?.delete(args.eventId as number); return; }
        if (command === 'capture_overlay_ready' || command === 'capture_ready') return;
        if (command === 'get_capture') {
          if (args.sessionId !== activeSessionId) throw new Error('Screenshot requested for the wrong capture session');
          return { dataUrl, width: 1920, height: 1080, sessionId: activeSessionId };
        }
        if (command === 'finish_capture') return new Promise<void>(resolve => { finishResolvers.set(args.sessionId as number, resolve); });
        if (command === 'cancel_capture') return new Promise<void>((_, reject) => { cancelRejectors.set(args.sessionId as number, reject); });
        throw new Error(`Unexpected native IPC command in capture test: ${command}`);
      },
    };
    Object.assign(window, {
      e2eNativeCapture: state,
      __TAURI_INTERNALS__: internals,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: (event: string, id: number) => { listeners.get(event)?.delete(id); callbacks.delete(id); } },
    });
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, value: () => {
      state.screenSharingAttempts++;
      throw new Error('Native capture must never open browser screen sharing');
    } });
  });
}

async function nativeCalls(page: Page, command: string): Promise<NativeCaptureCall[]> {
  return page.evaluate(command => (window as unknown as { e2eNativeCapture: NativeCaptureTestState }).e2eNativeCapture.calls.filter(call => call.command === command), command);
}

async function beginNativeSession(page: Page, sessionId = 41): Promise<void> {
  await page.evaluate(sessionId => (window as unknown as { e2eNativeCapture: NativeCaptureTestState }).e2eNativeCapture.emit('fastdict://capture-start', { sessionId }), sessionId);
  await expect(page.getByRole('img', { name: '待选择的屏幕截图', exact: true })).toBeVisible();
  await expect.poll(async () => (await nativeCalls(page, 'capture_ready')).filter(call => call.args.sessionId === sessionId).length).toBe(1);
}

async function openNativeCapture(page: Page): Promise<void> {
  await page.goto('/?capture=1');
  await expect.poll(async () => (await nativeCalls(page, 'capture_overlay_ready')).length).toBeGreaterThan(0);
  expect(await nativeCalls(page, 'get_capture')).toHaveLength(0);
  await beginNativeSession(page);
}

async function dragRegion(page: Page, start: { x: number; y: number }, end: { x: number; y: number }): Promise<void> {
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 5 });
  await page.mouse.up();
}

test.describe('native capture frontend', () => {
  // 1920 physical pixels at 125% Windows scaling are 1536 CSS pixels.
  test.use({ viewport: { width: 1536, height: 864 }, deviceScaleFactor: 1.25 });

  test('submits exactly once on mouse release at 125% scale without browser sharing or extra confirmation', async ({ page }, info) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await installNativeCaptureMock(page);
    await openNativeCapture(page);
    await expect(page.getByRole('button', { name: '翻译选区', exact: true })).toHaveCount(0);
    const bounds = await page.getByRole('img', { name: '待选择的屏幕截图', exact: true }).boundingBox();
    expect(bounds).toMatchObject({ x: 0, y: 0, width: 1536, height: 864 });
    await dragRegion(page, { x: 240, y: 180 }, { x: 800, y: 480 });
    await expect.poll(async () => (await nativeCalls(page, 'finish_capture')).length).toBe(1);
    expect((await nativeCalls(page, 'finish_capture'))[0].args).toMatchObject({ sessionId: 41, x: 300, y: 225, width: 700, height: 375 });
    // The backend promise remains pending, exposing duplicate keyboard/drag races.
    await page.keyboard.press('Enter'); await page.keyboard.press('Enter'); await page.keyboard.press('Escape');
    await dragRegion(page, { x: 300, y: 300 }, { x: 900, y: 600 });
    expect(await nativeCalls(page, 'finish_capture')).toHaveLength(1);
    expect(await nativeCalls(page, 'cancel_capture')).toHaveLength(0);
    expect(await page.evaluate(() => (window as unknown as { e2eNativeCapture: NativeCaptureTestState }).e2eNativeCapture.screenSharingAttempts)).toBe(0);
    expect(errors).toEqual([]);
    await screenshot(page, info, 'native-capture-125-percent.png');
  });

  test('clamps crop coordinates at both screen edges including a reverse drag outside the viewport', async ({ page }) => {
    await installNativeCaptureMock(page);
    const cases = [
      { start: { x: 1480, y: 820 }, end: { x: 1660, y: 980 }, expected: { x: 1850, y: 1025, width: 70, height: 55 } },
      { start: { x: 80, y: 100 }, end: { x: -30, y: -40 }, expected: { x: 0, y: 0, width: 100, height: 125 } },
    ];
    for (const scenario of cases) {
      await openNativeCapture(page);
      await dragRegion(page, scenario.start, scenario.end);
      await expect.poll(async () => (await nativeCalls(page, 'finish_capture')).length).toBe(1);
      const rect = (await nativeCalls(page, 'finish_capture'))[0].args;
      expect(rect).toMatchObject({ sessionId: 41, ...scenario.expected });
      expect(Number(rect.x) + Number(rect.width)).toBeLessThanOrEqual(1920);
      expect(Number(rect.y) + Number(rect.height)).toBeLessThanOrEqual(1080);
    }
  });

  test('ignores tiny selections and Escape cancels once without submitting the subsequent mouse release', async ({ page }) => {
    await installNativeCaptureMock(page);
    await openNativeCapture(page);
    await dragRegion(page, { x: 200, y: 200 }, { x: 203, y: 203 });
    expect(await nativeCalls(page, 'finish_capture')).toHaveLength(0);
    await page.mouse.move(300, 300); await page.mouse.down(); await page.mouse.move(700, 500, { steps: 5 });
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await nativeCalls(page, 'cancel_capture')).length).toBe(1);
    await page.mouse.up(); await page.keyboard.press('Escape'); await page.keyboard.press('Enter');
    expect((await nativeCalls(page, 'cancel_capture'))[0].args).toMatchObject({ sessionId: 41 });
    expect(await nativeCalls(page, 'cancel_capture')).toHaveLength(1);
    expect(await nativeCalls(page, 'finish_capture')).toHaveLength(0);
  });

  test('reuses the preloaded overlay and a stale completion cannot clear a newer capture session', async ({ page }) => {
    await installNativeCaptureMock(page);
    await openNativeCapture(page);
    await dragRegion(page, { x: 240, y: 180 }, { x: 800, y: 480 });
    await expect.poll(async () => (await nativeCalls(page, 'finish_capture')).length).toBe(1);
    await page.evaluate(() => (window as unknown as { e2eNativeCapture: NativeCaptureTestState }).e2eNativeCapture.emit('fastdict://capture-reset', { sessionId: 41 }));
    await beginNativeSession(page, 42);
    await page.evaluate(() => (window as unknown as { e2eNativeCapture: NativeCaptureTestState }).e2eNativeCapture.resolveFinish(41));
    await expect(page.getByRole('img', { name: '待选择的屏幕截图', exact: true })).toBeVisible();
    await dragRegion(page, { x: 160, y: 160 }, { x: 640, y: 400 });
    await expect.poll(async () => (await nativeCalls(page, 'finish_capture')).length).toBe(2);
    expect((await nativeCalls(page, 'finish_capture')).map(call => call.args.sessionId)).toEqual([41, 42]);
    expect((await nativeCalls(page, 'get_capture')).map(call => call.args.sessionId)).toEqual([41, 42]);
  });

  test('ignores an old cancellation failure after the next capture session is ready', async ({ page }) => {
    await installNativeCaptureMock(page);
    await openNativeCapture(page);
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await nativeCalls(page, 'cancel_capture')).length).toBe(1);
    await page.evaluate(() => (window as unknown as { e2eNativeCapture: NativeCaptureTestState }).e2eNativeCapture.emit('fastdict://capture-reset', { sessionId: 41 }));
    await beginNativeSession(page, 42);
    await page.evaluate(() => (window as unknown as { e2eNativeCapture: NativeCaptureTestState }).e2eNativeCapture.rejectCancel(41));
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('img', { name: '待选择的屏幕截图', exact: true })).toBeVisible();
    await dragRegion(page, { x: 160, y: 160 }, { x: 640, y: 400 });
    await expect.poll(async () => (await nativeCalls(page, 'finish_capture')).length).toBe(1);
    expect((await nativeCalls(page, 'finish_capture'))[0].args).toMatchObject({ sessionId: 42, x: 200, y: 200, width: 600, height: 300 });
  });

  test('never announces a reset session after its delayed image decode completes', async ({ page }) => {
    await installNativeCaptureMock(page);
    await page.goto('/?capture=1');
    await expect.poll(async () => (await nativeCalls(page, 'capture_overlay_ready')).length).toBeGreaterThan(0);
    await page.evaluate(() => {
      const state = (window as unknown as { e2eNativeCapture: NativeCaptureTestState }).e2eNativeCapture;
      state.holdImageDecode();
      state.emit('fastdict://capture-start', { sessionId: 41 });
    });
    await expect.poll(() => page.evaluate(() => (window as unknown as { e2eNativeCapture: NativeCaptureTestState }).e2eNativeCapture.pendingImageDecodes())).toBeGreaterThan(0);
    expect(await nativeCalls(page, 'capture_ready')).toHaveLength(0);
    await page.evaluate(() => (window as unknown as { e2eNativeCapture: NativeCaptureTestState }).e2eNativeCapture.emit('fastdict://capture-reset', { sessionId: 41 }));
    await expect(page.locator('.capture-standby')).toHaveCount(1);
    await expect(page.getByRole('img', { name: '待选择的屏幕截图', exact: true })).toHaveCount(0);
    await page.evaluate(() => (window as unknown as { e2eNativeCapture: NativeCaptureTestState }).e2eNativeCapture.releaseImageDecode());
    // Observe beyond the readiness timer (40 ms) as well as a normal paint cycle.
    await page.waitForTimeout(120);
    expect(await nativeCalls(page, 'capture_ready')).toHaveLength(0);
    await expect(page.locator('.capture-standby')).toHaveCount(1);
    await beginNativeSession(page, 42);
    expect((await nativeCalls(page, 'capture_ready')).map(call => call.args.sessionId)).toEqual([42]);
  });

  test('announces readiness only once through duplicate starts, selection updates and submission', async ({ page }) => {
    await installNativeCaptureMock(page);
    await openNativeCapture(page);
    await page.evaluate(() => (window as unknown as { e2eNativeCapture: NativeCaptureTestState }).e2eNativeCapture.emit('fastdict://capture-start', { sessionId: 41 }));
    await dragRegion(page, { x: 200, y: 200 }, { x: 203, y: 203 });
    await dragRegion(page, { x: 240, y: 180 }, { x: 800, y: 480 });
    await expect.poll(async () => (await nativeCalls(page, 'finish_capture')).length).toBe(1);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    await dragRegion(page, { x: 300, y: 300 }, { x: 900, y: 600 });
    // A callback accidentally recreated by selection/submission renders would
    // restart decode and announce ready again after its paint/timer fallback.
    await page.waitForTimeout(120);
    expect((await nativeCalls(page, 'capture_ready')).map(call => call.args.sessionId)).toEqual([41]);
    expect(await nativeCalls(page, 'get_capture')).toHaveLength(1);
    expect(await nativeCalls(page, 'finish_capture')).toHaveLength(1);
    expect(await nativeCalls(page, 'cancel_capture')).toHaveLength(0);
  });

  test('keeps the reset overlay empty after late finish and cancellation settlements', async ({ page }) => {
    await installNativeCaptureMock(page);
    await openNativeCapture(page);
    await dragRegion(page, { x: 240, y: 180 }, { x: 800, y: 480 });
    await expect.poll(async () => (await nativeCalls(page, 'finish_capture')).length).toBe(1);
    await page.evaluate(() => (window as unknown as { e2eNativeCapture: NativeCaptureTestState }).e2eNativeCapture.emit('fastdict://capture-reset', { sessionId: 41 }));
    await expect(page.locator('.capture-standby')).toHaveCount(1);
    await page.evaluate(() => (window as unknown as { e2eNativeCapture: NativeCaptureTestState }).e2eNativeCapture.resolveFinish(41));
    await expect(page.getByRole('dialog', { name: '选择截图区域' })).toHaveCount(0);
    await expect(page.getByRole('img', { name: '待选择的屏幕截图', exact: true })).toHaveCount(0);

    await beginNativeSession(page, 42);
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await nativeCalls(page, 'cancel_capture')).length).toBe(1);
    await page.evaluate(() => (window as unknown as { e2eNativeCapture: NativeCaptureTestState }).e2eNativeCapture.emit('fastdict://capture-reset', { sessionId: 42 }));
    await expect(page.locator('.capture-standby')).toHaveCount(1);
    await page.evaluate(() => (window as unknown as { e2eNativeCapture: NativeCaptureTestState }).e2eNativeCapture.rejectCancel(42));
    await page.waitForTimeout(120);
    await expect(page.locator('.capture-standby')).toHaveCount(1);
    await expect(page.getByRole('dialog', { name: '选择截图区域' })).toHaveCount(0);
    await expect(page.getByRole('img', { name: '待选择的屏幕截图', exact: true })).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect((await nativeCalls(page, 'capture_ready')).map(call => call.args.sessionId)).toEqual([41, 42]);
    // DOM reset is only the frontend contract. Native HWND visibility needs the
    // separate Windows smoke test; this mock deliberately makes no such claim.
  });
});
