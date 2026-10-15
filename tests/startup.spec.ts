import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative, sep, extname } from 'node:path';

const productionOrigin = 'http://tauri.localhost';
const injectedError = 'e2e-secret-value-must-never-appear-in-recovery';
const stages = new Set(['bootstrap-start', 'bootstrap-import-failed', 'react-render-failed', 'storage-read-failed', 'storage-write-failed', 'unhandled-error', 'unhandled-rejection', 'bootstrap-timeout']);
type BootFault = 'none' | 'app-import' | 'react-render' | 'react-effect' | 'app-html' | 'old-entry';
type StorageFault = 'none' | 'getter-denied' | 'quota';
interface BootCall { command: string; args: Record<string, unknown>; }
interface BootTestState { calls: BootCall[]; writes: Array<{ key: string; value: string }>; rawRead: (key: string) => string | null; }
interface ProductionResponse { path: string; status: number; contentType: string; }
let assets: Map<string, Buffer>;
let productionHtml: string;
let productionCsp: string;
let appPath: string;
let entryPath: string;

const savedProfile: Record<string, string> = {
  'fastdict.v1.preferences': JSON.stringify({ sourceLang: 'en', targetLang: 'ja', ocrLang: 'eng', autoTranslate: false, activeProviderId: 'restored-local', futureSetting: 'preserve-until-edited' }),
  'fastdict.v1.providers': JSON.stringify([{ id: 'restored-local', name: 'Saved local model', kind: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'e2e-local', hasKey: false, futureField: 'preserve-until-edited' }]),
  'fastdict.v1.history': JSON.stringify([{ id: 'retained-1', source: 'Existing source', translation: '原有译文', sourceLang: 'en', targetLang: 'ja', providerName: 'Saved local model', createdAt: 1_600_000_000_000, durationMs: 100, input: 'text' }]),
};

test.beforeAll(async () => {
  const directory = resolve('dist');
  assets = new Map();
  async function snapshot(folder: string): Promise<void> {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = resolve(folder, entry.name);
      if (entry.isDirectory()) await snapshot(path);
      else assets.set(relative(directory, path).split(sep).join('/'), await readFile(path));
    }
  }
  await snapshot(directory);
  productionHtml = assets.get('index.html')!.toString('utf8');
  if (!productionHtml.includes('fastdict-boot-error')) throw new Error('Startup regressions require current production assets. Run npm run build first.');
  const config = JSON.parse(await readFile(resolve('src-tauri/tauri.conf.json'), 'utf8'));
  const inlineHashes = [...productionHtml.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(match => !/\bsrc\s*=/.test(match[1]))
    .map(match => `'sha256-${createHash('sha256').update(match[2].replace(/\r\n?/g, '\n')).digest('base64')}'`);
  // Tauri injects hashes for inline recovery scripts during asset embedding.
  // Retain its real production CSP, rather than weakening it for the browser fixture.
  productionCsp = (config.app.security.csp as string).split(';').map(directive => directive.trim().startsWith('script-src') ? `${directive} ${inlineHashes.join(' ')}` : directive).join(';');
  appPath = [...assets.keys()].find(path => /^assets\/App-[\w-]+\.js$/.test(path))!;
  entryPath = productionHtml.match(/<script[^>]*type="module"[^>]*src="([^"]+)"/)![1].replace(/^\//, '');
  expect(appPath).toBeTruthy(); expect(assets.has(entryPath)).toBe(true);
});

async function installEnvironment(page: Page, storageFault: StorageFault = 'none', seed: Record<string, string> = {}): Promise<void> {
  await page.addInitScript(({ storageFault, seed }) => {
    const store = window.localStorage;
    const originalRead = Storage.prototype.getItem;
    const originalWrite = Storage.prototype.setItem;
    const callbacks = new Map<number, (event: unknown) => void>();
    const listeners = new Map<string, Set<number>>();
    let nextId = 1;
    const state: BootTestState = {
      calls: [], writes: [],
      rawRead: key => originalRead.call(store, key),
    };
    for (const [key, value] of Object.entries(seed)) originalWrite.call(store, key, value);
    Storage.prototype.setItem = function (key: string, value: string) {
      state.writes.push({ key, value });
      if (storageFault === 'quota') throw new DOMException('Synthetic quota error', 'QuotaExceededError');
      originalWrite.call(this, key, value);
    };
    if (storageFault === 'getter-denied') Object.defineProperty(window, 'localStorage', { configurable: true, get: () => { throw new DOMException('Synthetic storage denial', 'SecurityError'); } });
    Object.assign(window, {
      e2eBoot: state,
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
        transformCallback: (callback: (event: unknown) => void) => { const id = nextId++; callbacks.set(id, callback); return id; },
        unregisterCallback: (id: number) => { callbacks.delete(id); },
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          state.calls.push({ command, args: { ...args } });
          if (command === 'plugin:event|listen') {
            const event = args.event as string, id = args.handler as number;
            if (!listeners.has(event)) listeners.set(event, new Set());
            listeners.get(event)!.add(id); return id;
          }
          if (command === 'plugin:event|unlisten') { listeners.get(args.event as string)?.delete(args.eventId as number); return; }
          if (command === 'get_api_key') return null;
          if (command === 'get_desktop_preferences') return { closeAction: 'quit', launchAtLogin: false, trayAvailable: true, autostartAvailable: true };
          if (command === 'get_shortcut_status') return { captureShortcut: 'Ctrl+Shift+S', clipboardShortcut: 'Ctrl+Shift+D', error: null };
          if (['frontend_ready', 'report_boot_error', 'quit_app', 'hide_window', 'expand_window'].includes(command)) return;
          throw new Error(`Unexpected IPC command in startup test: ${command}`);
        },
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: (event: string, id: number) => { listeners.get(event)?.delete(id); callbacks.delete(id); } },
    });
  }, { storageFault, seed });
}

