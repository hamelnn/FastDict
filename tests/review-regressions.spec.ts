import { expect, test, type Page } from '@playwright/test';

async function settings(page: Page) {
  if ((page.viewportSize()?.width || 1120) < 680) await page.getByRole('button', { name: '打开菜单', exact: true }).click();
  await page.getByRole('button', { name: /^偏好设置/ }).click();
}

async function seedBrowser(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('fastdict.v1.providers', JSON.stringify([{ id: 'local-review', name: 'Review model', kind: 'openai', model: 'fixture', baseUrl: 'http://127.0.0.1:9/v1', hasKey: false }]));
    localStorage.setItem('fastdict.v1.preferences', JSON.stringify({ autoTranslate: true, activeProviderId: 'local-review', ocrLang: 'eng' }));
  });
}

async function png(page: Page) {
  return page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 960; canvas.height = 220;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#000'; context.font = '80px Arial'; context.fillText('Hello world', 40, 135);
    return canvas.toDataURL('image/png').split(',')[1];
  });
}

for (const stage of ['ocr', 'file', 'clipboard'] as const) {
  test(`disabling automatic translation during pending ${stage} prevents sending text`, async ({ page }) => {
    await seedBrowser(page);
    const outbound: string[] = [];
    await page.route('**/v1/chat/completions', async route => { outbound.push(route.request().url()); await route.abort(); });
    let releaseOcr!: () => void;
    let ocrWaiting = false;
    if (stage === 'ocr') {
      await page.route('**/ocr/lang/eng.traineddata.gz', async route => {
        ocrWaiting = true;
        await new Promise<void>(resolve => { releaseOcr = resolve; });
        await route.continue();
      });
    } else {
      await page.addInitScript(stage => {
        const state = { pending: false, release: () => undefined as void };
        Object.assign(window, { reviewInput: state });
        if (stage === 'clipboard') {
          Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: () => new Promise<string>(resolve => { state.pending = true; state.release = () => resolve('Hello world'); }) } });
        } else {
          const original = FileReader.prototype.readAsDataURL;
          FileReader.prototype.readAsDataURL = function (file: Blob) { state.pending = true; state.release = () => { original.call(this, file); }; };
        }
      }, stage);
    }
    await page.goto('/');
    if (stage === 'clipboard') await page.getByRole('button', { name: '粘贴文本', exact: true }).click();
    else await page.locator('input[type="file"]').setInputFiles({ name: 'review.png', mimeType: 'image/png', buffer: Buffer.from(await png(page), 'base64') });
    if (stage === 'ocr') await expect.poll(() => ocrWaiting).toBe(true);
    else await expect.poll(() => page.evaluate(() => (window as unknown as { reviewInput: { pending: boolean } }).reviewInput.pending)).toBe(true);
    await settings(page);
    const toggle = page.getByRole('switch', { name: '粘贴与导入后自动翻译', exact: true });
    await toggle.click(); await expect(toggle).toHaveAttribute('aria-checked', 'false');
    if (stage === 'ocr') releaseOcr();
    else await page.evaluate(() => (window as unknown as { reviewInput: { release: () => void } }).reviewInput.release());
    // Recognition may finish while settings remain open. It must not navigate or send.
    await page.getByRole('button', { name: /^即时翻译/ }).click();
    await expect(page.getByRole('textbox', { name: '待翻译文本' })).toHaveValue(/Hello world/i, { timeout: 60_000 });
    await expect(page.getByRole('button', { name: '翻译', exact: true })).toBeEnabled();
    expect(outbound).toEqual([]);
    expect(await page.evaluate(() => localStorage.getItem('fastdict.v1.history'))).toBeNull();
  });
}