function faultyAppModule(mode: 'react-render' | 'react-effect'): string {
  const original = assets.get(appPath)!.toString('utf8');
  const effectNamespace = original.match(/([A-Za-z_$][\w$]*)\.useEffect\(/)?.[1];
  const exportedDefault = /export\{\s*[A-Za-z_$][\w$]*\s+as\s+default\s*\};?\s*$/;
  if (!exportedDefault.test(original) || (mode === 'react-effect' && !effectNamespace)) throw new Error('Unable to inject a test-only React boot fault into the production App chunk.');
  const body = mode === 'react-render' ? `throw new Error(${JSON.stringify(injectedError)});` : `${effectNamespace}.useEffect(()=>{throw new Error(${JSON.stringify(injectedError)})},[]);return null;`;
  return original.replace(exportedDefault, `function E2eBootFault(){${body}}export{E2eBootFault as default};`);
}

async function serveProduction(context: BrowserContext, initialFault: BootFault = 'none') {
  let fault = initialFault;
  const responses: ProductionResponse[] = [];
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== productionOrigin) { await route.abort('blockedbyclient'); return; }
    const path = decodeURIComponent(url.pathname.replace(/^\//, '')) || 'index.html';
    let body = assets.get(path);
    let contentType = extname(path) === '.js' ? 'text/javascript' : extname(path) === '.css' ? 'text/css' : path.endsWith('.html') ? 'text/html' : path.endsWith('.gz') ? 'application/gzip' : 'application/octet-stream';
    if (path === 'index.html') body = Buffer.from(fault === 'old-entry' ? productionHtml.replace('/' + entryPath, '/assets/index-previous-release.js') : productionHtml);
    if (path === appPath) {
      if (fault === 'app-import') body = Buffer.from(`throw new Error(${JSON.stringify(injectedError)});export default function(){return null;}`);
      if (fault === 'react-render' || fault === 'react-effect') body = Buffer.from(faultyAppModule(fault));
      if (fault === 'app-html') body = undefined;
    }
    if (!body) {
      // Tauri 2.12's get_asset falls back to index.html for a missing hash path,
      // returning status 200 and HTML MIME. A browser module must still fail safely.
      body = Buffer.from(productionHtml); contentType = 'text/html';
    }
    responses.push({ path, status: 200, contentType });
    await route.fulfill({ status: 200, body, headers: { 'Content-Type': contentType, 'Content-Security-Policy': productionCsp, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': productionOrigin } });
  });
  return { responses, clearFault: () => { fault = 'none'; } };
}

async function bootCalls(page: Page, command?: string): Promise<BootCall[]> {
  return page.evaluate(command => {
    const calls = (window as unknown as { e2eBoot: BootTestState }).e2eBoot.calls;
    return command ? calls.filter(call => call.command === command) : calls;
  }, command);
}

async function expectHealthyBoot(page: Page): Promise<void> {
  await expect(page.getByRole('textbox', { name: '待翻译文本' })).toBeVisible();
  await expect(page.locator('#fastdict-boot')).toBeHidden();
  await expect(page.locator('#fastdict-boot-error')).toBeHidden();
  await expect.poll(async () => (await bootCalls(page, 'frontend_ready')).length).toBeGreaterThan(0);
}

async function expectSafeDiagnostics(page: Page): Promise<void> {
  const diagnostics = await bootCalls(page, 'report_boot_error');
  expect(diagnostics.length).toBeGreaterThan(0);
  for (const call of diagnostics) {
    expect(Object.keys(call.args)).toEqual(['stage']);
    expect(stages.has(String(call.args.stage))).toBe(true);
    expect(JSON.stringify(call.args)).not.toContain(injectedError);
  }
}

async function expectRecovery(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: '应用界面未能启动', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '重新加载', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '退出应用', exact: true })).toBeVisible();
  await expect(page.locator('body')).not.toContainText(injectedError);
  await expectSafeDiagnostics(page);
}

test('boots production assets and CSP on the Windows Tauri origin without a dev server or startup writes', async ({ page, context }) => {
  await installEnvironment(page);
  const served = await serveProduction(context);
  await page.goto(productionOrigin);
  await expectHealthyBoot(page);
  await expect(page.getByRole('region', { name: '添加翻译服务引导' })).toBeVisible();
  await expect(page.locator('.provider-row')).toHaveCount(0);
  await expect(page.getByLabel('翻译服务', { exact: true })).toBeDisabled();
  expect(await bootCalls(page, 'get_api_key')).toEqual([]);
  expect(await bootCalls(page, 'set_desktop_preferences')).toEqual([]);
  expect(served.responses.some(response => response.path === appPath && response.contentType === 'text/javascript')).toBe(true);
  expect(await page.evaluate(() => (window as unknown as { e2eBoot: BootTestState }).e2eBoot.writes)).toEqual([]);
  await page.getByRole('button', { name: /^偏好设置/ }).click();
  await page.getByRole('button', { name: /^退出\s*FastLingo$/ }).click();
  await expect.poll(async () => (await bootCalls(page, 'quit_app')).length).toBe(1);
});

test('restores an existing normal profile without rewriting settings, providers or history bytes', async ({ page, context }) => {
  await installEnvironment(page, 'none', savedProfile);
  await serveProduction(context);
  await page.goto(productionOrigin);
  await expectHealthyBoot(page);
  await expect(page.getByLabel('源语言', { exact: true })).toHaveValue('en');
  await expect(page.getByLabel('目标语言', { exact: true })).toHaveValue('ja');
  await expect(page.getByRole('region', { name: '添加翻译服务引导' })).toHaveCount(0);
  await expect(page.locator('.provider-row')).toHaveCount(1);
  await expect(page.getByLabel('翻译服务', { exact: true })).toHaveValue('restored-local');
  const retained = await page.evaluate(keys => {
    const state = (window as unknown as { e2eBoot: BootTestState }).e2eBoot;
    return { values: Object.fromEntries(keys.map(key => [key, state.rawRead(key)])), writes: state.writes };
  }, Object.keys(savedProfile));
  expect(retained.values).toEqual(savedProfile); expect(retained.writes).toEqual([]);
  await page.getByRole('button', { name: /^翻译记录/ }).click();
  await expect(page.locator('.history-card')).toContainText('原有译文');
});

test('packaged OCR worker, WASM and language assets execute under production CSP without a delayed blank window', async ({ page, context }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await installEnvironment(page, 'none', savedProfile);
  const served = await serveProduction(context);
  await page.goto(productionOrigin);
  await expectHealthyBoot(page);
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 900; canvas.height = 220;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#000000'; context.font = '80px Arial'; context.fillText('Hello world', 40, 135);
    return canvas.toDataURL('image/png');
  });
  await page.locator('input[type="file"]').setInputFiles({ name: 'production-ocr.png', mimeType: 'image/png', buffer: Buffer.from(png.split(',')[1], 'base64') });
  await expect(page.getByRole('textbox', { name: '待翻译文本' })).toHaveValue(/hello world/i, { timeout: 60_000 });
  await expect(page.getByText(/识别置信度 \d+%/)).toBeVisible();
  await expect(page.locator('#fastdict-boot-error')).toBeHidden();
  expect(served.responses.some(response => response.path === 'ocr/worker.min.js')).toBe(true);
  expect(served.responses.some(response => /^ocr\/core\/tesseract-core-(?:simd-)?lstm\.wasm\.js$/.test(response.path))).toBe(true);
  expect(served.responses.some(response => response.path === 'ocr/lang/eng.traineddata.gz')).toBe(true);
  // The existing profile disables imported-image auto translation: this executes
  // real packaged OCR without substituting a provider or issuing a paid request.
  expect((await bootCalls(page)).some(call => call.command.startsWith('plugin:http|'))).toBe(false);
  expect(errors).toEqual([]);
});