test('old WebKit without randomUUID can add a service and save completed history', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(() => Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined }));
  await page.route('**/v1/chat/completions', route => route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n' }));
  await page.goto('/'); await settings(page);
  await page.getByRole('button', { name: '添加服务', exact: true }).click();
  await page.getByRole('button', { name: /本地 Ollama/ }).click();
  const editor = page.getByRole('dialog', { name: 'API 服务配置', exact: true });
  await editor.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(editor).toBeHidden();
  await page.getByRole('button', { name: /^即时翻译/ }).click();
  await page.getByRole('textbox', { name: '待翻译文本' }).fill('Hello');
  await page.getByRole('button', { name: '翻译', exact: true }).click();
  await expect(page.locator('.translation-output')).toHaveText('你好');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('fastdict.v1.history') || '[]').length)).toBe(1);
  const ids = await page.evaluate(() => [JSON.parse(localStorage.getItem('fastdict.v1.configuration')!).providers[0].id, JSON.parse(localStorage.getItem('fastdict.v1.history')!)[0].id]);
  expect(new Set(ids).size).toBe(2);
  for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(pageErrors).toEqual([]);
});

test('failed native credential/configuration commit keeps editor open and old endpoint/key after reload', async ({ page }) => {
  const vault = new Map([['review-existing', 'synthetic-old-key']]);
  await page.exposeFunction('reviewVault', async (command: string, args: { providerId: string; apiKey?: string }) => {
    if (command === 'save_api_key') { vault.set(args.providerId, args.apiKey!); return; }
    if (command === 'delete_api_key') { vault.delete(args.providerId); return; }
    return vault.get(args.providerId) ?? null;
  });
  await page.addInitScript(() => {
    if (!localStorage.getItem('fastdict.v1.providers')) {
      localStorage.setItem('fastdict.v1.providers', JSON.stringify([{ id: 'review-existing', name: 'Original service', kind: 'openai', model: 'fixture', baseUrl: 'https://old.example/v1', hasKey: true }]));
      localStorage.setItem('fastdict.v1.preferences', JSON.stringify({ autoTranslate: false, activeProviderId: 'review-existing' }));
    }
    const state = { fail: false };
    Object.assign(window, { reviewStorage: state });
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (state.fail) throw new DOMException('Synthetic quota failure', 'QuotaExceededError');
      setItem.call(this, key, value);
    };
    let nextId = 0;
    Object.assign(window, {
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
        transformCallback: () => ++nextId,
        unregisterCallback: () => undefined,
        invoke: async (command: string, args = {}) => {
          if (['save_api_key', 'get_api_key', 'delete_api_key'].includes(command)) return (window as unknown as { reviewVault: (command: string, args: unknown) => Promise<unknown> }).reviewVault(command, args);
          if (command === 'get_desktop_preferences') return { closeAction: 'quit', launchAtLogin: false, trayAvailable: true, autostartAvailable: true };
          if (command === 'get_shortcut_status') return { captureShortcut: 'Ctrl+Shift+S', clipboardShortcut: 'Ctrl+Shift+D', error: null };
          if (command === 'plugin:event|listen') return ++nextId;
          if (['plugin:event|unlisten', 'frontend_ready', 'report_boot_error'].includes(command)) return;
          throw new Error('Unexpected test command: ' + command);
        },
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => undefined },
    });
  });
  await page.goto('/'); await settings(page);
  await page.locator('.settings-provider').filter({ hasText: 'Original service' }).click();
  const editor = page.getByRole('dialog', { name: 'API 服务配置', exact: true });
  await editor.getByLabel(/^API 地址/).fill('https://new.example/v1');
  await editor.getByPlaceholder('输入新密钥以替换').fill('synthetic-new-key');
  await page.evaluate(() => { (window as unknown as { reviewStorage: { fail: boolean } }).reviewStorage.fail = true; });
  await editor.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(editor.getByRole('alert')).toContainText('原有数据已保留');
  await expect(editor).toBeVisible();
  expect([...vault.entries()]).toEqual([['review-existing', 'synthetic-old-key']]);
  await expect(page.getByRole('status').filter({ hasText: 'API 配置已保存' })).toHaveCount(0);
  await page.reload(); await settings(page);
  await page.locator('.settings-provider').filter({ hasText: 'Original service' }).click();
  await expect(editor.getByLabel(/^API 地址/)).toHaveValue('https://old.example/v1');
  expect([...vault.entries()]).toEqual([['review-existing', 'synthetic-old-key']]);
});