test('denied localStorage access leaves a usable workspace and preserves the original profile', async ({ page, context }) => {
  await installEnvironment(page, 'getter-denied', savedProfile);
  await serveProduction(context);
  await page.goto(productionOrigin);
  await expectHealthyBoot(page);
  await expect(page.locator('.storage-warning')).toBeVisible();
  await page.getByRole('textbox', { name: '待翻译文本' }).fill('The workspace still accepts input.');
  await expect(page.getByRole('textbox', { name: '待翻译文本' })).toHaveValue('The workspace still accepts input.');
  await page.getByLabel('目标语言', { exact: true }).selectOption('fr');
  await expect(page.locator('#fastdict-boot-error')).toBeHidden();
  const raw = await page.evaluate(() => (window as unknown as { e2eBoot: BootTestState }).e2eBoot.rawRead('fastdict.v1.preferences'));
  expect(raw).toBe(savedProfile['fastdict.v1.preferences']);
  await expectSafeDiagnostics(page);
});

test('quota errors after changing preferences show a warning and keep both the UI and stored bytes intact', async ({ page, context }) => {
  await installEnvironment(page, 'quota', savedProfile);
  await serveProduction(context);
  await page.goto(productionOrigin);
  await expectHealthyBoot(page);
  expect(await page.evaluate(() => (window as unknown as { e2eBoot: BootTestState }).e2eBoot.writes)).toEqual([]);
  await page.getByLabel('目标语言', { exact: true }).selectOption('fr');
  await expect(page.locator('.storage-warning')).toContainText('原有数据已保留');
  await expect(page.getByLabel('目标语言', { exact: true })).toHaveValue('fr');
  await expect(page.locator('#fastdict-boot-error')).toBeHidden();
  expect(await page.evaluate(() => (window as unknown as { e2eBoot: BootTestState }).e2eBoot.rawRead('fastdict.v1.preferences'))).toBe(savedProfile['fastdict.v1.preferences']);
  await expectSafeDiagnostics(page);
});

test('unreadable saved metadata is never overwritten by fallback preferences', async ({ page, context }) => {
  const broken = '{unreadable-metadata-with-retained-data';
  await installEnvironment(page, 'none', { ...savedProfile, 'fastdict.v1.preferences': broken });
  await serveProduction(context);
  await page.goto(productionOrigin);
  await expectHealthyBoot(page);
  await expect(page.locator('.storage-warning')).toBeVisible();
  await page.getByLabel('目标语言', { exact: true }).selectOption('fr');
  await expect(page.locator('.storage-warning')).toContainText('原有数据已保留');
  expect(await page.evaluate(() => (window as unknown as { e2eBoot: BootTestState }).e2eBoot.rawRead('fastdict.v1.preferences'))).toBe(broken);
  expect(await page.evaluate(() => (window as unknown as { e2eBoot: BootTestState }).e2eBoot.writes)).toEqual([]);
});

test('a failed dynamic App import presents recovery and can reload cleanly without exposing exception text', async ({ page, context }) => {
  await installEnvironment(page);
  const served = await serveProduction(context, 'app-import');
  await page.goto(productionOrigin);
  await expectRecovery(page);
  expect((await bootCalls(page, 'report_boot_error')).some(call => call.args.stage === 'bootstrap-import-failed')).toBe(true);
  served.clearFault();
  await page.getByRole('button', { name: '重新加载', exact: true }).click();
  await expectHealthyBoot(page);
});

for (const fault of ['react-render', 'react-effect'] as const) {
  test(`${fault} exceptions cannot leave a white window or disable the direct native exit`, async ({ page, context }) => {
    await installEnvironment(page);
    await serveProduction(context, fault);
    await page.goto(productionOrigin);
    await expectRecovery(page);
    await page.getByRole('button', { name: '退出应用', exact: true }).click();
    await expect.poll(async () => (await bootCalls(page, 'quit_app')).length).toBe(1);
  });
}

test('a stale dynamic chunk receiving Tauri\'s 200 HTML fallback is recoverable and still has a native exit', async ({ page, context }) => {
  await installEnvironment(page);
  const served = await serveProduction(context, 'app-html');
  await page.goto(productionOrigin);
  await expectRecovery(page);
  expect(served.responses.some(response => response.path === appPath && response.status === 200 && response.contentType === 'text/html')).toBe(true);
  await page.getByRole('button', { name: '退出应用', exact: true }).click();
  await expect.poll(async () => (await bootCalls(page, 'quit_app')).length).toBe(1);
});

test('an obsolete entry hash cannot run React but the static HTML recovery shell can still quit', async ({ page, context }) => {
  await installEnvironment(page);
  const served = await serveProduction(context, 'old-entry');
  await page.goto(productionOrigin);
  await expectRecovery(page);
  expect(served.responses.some(response => response.path === 'assets/index-previous-release.js' && response.status === 200 && response.contentType === 'text/html')).toBe(true);
  expect(await bootCalls(page, 'frontend_ready')).toEqual([]);
  await page.getByRole('button', { name: '退出应用', exact: true }).click();
  await expect.poll(async () => (await bootCalls(page, 'quit_app')).length).toBe(1);
});
